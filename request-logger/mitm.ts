/**
 * mitm.ts — the CONNECT half of the proxy, for the one agent that picks its
 * own upstream host.
 *
 * Everything else in this tool is a reverse proxy: the student is given a base
 * URL, their agent calls it, and the one host on the other side is known before
 * the first request arrives. Qoder's subscription route cannot work that way.
 * It elects its own server at runtime — a region lookup plus Aliyun HTTPDNS —
 * and offers no override, so the only way to stand between the two is to be the
 * proxy its HTTPS_PROXY names and to answer the CONNECT that then arrives.
 *
 * That makes this a man-in-the-middle rather than a reverse proxy, and the
 * difference is not cosmetic: to read a request this has to end the agent's TLS
 * connection and open a second one upstream, which needs a certificate the
 * agent will trust. certs.ts mints one per host as each connection opens, and
 * the command the banner prints trusts it through NODE_EXTRA_CA_CERTS — for
 * that one process only, never system-wide. See the Qoder warnings in
 * agents.ts, which are what the student actually reads about this.
 *
 * Not every tunnel that arrives is decrypted, though. An agent pointed here by
 * HTTPS_PROXY sends every host it talks to, and qodercli holds more than one
 * TLS client — not all of which read that variable, so a tunnel ended for one
 * of those simply fails. The catalogue therefore names the hosts a model call
 * can be on (ResolvedTarget.mitmHosts), and a CONNECT for any other host is
 * spliced straight through instead: two pipes and nothing read, which the
 * agent cannot tell apart from never having been proxied at all.
 *
 * Nor does all of that traffic arrive as a tunnel. qodercli resolves some of
 * its hosts through Aliyun HTTPDNS, whose client sends the resolver call as an
 * absolute-form plain HTTP request instead of a CONNECT — `GET
 * https://203.107.1.1/183012/ss?region=global`, scheme and all, with no
 * tunnel around it. That is a request naming its own destination, so it can be
 * forwarded, and refusing it instead cost four rounds of seven resolvers per
 * run before qodercli gave up and used the system one. It is forwarded unread,
 * for a client on this machine only: this proxy listens on every interface, so
 * forwarding for anyone else would make it an open proxy.
 *
 * The invariant "one process, one upstream host" is preserved rather than
 * abandoned. Each connection clones the target with its own host filled in, so
 * every reader downstream — handle, writeCapture, the burst guard, the
 * renderer — still sees a target with exactly one host, and none of them knows
 * this file exists.
 */

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { styleText } from "node:util";
import type { Duplex } from "node:stream";
import type { ResolvedTarget } from "./agents";
import { certForHost } from "./certs";

const dim = (text: string) => styleText("dim", text);

/**
 * Every provider in the catalogue is a public HTTPS API on 443, and
 * upstreamConnection in proxy.ts says so unconditionally for a ResolvedTarget.
 * A CONNECT for any other port therefore has nowhere correct to go, and is
 * refused rather than quietly sent to 443.
 */
const UPSTREAM_PORT = 443;

/**
 * What a tunnel does, and how it reaches the far end.
 *
 * Injected rather than imported from proxy.ts, which would otherwise import
 * this file and be imported by it. `onRequest` is proxy.ts's own handle, given
 * the per-connection target; `onUpgrade` is its rejectUpgrade, reused verbatim
 * because an agent that probes for a WebSocket inside a tunnel deserves the
 * same immediate 426 one gets outside it.
 *
 * `dial` opens the upstream socket for a tunnel that is spliced rather than
 * decrypted. It defaults to a real connection to the host the agent named; a
 * test hands in one to a local server instead, so the CONNECT authority can
 * stay a real name while the socket behind it goes somewhere listenable.
 */
export interface TunnelHandlers {
  onRequest: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    target: ResolvedTarget
  ) => void;
  onUpgrade: (req: http.IncomingMessage, socket: Duplex) => void;
  dial?: (host: string, port: number) => net.Socket;
}

const dialUpstream = (host: string, port: number): net.Socket =>
  net.connect({ host, port });

/**
 * Split a CONNECT authority into a host and a port.
 *
 * The authority is `req.url` on a CONNECT, and comes in three shapes: a name
 * with a port, a name without one, and a bracketed IPv6 literal. Splitting on
 * the last colon handles the first two; the third needs the brackets read
 * first, because an IPv6 address is mostly colons. Anything that parses to
 * neither is returned as null so the caller can refuse it instead of dialling
 * a host made of leftover punctuation.
 */
export function connectTarget(
  authority: string
): { host: string; port: number } | null {
  const trimmed = authority.trim();
  if (trimmed === "") return null;

  const bracketed = trimmed.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    const port = bracketed[2] == null ? UPSTREAM_PORT : Number(bracketed[2]);
    return Number.isInteger(port) && port > 0 && port <= 65535
      ? { host: bracketed[1]!, port }
      : null;
  }

  const colon = trimmed.lastIndexOf(":");
  if (colon === -1) return { host: trimmed, port: UPSTREAM_PORT };

  const host = trimmed.slice(0, colon);
  const port = Number(trimmed.slice(colon + 1));
  // A colon left inside the host means an unbracketed IPv6 literal, which is
  // not a valid authority and has no honest reading here.
  if (host === "" || host.includes(":")) return null;
  return Number.isInteger(port) && port > 0 && port <= 65535
    ? { host, port }
    : null;
}

/**
 * The hint that goes with a failed handshake, when one is warranted.
 *
 * A certificate error here means the agent's TLS client did not accept the
 * leaf certs.ts minted. Usually that is NODE_EXTRA_CA_CERTS never reaching it,
 * which fails every tunnel; it can also be one of qodercli's other TLS clients
 * talking to a host mitmHosts was not told about, which fails one. Telling a
 * student "the agent is not reading the variable" on the first such line sends
 * them after a configuration that is already right, so the note says what would
 * actually prove it, and says nothing at all about a failure that is not about
 * trust.
 */
export function handshakeNote(message: string): string {
  if (!/certificat|ssl|tls|handshake|alert/i.test(message)) return "";
  return (
    " (one tunnel failing like this is not the run failing: an agent can hold " +
    "more than one TLS client. NODE_EXTRA_CA_CERTS has really failed to arrive " +
    "only if every tunnel fails and the logs folder stays empty)"
  );
}

/**
 * Whether a tunnel to `host` is decrypted, or spliced through unread.
 *
 * `hosts` is the catalogue's answer for this agent, and it is optional: an
 * agent whose inference host cannot be predicted has to have every tunnel
 * terminated, which is what an absent pattern means. Qoder's can at least be
 * narrowed — the model call is elected per run onto one of two host shapes,
 * while a dozen other hosts carry sign-in, gates, telemetry and downloads —
 * and qodercli holds more than one TLS client, not all of which read
 * NODE_EXTRA_CA_CERTS. Decrypting a tunnel owned by one of those buys nothing
 * and breaks the call, so those hosts are left alone. The narrowing does have
 * to cover every shape the election can land on, though: miss one and that
 * run's inference tunnel is spliced, its model call goes through fine and
 * nothing is ever written to the logs folder. agents.ts writes the set down.
 */
export function terminatesTls(
  host: string,
  hosts: RegExp | undefined
): boolean {
  return hosts == null || hosts.test(host);
}

/** Refuse a tunnel on the raw socket, before any TLS is attempted. */
function refuseTunnel(clientSocket: Duplex, reason: string): void {
  console.log(dim(`[request-logger] ${reason}`));
  clientSocket.end(
    "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
  );
}

/**
 * Join the agent's socket to the host it asked for, and read nothing.
 *
 * Two pipes, so the agent's TLS handshake completes against the real
 * certificate from the real host: this is indistinguishable, from either end,
 * from not being proxied at all. That is the point. A tunnel this proxy
 * terminated instead would present a leaf from a CA that some of the agent's
 * TLS clients have never been told to trust, and fail.
 *
 * The 200 waits for the dial. Announcing a tunnel and then failing to reach the
 * host leaves the agent with a connection that dies mid-handshake and no reason
 * attached to it.
 */
export function spliceTunnel(
  clientSocket: Duplex,
  upstream: net.Socket,
  head: Buffer | null,
  host: string
): void {
  const close = () => {
    upstream.destroy();
    clientSocket.destroy();
  };
  upstream.on("error", (err) => {
    console.log(
      dim(
        `[request-logger] tunnel to ${host} could not be reached: ${err.message}`
      )
    );
    close();
  });
  // The agent going away mid-tunnel is not an error to report, but an
  // unhandled 'error' on a socket takes the process with it.
  clientSocket.on("error", close);

  upstream.on("connect", () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    // Bytes the agent pipelined behind its CONNECT line are the start of a
    // handshake this proxy will never see. They belong to the host.
    if (head != null && head.length > 0) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
}

/**
 * Make `server` answer CONNECT by tunnelling, and leave everything else about
 * it alone.
 *
 * Each tunnel that is decrypted gets its own http.Server, which is never
 * listened on: it is used purely as an HTTP parser and dispatcher for the
 * sockets handed to it. That is what lets the requests inside a tunnel reach
 * proxy.ts's ordinary handle, unchanged, with a target whose upstreamHost is
 * the host this tunnel named. A tunnel that is spliced instead gets no server
 * at all — there is nothing in it to parse.
 */
export function attachMitm(
  server: http.Server,
  target: ResolvedTarget,
  handlers: TunnelHandlers
): void {
  server.on("connect", (req, clientSocket, head) => {
    const authority = req.url ?? "";
    const parsed = connectTarget(authority);

    if (!parsed) {
      refuseTunnel(
        clientSocket,
        `CONNECT ${authority === "" ? "(no authority)" : authority} is not a ` +
          "host:port this tool can tunnel -> 502"
      );
      return;
    }
    if (parsed.port !== UPSTREAM_PORT) {
      refuseTunnel(
        clientSocket,
        `CONNECT ${authority} asks for port ${parsed.port}, but every host in ` +
          `this catalogue is HTTPS on ${UPSTREAM_PORT} -> 502`
      );
      return;
    }

    if (!terminatesTls(parsed.host, target.mitmHosts)) {
      // Named per tunnel rather than counted, because a host this pattern was
      // not told about would otherwise be invisible: the call inside it would
      // go through fine and simply never appear in the logs folder.
      console.log(
        dim(`[request-logger] tunnel passed through unread -> ${parsed.host}`)
      );
      spliceTunnel(
        clientSocket,
        (handlers.dial ?? dialUpstream)(parsed.host, parsed.port),
        head,
        parsed.host
      );
      return;
    }

    let leaf: { cert: string; key: string };
    try {
      leaf = certForHost(parsed.host);
    } catch (err) {
      refuseTunnel(
        clientSocket,
        `could not mint a certificate for ${parsed.host}: ` +
          `${(err as Error).message} -> 502`
      );
      return;
    }

    // The clone the whole design rests on: from here down, nothing can tell
    // this apart from a target the catalogue resolved to a fixed host.
    const tunnelTarget: ResolvedTarget = {
      ...target,
      upstreamHost: parsed.host,
    };

    const inner = http.createServer((innerReq, innerRes) =>
      handlers.onRequest(innerReq, innerRes, tunnelTarget)
    );
    inner.on("upgrade", handlers.onUpgrade);

    clientSocket.on("error", () => {
      // The agent went away mid-tunnel. Nothing to report and nothing to
      // forward, but an unhandled 'error' on a socket takes the process with
      // it.
      inner.close();
    });

    // Bytes the agent pipelined behind the CONNECT line belong to the tunnel,
    // not to the proxy's own parser. In practice this is always empty for TLS.
    if (head != null && head.length > 0) clientSocket.unshift(head);
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    const tlsSocket = new tls.TLSSocket(clientSocket, {
      isServer: true,
      key: leaf.key,
      cert: leaf.cert,
    });
    tlsSocket.on("error", (err) => {
      console.log(
        dim(
          `[request-logger] TLS handshake for ${parsed.host} failed: ${err.message}` +
            handshakeNote(err.message)
        )
      );
      inner.close();
      tlsSocket.destroy();
    });

    console.log(dim(`[request-logger] tunnel open -> ${parsed.host}`));
    inner.emit("connection", tlsSocket);
  });
}

/** Where an absolute-form plain HTTP request is to be sent. */
interface PlainForward {
  kind: "forward";
  hostname: string;
  /** The authority, as the destination's own Host header has to read. */
  host: string;
  port: number;
  path: string;
  useHttps: boolean;
}

/**
 * What a MITM run does with a request that arrived as plain HTTP.
 *
 * `origin` is a path, which names no destination at all and is the base-URL
 * mistake; `refuse` is a destination this will not dial, and carries the reason
 * to say out loud; `forward` is a destination it will.
 */
export type PlainRequestPlan =
  | { kind: "origin" }
  | { kind: "refuse"; reason: string; reply: string }
  | PlainForward;

/**
 * The addresses that mean "this machine".
 *
 * An IPv4 connection to a socket bound to `::` reports itself IPv4-mapped,
 * which is the shape every live run has produced; the other three are the same
 * place reached another way. Nothing outside 127.0.0.0/8 and ::1 is loopback,
 * and no client can claim to be from it.
 */
const LOOPBACK = /^(127(\.\d{1,3}){3}|::1|::ffff:127(\.\d{1,3}){3})$/;

const ORIGIN_FORM_REASON = "no destination named";
const ORIGIN_FORM_REPLY =
  "This run of request-logger is in man-in-the-middle mode, so a request has " +
  "to name its own destination: either a CONNECT carrying a host:port, or a " +
  "plain HTTP request whose URL is absolute. This one was a plain HTTP request " +
  "for a path on the proxy itself, which means your agent was pointed at a " +
  "base URL rather than at HTTPS_PROXY. Run `npm run request-logger -- " +
  "--force` and pick the route that matches how your agent is configured.\n";

/**
 * Decide what to do with a request that arrived as plain HTTP rather than as a
 * CONNECT.
 *
 * Pure, and exported for that reason: the interesting refusals depend on an
 * address read off a socket no test gets to choose, so the rule is tested here
 * and the wiring is tested over loopback.
 */
export function plainRequestPlan(
  url: string,
  remoteAddress: string | undefined
): PlainRequestPlan {
  // An origin-form target always begins with a slash, and says nothing about
  // where the request was meant to go.
  if (url === "" || url.startsWith("/")) return { kind: "origin" };

  if (remoteAddress == null || !LOOPBACK.test(remoteAddress)) {
    return {
      kind: "refuse",
      reason: "client is not this machine",
      reply:
        "This run of request-logger is in man-in-the-middle mode and listens " +
        "on every network interface. It forwards a plain HTTP request only for " +
        "a client on this machine, so that nothing else on your network can " +
        "use it as an open proxy. This request came from " +
        `${remoteAddress ?? "a socket that had already gone"}.\n`,
    };
  }

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return {
      kind: "refuse",
      reason: "unparseable request-target",
      reply:
        "This run of request-logger is in man-in-the-middle mode. A plain HTTP " +
        "request it can forward has to name its own destination in full, and " +
        "this request-target does not parse as one.\n",
    };
  }

  const useHttps = target.protocol === "https:";
  if (!useHttps && target.protocol !== "http:") {
    return {
      kind: "refuse",
      reason: `scheme ${target.protocol}`,
      reply:
        "This run of request-logger is in man-in-the-middle mode, and it " +
        "forwards a plain HTTP request over http and https only. This one " +
        `asked for ${target.protocol}.\n`,
    };
  }

  return {
    kind: "forward",
    // URL keeps an IPv6 literal's brackets in hostname, and the dialler does
    // not want them: dns.lookup("[::1]") is ENOTFOUND where "::1" connects.
    // host keeps them, because that is how a Host header reads.
    hostname: target.hostname.replace(/^\[|\]$/g, ""),
    host: target.host,
    // Unlike a CONNECT, which upstreamConnection in proxy.ts can only send to
    // 443, this path does its own dialling and so can honour what was asked.
    port: target.port === "" ? (useHttps ? 443 : 80) : Number(target.port),
    path: `${target.pathname}${target.search}`,
    useHttps,
  };
}

/**
 * Send a plain request to the destination it named, and read nothing.
 *
 * Not proxy.ts's handle: there is no target, no renderer and no capture, and
 * the whole point is that these bytes are not worth the disk they would take.
 * A resolver call carries no prompt.
 */
function forwardPlain(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  plan: PlainForward
): void {
  const headers: http.OutgoingHttpHeaders = { ...req.headers };
  // Hop-by-hop: they describe the connection to this proxy, not the one beyond.
  delete headers["proxy-connection"];
  delete headers["connection"];
  // The body arrives de-chunked, so the framing has to be decided again on the
  // way out rather than copied. A content-length that was there still is.
  delete headers["transfer-encoding"];
  // The client's own Host named this proxy, because that is what it connected
  // to. The destination has to be told it is being spoken to.
  headers.host = plan.host;

  const dial = plan.useHttps ? https : http;
  const upstream = dial.request(
    {
      hostname: plan.hostname,
      port: plan.port,
      method: req.method,
      path: plan.path,
      headers,
    },
    (upstreamRes) => {
      const out = { ...upstreamRes.headers };
      delete out["transfer-encoding"];
      res.writeHead(upstreamRes.statusCode ?? 502, out);
      upstreamRes.pipe(res);
    }
  );
  upstream.on("error", (err) => {
    console.log(
      dim(`[request-logger] could not reach ${plan.host}: ${err.message}`)
    );
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const message = `request-logger could not reach ${plan.host}: ${err.message}\n`;
    res.writeHead(502, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": String(Buffer.byteLength(message)),
      connection: "close",
    });
    res.end(message);
  });
  req.pipe(upstream);
}

/**
 * Answer a plain HTTP request to a proxy that is listening for CONNECT.
 *
 * This is proxy.ts's ordinary request handler on a MITM run, and it splits
 * three ways. A request that names its own destination is forwarded to it
 * unread, which is what lets qodercli's HTTPDNS bootstrap succeed instead of
 * being retried and abandoned. A request that names only a path is the
 * student's base-URL mistake, and says so. Anything else is refused with the
 * reason attached.
 */
export function answerPlainRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): void {
  const method = req.method ?? "GET";
  const url = req.url ?? "";
  const plan = plainRequestPlan(url, req.socket.remoteAddress);

  if (plan.kind === "forward") {
    console.log(
      dim(
        `[request-logger] plain request passed through unread -> ${method} ${url}`
      )
    );
    forwardPlain(req, res, plan);
    return;
  }

  const reason = plan.kind === "origin" ? ORIGIN_FORM_REASON : plan.reason;
  const reply = plan.kind === "origin" ? ORIGIN_FORM_REPLY : plan.reply;
  console.log(
    dim(
      `[request-logger] ${method} ${url === "" ? "/" : url} arrived as plain ` +
        `HTTP in MITM mode -> 400 (${reason})`
    )
  );
  res.writeHead(400, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(Buffer.byteLength(reply)),
    connection: "close",
  });
  res.end(reply);
}
