import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveChoice, type ResolvedTarget } from "./agents";
import { caCertPath, clearMitmDir, ensureCa, opensslAvailable } from "./certs";
import {
  answerPlainRequest,
  attachMitm,
  connectTarget,
  handshakeNote,
  plainRequestPlan,
  spliceTunnel,
  terminatesTls,
} from "./mitm";
import { rejectUpgrade } from "./proxy";

const PORT = { port: 8787, platform: "linux" as NodeJS.Platform };

/** The catalogue's MITM target, which is what main() hands to attachMitm. */
function qoderSubscription(): ResolvedTarget {
  const result = resolveChoice({ agent: "qoder", provider: "subscription" }, PORT);
  if (result.kind !== "target") {
    throw new Error(`expected a target, got ${result.kind}`);
  }
  return result;
}

describe("connectTarget", () => {
  it("reads the ordinary host:port an agent CONNECTs to", () => {
    expect(connectTarget("b1731805-api.qoder.xin:443")).toEqual({
      host: "b1731805-api.qoder.xin",
      port: 443,
    });
  });

  it("defaults a bare host to 443, since that is the only port anything here listens on", () => {
    expect(connectTarget("api.qoder.xin")).toEqual({
      host: "api.qoder.xin",
      port: 443,
    });
  });

  it("accepts a port other than 443, so the caller can refuse it with a reason", () => {
    expect(connectTarget("api.qoder.xin:8443")).toEqual({
      host: "api.qoder.xin",
      port: 8443,
    });
  });

  it("unbrackets an IPv6 literal, which is mostly colons", () => {
    expect(connectTarget("[2001:db8::1]:443")).toEqual({
      host: "2001:db8::1",
      port: 443,
    });
  });

  it("unbrackets an IPv6 literal with no port too", () => {
    expect(connectTarget("[::1]")).toEqual({ host: "::1", port: 443 });
  });

  it("ignores whitespace around the authority", () => {
    expect(connectTarget("  api.qoder.xin:443  ")).toEqual({
      host: "api.qoder.xin",
      port: 443,
    });
  });

  it("returns null for an empty authority rather than guessing a host", () => {
    expect(connectTarget("")).toBeNull();
    expect(connectTarget("   ")).toBeNull();
  });

  it("returns null for an unbracketed IPv6 literal, which has no honest reading", () => {
    expect(connectTarget("::1:443")).toBeNull();
    expect(connectTarget("2001:db8::1")).toBeNull();
  });

  it("returns null when there is a port but no host", () => {
    expect(connectTarget(":443")).toBeNull();
  });

  it("returns null for a port that is not a port number", () => {
    expect(connectTarget("api.qoder.xin:https")).toBeNull();
    expect(connectTarget("api.qoder.xin:")).toBeNull();
    expect(connectTarget("api.qoder.xin:44.3")).toBeNull();
  });

  it("returns null for a port outside the range a socket can bind", () => {
    expect(connectTarget("api.qoder.xin:0")).toBeNull();
    expect(connectTarget("api.qoder.xin:65536")).toBeNull();
  });

  it("accepts the ends of the valid port range", () => {
    expect(connectTarget("api.qoder.xin:1")).toEqual({ host: "api.qoder.xin", port: 1 });
    expect(connectTarget("api.qoder.xin:65535")).toEqual({
      host: "api.qoder.xin",
      port: 65535,
    });
  });
});

/** Poll rather than sleep: socket ordering is not something a test should guess at. */
async function waitFor(test: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * A stand-in for the host an agent asked for. It answers, so a tunnel that
 * reaches it is distinguishable from one this proxy answered itself, and it
 * hangs up on a word the test chooses, so closing one direction is testable
 * too.
 */
async function echoServer(closeOn: string): Promise<{
  port: number;
  received: () => string;
  ended: () => boolean;
  close: () => Promise<void>;
}> {
  const sockets: net.Socket[] = [];
  const chunks: string[] = [];
  let ended = false;
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      chunks.push(chunk);
      socket.write(chunk);
      if (chunk.includes(closeOn)) socket.end();
    });
    socket.on("end", () => (ended = true));
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    received: () => chunks.join(""),
    ended: () => ended,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/**
 * A genuine pair of connected sockets over loopback: the end spliceTunnel is
 * given, and the end the test plays the agent from.
 *
 * Not a PassThrough, which looks like the same thing and is not. A PassThrough
 * hands back out of its readable end whatever was written to its writable one,
 * so the agent's own bytes come back as if the host had echoed them — and with
 * an echo server on the far end, they go round for ever.
 */
async function agentSocket(): Promise<{
  clientSocket: net.Socket;
  agent: net.Socket;
  close: () => void;
}> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const accepted = new Promise<net.Socket>((resolve) =>
    server.once("connection", resolve)
  );
  const agent = net.connect({
    host: "127.0.0.1",
    port: (server.address() as net.AddressInfo).port,
  });
  const clientSocket = await accepted;
  server.close();
  return {
    clientSocket,
    agent,
    close: () => {
      agent.destroy();
      clientSocket.destroy();
    },
  };
}

/** What the agent's end of a tunnel has been sent, and how it went away. */
function agentSide(agent: net.Socket): {
  text: () => string;
  ended: () => boolean;
  closed: () => boolean;
} {
  let out = "";
  let ended = false;
  let closed = false;
  agent.setEncoding("utf8");
  agent.on("data", (chunk: string) => (out += chunk));
  agent.on("end", () => (ended = true));
  agent.on("close", () => (closed = true));
  // A far end destroyed mid-tunnel arrives here as ECONNRESET, which is the
  // behaviour under test rather than a failure of it.
  agent.on("error", () => {});
  return { text: () => out, ended: () => ended, closed: () => closed };
}

describe("terminatesTls", () => {
  // The catalogue's own answer, for the one agent that has one.
  const qoder = qoderSubscription().mitmHosts;

  it("terminates every tunnel when the catalogue predicts no host", () => {
    // An agent whose inference host cannot be known in advance has to have all
    // of its tunnels decrypted, or nothing it says would ever be logged.
    expect(terminatesTls("anything.example.com", undefined)).toBe(true);
    expect(terminatesTls("", undefined)).toBe(true);
  });

  // Every host below is one qodercli itself named, in the `endpoint=` field of
  // its own run log, as where sendRemoteChatAsk went. Which of them a run
  // lands on is decided by the region election, and the bare `api<N>` shape is
  // the more common of the two — so a pattern covering only one of them makes
  // logging a coin flip, the run that lands elsewhere having its inference
  // tunnel spliced through unread and nothing written.
  it.each([
    "api1.qoder.sh",
    "api2.qoder.sh",
    "api3.qoder.sh",
    "api.qoder.xin",
    "b1731805-d1a6-41f6-9de4-52d8d015da84-api.qoder.xin",
  ])("terminates %s, which is where a Qoder model call lands", (host) => {
    expect(qoder).toBeInstanceOf(RegExp);
    expect(terminatesTls(host, qoder)).toBe(true);
  });

  it("terminates the same shape on an apex no run has been seen to elect", () => {
    // Invented, unlike the list above. The apex alternation is wider than the
    // hosts anyone has observed, and `com.cn` is the case that matters: the
    // apex itself holds a dot, which is easy to get wrong.
    expect(terminatesTls("tenant-api.qoder.com.cn", qoder)).toBe(true);
  });

  it.each([
    "center.qoder.sh",
    "b1731805-d1a6-41f6-9de4-52d8d015da84-center.qoder.xin",
    "openapi.qoder.sh",
    "b1731805-d1a6-41f6-9de4-52d8d015da84-openapi.qoder.xin",
    "download.qoder.com",
    "qoder-ide.oss-accelerate.aliyuncs.com",
    "mcp.context7.com",
    "registry.anpm.alibaba-inc.com",
  ])("passes %s through unread", (host) => {
    // None of these carries a model call. qodercli reaches them for the region
    // election, sign-in, feature gates, downloads, MCP servers and npm, on TLS
    // clients that do not all read NODE_EXTRA_CA_CERTS — so decrypting them
    // buys nothing and can break the call. The tenant-prefixed two and
    // `openapi` are the near-misses, each one label away from a host that does
    // carry it.
    expect(terminatesTls(host, qoder)).toBe(false);
  });

  it("is not talked into a host by one that merely contains the right words", () => {
    // Anchored, so a name this tool has no business decrypting cannot get in by
    // being wrapped around one that can. Invented on purpose, unlike the two
    // lists above.
    expect(terminatesTls("tenant-api.qoder.xin.evil.example", qoder)).toBe(false);
    expect(terminatesTls("evil-tenant-api.qoder.xin.attacker.test", qoder)).toBe(false);
    expect(terminatesTls("api3.qoder.sh.attacker.test", qoder)).toBe(false);
    expect(terminatesTls("notqoder.xin", qoder)).toBe(false);
  });
});

describe("spliceTunnel", () => {
  const ESTABLISHED = "HTTP/1.1 200 Connection Established\r\n\r\n";

  it("announces the tunnel, then joins the two sockets", async () => {
    const echo = await echoServer("\u0000never");
    const { clientSocket, agent, close } = await agentSocket();
    const seen = agentSide(agent);
    try {
      spliceTunnel(
        clientSocket,
        net.connect({ host: "127.0.0.1", port: echo.port }),
        null,
        "center.qoder.sh"
      );
      agent.write("ping");
      await waitFor(() => seen.text().includes("ping"), "the host's answer");
      // The 200 comes first, because that is what tells the agent it may start
      // its handshake, and what follows is the host's own echo rather than
      // anything this proxy composed.
      expect(seen.text()).toBe(ESTABLISHED + "ping");
      expect(echo.received()).toBe("ping");
    } finally {
      close();
      await echo.close();
    }
  });

  it("gives the bytes the agent pipelined behind its CONNECT to the host", async () => {
    // Those bytes are the start of a TLS handshake this proxy will never see.
    // Keeping them here, or dropping them, leaves the host waiting on a
    // ClientHello that never arrives.
    const echo = await echoServer("\u0000never");
    const { clientSocket, agent, close } = await agentSocket();
    const seen = agentSide(agent);
    try {
      spliceTunnel(
        clientSocket,
        net.connect({ host: "127.0.0.1", port: echo.port }),
        Buffer.from("EARLY"),
        "center.qoder.sh"
      );
      await waitFor(() => echo.received().includes("EARLY"), "the pipelined bytes");
      expect(echo.received()).toBe("EARLY");
      await waitFor(() => seen.text().includes("EARLY"), "the host's answer");
      expect(seen.text()).toBe(ESTABLISHED + "EARLY");
    } finally {
      close();
      await echo.close();
    }
  });

  it("announces nothing when the host cannot be reached", async () => {
    // A 200 followed by a dead socket reads to the agent like the host hung up
    // mid-handshake, with nothing pointing back at this proxy. Refusing to
    // announce it is what leaves the failure honest.
    const { clientSocket, agent, close } = await agentSocket();
    const seen = agentSide(agent);
    try {
      spliceTunnel(
        clientSocket,
        net.connect({ host: "127.0.0.1", port: 1 }),
        null,
        "center.qoder.sh"
      );
      await waitFor(() => seen.closed(), "the agent's socket to be closed");
      expect(seen.text()).toBe("");
    } finally {
      close();
    }
  });

  it("hangs the agent up when the host does", async () => {
    const echo = await echoServer("BYE");
    const { clientSocket, agent, close } = await agentSocket();
    const seen = agentSide(agent);
    try {
      spliceTunnel(
        clientSocket,
        net.connect({ host: "127.0.0.1", port: echo.port }),
        null,
        "center.qoder.sh"
      );
      agent.write("BYE");
      await waitFor(() => seen.ended(), "the agent's side to end");
      expect(seen.text()).toBe(ESTABLISHED + "BYE");
    } finally {
      close();
      await echo.close();
    }
  });

  it("hangs the host up when the agent does", async () => {
    const echo = await echoServer("\u0000never");
    const { clientSocket, agent, close } = await agentSocket();
    try {
      spliceTunnel(
        clientSocket,
        net.connect({ host: "127.0.0.1", port: echo.port }),
        null,
        "center.qoder.sh"
      );
      agent.write("done");
      await waitFor(() => echo.received().includes("done"), "the bytes to arrive");
      agent.end();
      await waitFor(() => echo.ended(), "the host to see the agent go");
      expect(echo.received()).toBe("done");
    } finally {
      close();
      await echo.close();
    }
  });
});

// Everything below runs the real openssl and the real TLS stack, through the
// certificate directory attachMitm actually uses. That is the production path:
// giving attachMitm a directory parameter so the tests could mint somewhere
// else would let them pass while the wiring they exist to prove went untested.
describe.skipIf(!opensslAvailable())("attachMitm", () => {
  // Whether this file minted the CA, and so whether it may delete it.
  //
  // A proxy can be running while these tests do: minting over its CA breaks
  // the agent it was started for, which trusts the CA it was handed and not
  // this one, and deleting ca.key leaves that proxy unable to mint a leaf for
  // any host it has not seen. So an existing CA is reused, and only one this
  // file created is cleared on the way out.
  let mintedHere = false;

  beforeAll(() => {
    mintedHere = !fs.existsSync(caCertPath());
    if (mintedHere) {
      // Start from nothing: a run killed in a way no exit handler saw can
      // leave key material behind that these tests would otherwise sign with.
      clearMitmDir();
      ensureCa();
    }
  });
  afterAll(() => {
    if (mintedHere) clearMitmDir();
  });

  /** One request the handler saw, as much of it as the tests assert on. */
  interface Seen {
    method: string;
    url: string;
    authorization: string | undefined;
    body: string;
    target: ResolvedTarget;
  }

  /**
   * A stand-in for proxy.ts's handle: read the request, remember it, reply and
   * close. Closing is what lets the client know the response is complete.
   */
  function recordingHandler(seen: Seen[], reply = "recorded") {
    return (req: http.IncomingMessage, res: http.ServerResponse, target: ResolvedTarget) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seen.push({
          method: req.method ?? "",
          url: req.url ?? "",
          authorization: req.headers.authorization,
          body: Buffer.concat(chunks).toString("utf8"),
          target,
        });
        res.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          connection: "close",
        });
        res.end(reply);
      });
    };
  }

  /** A proxy wired the way main() wires a MITM run. */
  async function startProxy(
    seen: Seen[],
    dial?: (host: string, port: number) => net.Socket
  ): Promise<{
    port: number;
    close: () => Promise<void>;
  }> {
    const server = http.createServer(answerPlainRequest);
    server.on("upgrade", rejectUpgrade);
    attachMitm(server, qoderSubscription(), {
      onRequest: recordingHandler(seen),
      onUpgrade: rejectUpgrade,
      dial,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
      port: (server.address() as net.AddressInfo).port,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  const INFERENCE_PATH =
    "/algo/api/v2/service/pro/sse/agent_chat_generation" +
    "?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";

  /**
   * Play the agent: CONNECT, then a TLS handshake against the leaf this tool
   * minted, then one HTTP request inside the tunnel.
   */
  function tunnelRequest(options: {
    port: number;
    authority: string;
    servername: string;
    request: string;
  }): Promise<{ connectResponse: string; response: string }> {
    const ca = fs.readFileSync(caCertPath());
    return new Promise((resolve, reject) => {
      const socket = net.connect(options.port, "127.0.0.1");
      const timer = setTimeout(
        () => reject(new Error(`tunnel to ${options.authority} did not finish within 15s`)),
        15000
      );
      const finish = (connectResponse: string, response: string) => {
        clearTimeout(timer);
        resolve({ connectResponse, response });
      };

      let pending = Buffer.alloc(0);
      socket.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.on("connect", () => {
        socket.write(
          `CONNECT ${options.authority} HTTP/1.1\r\nHost: ${options.authority}\r\n\r\n`
        );
      });
      socket.on("data", (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        const boundary = pending.indexOf("\r\n\r\n");
        if (boundary === -1) return;

        const connectResponse = pending.subarray(0, boundary + 4).toString("utf8");
        socket.removeAllListeners("data");
        if (!connectResponse.startsWith("HTTP/1.1 200")) {
          // Refused: no tunnel was established, so there is nothing to say
          // inside one.
          socket.destroy();
          finish(connectResponse, "");
          return;
        }

        // Anything the proxy pipelined behind its own 200 belongs to the TLS
        // handshake, not to this parser.
        const rest = pending.subarray(boundary + 4);
        pending = Buffer.alloc(0);
        if (rest.length > 0) socket.unshift(rest);

        let response = "";
        const secure = tls.connect(
          { socket, ca, servername: options.servername },
          () => secure.write(options.request)
        );
        secure.setEncoding("utf8");
        secure.on("data", (text: string) => (response += text));
        secure.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        secure.on("close", () => finish(connectResponse, response));
      });
    });
  }

  /** An origin-form HTTP/1.1 request, as an agent writes it inside a tunnel. */
  function rawRequest(host: string, path: string, body: string, headers: string[] = []): string {
    return [
      `POST ${path} HTTP/1.1`,
      `Host: ${host}`,
      "content-type: text/plain; charset=utf-8",
      `content-length: ${Buffer.byteLength(body)}`,
      ...headers,
      "",
      body,
    ].join("\r\n");
  }

  /**
   * Play the agent against a tunnel this proxy does not decrypt: CONNECT, read
   * the 200, then write and read plain bytes. There is no TLS in the middle to
   * speak through, which is the whole point of the tunnel being spliced.
   */
  function plainTunnel(options: {
    port: number;
    authority: string;
    payload: string;
  }): Promise<{ connectResponse: string; response: string }> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(options.port, "127.0.0.1");
      const timer = setTimeout(
        () => reject(new Error(`tunnel to ${options.authority} did not finish within 15s`)),
        15000
      );
      let pending = Buffer.alloc(0);
      let connectResponse = "";
      let response = "";
      let tunnelled = false;

      socket.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.on("connect", () => {
        socket.write(
          `CONNECT ${options.authority} HTTP/1.1\r\nHost: ${options.authority}\r\n\r\n`
        );
      });
      socket.on("data", (chunk: Buffer) => {
        if (tunnelled) {
          response += chunk.toString("utf8");
          return;
        }
        pending = Buffer.concat([pending, chunk]);
        const boundary = pending.indexOf("\r\n\r\n");
        if (boundary === -1) return;

        connectResponse = pending.subarray(0, boundary + 4).toString("utf8");
        tunnelled = true;
        if (connectResponse.startsWith("HTTP/1.1 200")) {
          response += pending.subarray(boundary + 4).toString("utf8");
          socket.write(options.payload);
        } else {
          socket.destroy();
        }
      });
      socket.on("close", () => {
        clearTimeout(timer);
        resolve({ connectResponse, response });
      });
    });
  }

  it("establishes a tunnel whose certificate a client trusts from the CA alone", async () => {
    const seen: Seen[] = [];
    const proxy = await startProxy(seen);
    try {
      const { connectResponse, response } = await tunnelRequest({
        port: proxy.port,
        authority: "tenant-a-api.qoder.xin:443",
        servername: "tenant-a-api.qoder.xin",
        request: rawRequest("tenant-a-api.qoder.xin", INFERENCE_PATH, "hello"),
      });
      expect(connectResponse).toContain("200 Connection Established");
      expect(response).toContain("HTTP/1.1 200");
      expect(response).toContain("recorded");
    } finally {
      await proxy.close();
    }
  });

  it("hands the handler a target naming the host this connection asked for", async () => {
    const seen: Seen[] = [];
    const dialed: Array<[string, number]> = [];
    const proxy = await startProxy(seen, (host, port) => {
      dialed.push([host, port]);
      return net.connect({ host: "127.0.0.1", port: 1 });
    });
    try {
      await tunnelRequest({
        port: proxy.port,
        authority: "tenant-a-api.qoder.xin:443",
        servername: "tenant-a-api.qoder.xin",
        request: rawRequest("tenant-a-api.qoder.xin", INFERENCE_PATH, "hello", [
          "authorization: Bearer not-a-real-token",
        ]),
      });
      expect(seen).toHaveLength(1);
      const call = seen[0]!;
      // The point of the whole mode: the host is not in the catalogue, it is
      // whatever the agent named.
      expect(call.target.upstreamHost).toBe("tenant-a-api.qoder.xin");
      // Everything else is the catalogue's, untouched.
      expect(call.target.renderer).toBe("qoder");
      expect(call.target.agentLabel).toBe("Qoder");
      expect(call.target.mitm).toBe(true);
      // And the request itself survives the second TLS hop intact, which is
      // what makes shouldLogRequest and the decoder downstream able to work.
      expect(call.method).toBe("POST");
      expect(call.url).toBe(INFERENCE_PATH);
      expect(call.authorization).toBe("Bearer not-a-real-token");
      expect(call.body).toBe("hello");
      // This host is one the catalogue says a model call can be on, so it was
      // decrypted rather than spliced: no socket was opened to it behind the
      // agent's back, and the reply came from the handler.
      expect(dialed).toEqual([]);
    } finally {
      await proxy.close();
    }
  });

  it("keeps two tunnels apart in one process, and never writes to the shared target", async () => {
    const seen: Seen[] = [];
    const shared = qoderSubscription();
    const server = http.createServer(answerPlainRequest);
    server.on("upgrade", rejectUpgrade);
    attachMitm(server, shared, {
      onRequest: recordingHandler(seen),
      onUpgrade: rejectUpgrade,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;

    try {
      // Two inference hosts in one run: the tenant prefix differs per account
      // and the region lookup can elect a different apex, so neither is fixed
      // for the life of the process. This is the case the catalogue's
      // one-host-per-process invariant was never built for.
      const [first, second] = await Promise.all([
        tunnelRequest({
          port,
          authority: "tenant-a-api.qoder.xin:443",
          servername: "tenant-a-api.qoder.xin",
          request: rawRequest("tenant-a-api.qoder.xin", INFERENCE_PATH, "first"),
        }),
        tunnelRequest({
          port,
          authority: "tenant-b-api.qoder.xin:443",
          servername: "tenant-b-api.qoder.xin",
          request: rawRequest("tenant-b-api.qoder.xin", INFERENCE_PATH, "second"),
        }),
      ]);
      expect(first.response).toContain("recorded");
      expect(second.response).toContain("recorded");

      const hosts = seen.map((call) => call.target.upstreamHost).sort();
      expect(hosts).toEqual(["tenant-a-api.qoder.xin", "tenant-b-api.qoder.xin"]);
      const bodies = Object.fromEntries(seen.map((c) => [c.body, c.target.upstreamHost]));
      expect(bodies).toEqual({
        first: "tenant-a-api.qoder.xin",
        second: "tenant-b-api.qoder.xin",
      });
      // Assigning instead of cloning would pass every assertion above and
      // still be wrong: the second tunnel would retroactively rename the
      // first one's captures.
      expect(shared.upstreamHost).toBe("");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("delivers a body far larger than one socket write, byte for byte", async () => {
    // A real Qoder request carries the whole system prompt and every tool
    // definition, encoded. That is hundreds of kilobytes, arriving over many
    // TLS records, so a handler that stopped at the first chunk would look
    // correct on a toy body and truncate every real one.
    const body = "qoder-body\n".repeat(30_000) + "TAIL";
    const seen: Seen[] = [];
    const proxy = await startProxy(seen);
    try {
      await tunnelRequest({
        port: proxy.port,
        authority: "tenant-a-api.qoder.xin:443",
        servername: "tenant-a-api.qoder.xin",
        request: rawRequest("tenant-a-api.qoder.xin", INFERENCE_PATH, body),
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.body).toBe(body);
      expect(seen[0]!.body.endsWith("TAIL")).toBe(true);
    } finally {
      await proxy.close();
    }
  });

  it("refuses a CONNECT for a port other than 443 instead of dialling 443 anyway", async () => {
    const seen: Seen[] = [];
    const proxy = await startProxy(seen);
    try {
      const { connectResponse, response } = await tunnelRequest({
        port: proxy.port,
        authority: "tenant-a-api.qoder.xin:8443",
        servername: "tenant-a-api.qoder.xin",
        request: rawRequest("tenant-a-api.qoder.xin", INFERENCE_PATH, "hello"),
      });
      expect(connectResponse).toContain("HTTP/1.1 502");
      expect(response).toBe("");
      expect(seen).toEqual([]);
    } finally {
      await proxy.close();
    }
  });

  it("joins a host the catalogue does not name straight to itself, and reads nothing", async () => {
    // qodercli reaches a dozen hosts that cannot hold a model call, and holds
    // more than one TLS client — not all of which read NODE_EXTRA_CA_CERTS. A
    // tunnel this proxy terminates for one of those clients is a tunnel that
    // fails, so the ones that cannot be inference are left alone.
    const seen: Seen[] = [];
    const dialed: Array<[string, number]> = [];
    const host = await echoServer("BYE");
    const server = http.createServer(answerPlainRequest);
    server.on("upgrade", rejectUpgrade);
    attachMitm(server, qoderSubscription(), {
      onRequest: recordingHandler(seen),
      onUpgrade: rejectUpgrade,
      // The CONNECT still names the real host. Only the socket behind it goes
      // somewhere a test can listen, which is the same substitution the real
      // run makes in the other direction.
      dial: (name, port) => {
        dialed.push([name, port]);
        return net.connect({ host: "127.0.0.1", port: host.port });
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const { connectResponse, response } = await plainTunnel({
        port,
        authority: "center.qoder.sh:443",
        payload: "agent_chat_generation BYE",
      });
      expect(connectResponse).toContain("200 Connection Established");
      expect(dialed).toEqual([["center.qoder.sh", 443]]);
      // The host answered, not this tool: the handler would have said
      // "recorded", and the payload came back as the host's own echo — even
      // though it names the inference path, which is what shouldLogRequest
      // would have keyed on had it ever been parsed.
      expect(response).toContain("agent_chat_generation BYE");
      expect(response).not.toContain("recorded");
      expect(seen).toEqual([]);
    } finally {
      await host.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("refuses a port other than 443 on a tunnel it would otherwise have passed through", async () => {
    // The port rule is about what this tool is willing to be, not about what it
    // can read, so it applies before the decision to decrypt is reached.
    // Honouring an arbitrary port would make it a general TCP forwarder.
    const seen: Seen[] = [];
    const dialed: Array<[string, number]> = [];
    const proxy = await startProxy(seen, (host, port) => {
      dialed.push([host, port]);
      return net.connect({ host: "127.0.0.1", port: 1 });
    });
    try {
      const { connectResponse, response } = await plainTunnel({
        port: proxy.port,
        authority: "center.qoder.sh:8443",
        payload: "hello BYE",
      });
      expect(connectResponse).toContain("HTTP/1.1 502");
      expect(response).toBe("");
      expect(dialed).toEqual([]);
      expect(seen).toEqual([]);
    } finally {
      await proxy.close();
    }
  });

  // An authority connectTarget cannot parse is refused through the same
  // refuseTunnel call as the port above, so the wire behaviour is covered
  // there; the parse table itself is the unit tests at the top of this file.
});

// A MITM run also receives plain HTTP requests that are not a mistake.
// qodercli's Aliyun HTTPDNS client sends its resolver calls as absolute-form
// requests rather than as CONNECT, and refusing them made it retry four rounds
// of seven resolvers before falling back to the system resolver. The rule for
// what gets forwarded is the unit table here; the wire behaviour is below it.
describe("plainRequestPlan", () => {
  // What a request from this machine arrives as: IPv4-mapped over a socket
  // bound to 127.0.0.1, which is the shape every live run has produced.
  const LOCAL = "::ffff:127.0.0.1";

  it("reads the request qodercli's HTTPDNS client actually sends", () => {
    expect(
      plainRequestPlan("https://203.107.1.1/183012/ss?region=global", LOCAL)
    ).toEqual({
      kind: "forward",
      hostname: "203.107.1.1",
      host: "203.107.1.1",
      port: 443,
      path: "/183012/ss?region=global",
      useHttps: true,
    });
  });

  it("keeps the query string, which is the whole request", () => {
    // A HTTPDNS lookup carries the region in the query and nothing in the
    // body, so dropping it would forward a question with no subject.
    const plan = plainRequestPlan(
      "https://203.107.1.1/183012/ss?a=1&b=2",
      LOCAL
    );
    expect(plan).toMatchObject({ path: "/183012/ss?a=1&b=2" });
  });

  it("fills in the port a request leaves out, per scheme", () => {
    expect(plainRequestPlan("https://host.test/x", LOCAL)).toMatchObject({
      port: 443,
      useHttps: true,
    });
    expect(plainRequestPlan("http://host.test/x", LOCAL)).toMatchObject({
      port: 80,
      useHttps: false,
    });
  });

  it("honours a port the request does name, and keeps it in the Host header", () => {
    // Nothing in the catalogue is off 443, but this path is not the catalogue:
    // it dials the destination itself, so it can afford to be accurate.
    expect(plainRequestPlan("http://127.0.0.1:11434/api/tags", LOCAL)).toEqual({
      kind: "forward",
      hostname: "127.0.0.1",
      host: "127.0.0.1:11434",
      port: 11434,
      path: "/api/tags",
      useHttps: false,
    });
  });

  it("unbrackets an IPv6 destination, which is mostly colons", () => {
    expect(plainRequestPlan("http://[::1]:8080/x", LOCAL)).toMatchObject({
      hostname: "::1",
      host: "[::1]:8080",
      port: 8080,
    });
  });

  it.each(["127.0.0.1", "127.9.9.9", "::1", "::ffff:127.0.0.1"])(
    "accepts %s as this machine",
    (address) => {
      expect(plainRequestPlan("https://203.107.1.1/x", address).kind).toBe(
        "forward"
      );
    }
  );

  it.each(["::ffff:192.168.1.50", "203.0.113.7", "2001:db8::1", undefined])(
    "refuses a request from %s, which is not this machine",
    (address) => {
      const plan = plainRequestPlan("https://203.107.1.1/x", address);
      expect(plan.kind).toBe("refuse");
      // The reason has to be the real one. This proxy listens on every
      // interface, so forwarding for anyone would make it an open proxy — a
      // message about CONNECT would send a reader after the wrong fix.
      if (plan.kind === "refuse") {
        expect(plan.reply).toContain("open proxy");
        expect(plan.reply).toContain("every network interface");
      }
    }
  );

  it("leaves an origin-form request to the base-URL mistake it always was", () => {
    // The case this whole path was originally written for, unchanged: a path
    // names no destination, so there is nothing to forward it to.
    expect(plainRequestPlan("/v1/messages", LOCAL)).toEqual({ kind: "origin" });
    expect(plainRequestPlan("", LOCAL)).toEqual({ kind: "origin" });
  });

  it("refuses a scheme it does not speak", () => {
    const plan = plainRequestPlan("ftp://host.test/x", LOCAL);
    expect(plan.kind).toBe("refuse");
    if (plan.kind === "refuse") expect(plan.reply).toContain("ftp:");
  });

  it("refuses a request-target that names no destination it can parse", () => {
    expect(plainRequestPlan("https://", LOCAL).kind).toBe("refuse");
    expect(plainRequestPlan("not a url", LOCAL).kind).toBe("refuse");
  });
});

describe("answerPlainRequest", () => {
  /** One plain HTTP request to a proxy port, and what came back. */
  function send(options: {
    port: number;
    target: string;
    method?: string;
    body?: string;
    headers?: http.OutgoingHttpHeaders;
  }): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: options.port,
          // Node writes this verbatim as the request-target, so an absolute
          // URL here is what makes the request absolute-form on the wire.
          path: options.target,
          method: options.method ?? "GET",
          headers: options.headers,
        },
        (res) => {
          let out = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (out += chunk));
          res.on("end", () =>
            resolve({ statusCode: res.statusCode ?? 0, body: out })
          );
        }
      );
      req.on("error", reject);
      req.end(options.body ?? "");
    });
  }

  /** A stand-in for the host an absolute-form request names. */
  async function destination(reply: string): Promise<{
    port: number;
    seen: { method: string; url: string; host: string; forwarded: string }[];
    close: () => Promise<void>;
  }> {
    const seen: {
      method: string;
      url: string;
      host: string;
      forwarded: string;
    }[] = [];
    const server = http.createServer((req, res) => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        host: String(req.headers.host ?? ""),
        forwarded: String(req.headers["proxy-connection"] ?? ""),
      });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(reply)),
      });
      res.end(reply);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
      port: (server.address() as net.AddressInfo).port,
      seen,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  /** A proxy in MITM mode, as main() builds one. */
  async function proxyPort(): Promise<{
    port: number;
    close: () => Promise<void>;
  }> {
    const server = http.createServer(answerPlainRequest);
    server.on("upgrade", rejectUpgrade);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
      port: (server.address() as net.AddressInfo).port,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it("answers an origin-form request with 400 and names the mistake", async () => {
    // The failure this exists for: the student pointed their agent at a base
    // URL instead of HTTPS_PROXY, so the request arrives where there is no
    // upstream host to forward it to. A DNS error would say nothing about that.
    const proxy = await proxyPort();
    try {
      const { statusCode, body } = await send({
        port: proxy.port,
        target: "/v1/messages",
        method: "POST",
        body: "{}",
      });

      expect(statusCode).toBe(400);
      expect(body).toContain("man-in-the-middle");
      expect(body).toContain("HTTPS_PROXY");
      expect(body).toContain("--force");
      // It now also has to say what would have worked, since an absolute-form
      // plain request is no longer refused out of hand.
      expect(body).toContain("CONNECT");
    } finally {
      await proxy.close();
    }
  });

  it("forwards an absolute-form request to the host it names, and brings the reply back", async () => {
    const dest = await destination('{"service_ip":["1.2.3.4"]}');
    const proxy = await proxyPort();
    try {
      const { statusCode, body } = await send({
        port: proxy.port,
        target: `http://127.0.0.1:${dest.port}/183012/ss?region=global`,
      });

      expect(statusCode).toBe(200);
      expect(body).toBe('{"service_ip":["1.2.3.4"]}');
      expect(dest.seen).toHaveLength(1);
      expect(dest.seen[0]!.method).toBe("GET");
      expect(dest.seen[0]!.url).toBe("/183012/ss?region=global");
      // The client's own Host named this proxy, because that is where it
      // connected. What the destination has to see is itself.
      expect(dest.seen[0]!.host).toBe(`127.0.0.1:${dest.port}`);
    } finally {
      await proxy.close();
      await dest.close();
    }
  });

  it("does not pass on a hop-by-hop header, which belongs to the proxy alone", async () => {
    const dest = await destination("ok");
    const proxy = await proxyPort();
    try {
      await send({
        port: proxy.port,
        target: `http://127.0.0.1:${dest.port}/x`,
        headers: { "proxy-connection": "keep-alive", connection: "close" },
      });
      expect(dest.seen).toHaveLength(1);
      expect(dest.seen[0]!.forwarded).toBe("");
      expect(dest.seen[0]!.host).toBe(`127.0.0.1:${dest.port}`);
    } finally {
      await proxy.close();
      await dest.close();
    }
  });

  it("carries a body through, since a resolver call is not the only shape this can take", async () => {
    const bodies: string[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        bodies.push(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "content-length": "2" }).end("ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const destPort = (server.address() as net.AddressInfo).port;
    const proxy = await proxyPort();
    try {
      const { statusCode } = await send({
        port: proxy.port,
        target: `http://127.0.0.1:${destPort}/x`,
        method: "POST",
        body: "question",
      });
      expect(statusCode).toBe(200);
      expect(bodies).toEqual(["question"]);
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports an unreachable destination as 502 instead of leaving the agent hanging", async () => {
    // Port 1 on loopback refuses immediately. Without a handler on the
    // upstream error the client socket would just go quiet, which reads to an
    // agent as a network that is slow rather than one that said no.
    const proxy = await proxyPort();
    try {
      const { statusCode, body } = await send({
        port: proxy.port,
        target: "http://127.0.0.1:1/x",
      });
      expect(statusCode).toBe(502);
      expect(body).toContain("127.0.0.1:1");
    } finally {
      await proxy.close();
    }
  });

  // A refusal for a client that is not on this machine goes through the same
  // 400 path as the origin-form case above, and the address it names comes
  // from a socket no test can choose; the decision itself is the unit table in
  // plainRequestPlan.
});

describe("handshakeNote", () => {
  it("explains a certificate failure, and says what would actually prove it", () => {
    const note = handshakeNote("unable to verify the first certificate");
    expect(note).toContain("NODE_EXTRA_CA_CERTS");
    expect(note).toMatch(/every tunnel/);
  });

  it.each([
    "self-signed certificate in certificate chain",
    "sslv3 alert handshake failure",
    "tlsv1 alert unknown ca",
    "unable to get local issuer certificate",
  ])("recognises %s as a trust failure", (message) => {
    expect(handshakeNote(message)).not.toBe("");
  });

  it("stays quiet about an agent that simply hung up", () => {
    // A live run produced these on tunnels qodercli closed without finishing a
    // handshake, while the one that mattered went through fine. A certificate
    // hint next to them sends a student after a configuration that is correct.
    expect(handshakeNote("read ECONNRESET")).toBe("");
    expect(handshakeNote("socket hang up")).toBe("");
    expect(handshakeNote("write EPIPE")).toBe("");
  });
});
