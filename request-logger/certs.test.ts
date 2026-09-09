import { describe, it, expect } from "vitest";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import {
  CA_VALIDITY_DAYS,
  caConfig,
  caCertPath,
  certForHost,
  clearMitmDir,
  ensureCa,
  leafConfig,
  opensslAvailable,
  sanEntry,
} from "./certs";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "request-logger-mitm-"));
}

describe("sanEntry", () => {
  it("uses DNS: for a hostname", () => {
    expect(sanEntry("b1731805-api.qoder.xin")).toBe("DNS:b1731805-api.qoder.xin");
  });

  it("uses IP: for an address, which is what an HTTPDNS client can CONNECT to", () => {
    expect(sanEntry("10.1.2.3")).toBe("IP:10.1.2.3");
    expect(sanEntry("127.0.0.1")).toBe("IP:127.0.0.1");
    expect(sanEntry("::1")).toBe("IP:::1");
    expect(sanEntry("2001:db8::1")).toBe("IP:2001:db8::1");
  });
});

describe("caConfig", () => {
  it("marks the certificate as a CA, critically, or it cannot sign a leaf", () => {
    expect(caConfig()).toMatch(/basicConstraints\s*=\s*critical,\s*CA:TRUE/);
    expect(caConfig()).toMatch(/keyUsage\s*=\s*critical,.*keyCertSign/);
  });

  it("never prompts, since there is nobody at a keyboard", () => {
    expect(caConfig()).toMatch(/prompt\s*=\s*no/);
  });
});

describe("leafConfig", () => {
  it("marks the leaf as not a CA, so it cannot be used to sign anything", () => {
    expect(leafConfig("a.qoder.xin")).toMatch(/basicConstraints\s*=\s*critical,\s*CA:FALSE/);
  });

  it("names the host it is for, in both the subject and the SAN", () => {
    const config = leafConfig("a.qoder.xin");
    expect(config).toContain("CN = a.qoder.xin");
    expect(config).toContain("subjectAltName = DNS:a.qoder.xin");
  });

  it("is for server authentication, which is what a TLS client checks it for", () => {
    expect(leafConfig("a.qoder.xin")).toMatch(/extendedKeyUsage\s*=\s*serverAuth/);
  });
});

describe("validity", () => {
  it("keeps the CA short-lived, since its private key sits on disk while it runs", () => {
    expect(CA_VALIDITY_DAYS).toBeLessThanOrEqual(2);
    expect(CA_VALIDITY_DAYS).toBeGreaterThanOrEqual(1);
  });
});

// Everything below runs the real openssl. Skipped, not failed, where it is
// missing: the point is to prove the minted chain verifies, and a machine
// without openssl cannot use MITM mode at all anyway.
describe.skipIf(!opensslAvailable())("minting", () => {
  it("writes a CA certificate and key into the directory it is given", () => {
    const dir = tempDir();
    try {
      ensureCa(dir);
      expect(fs.readFileSync(caCertPath(dir), "utf8")).toContain("BEGIN CERTIFICATE");
      expect(fs.readFileSync(path.join(dir, "ca.key"), "utf8")).toContain("PRIVATE KEY");
    } finally {
      clearMitmDir(dir);
    }
  });

  it("mints a leaf a TLS client trusts, given only the CA", async () => {
    const dir = tempDir();
    try {
      ensureCa(dir);
      const { cert, key } = certForHost("mitm.test", dir);

      const server = https.createServer({ cert, key }, (_req, res) => {
        res.end("pong");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;

      try {
        const body = await new Promise<string>((resolve, reject) => {
          const req = https.request(
            {
              host: "mitm.test",
              port,
              path: "/",
              // The name has to drive the identity check while the socket
              // still goes to the loopback listener, which is exactly the
              // situation qodercli is in when this tool answers its CONNECT.
              // `all` is honoured because Node's happy-eyeballs default asks
              // for a list rather than a single address.
              lookup: (_host: string, opts: { all?: boolean }, cb: any) =>
                opts?.all
                  ? cb(null, [{ address: "127.0.0.1", family: 4 }])
                  : cb(null, "127.0.0.1", 4),
              ca: fs.readFileSync(caCertPath(dir)),
            },
            (res) => {
              let out = "";
              res.setEncoding("utf8");
              res.on("data", (chunk) => (out += chunk));
              res.on("end", () => resolve(out));
            }
          );
          req.on("error", reject);
          req.end();
        });
        expect(body).toBe("pong");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      clearMitmDir(dir);
    }
  });

  it("mints a leaf for an IP literal too, and it verifies against that IP", async () => {
    const dir = tempDir();
    try {
      ensureCa(dir);
      const { cert, key } = certForHost("127.0.0.1", dir);
      const server = https.createServer({ cert, key }, (_req, res) => res.end("ok"));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;
      try {
        const body = await new Promise<string>((resolve, reject) => {
          const req = https.request(
            { host: "127.0.0.1", port, path: "/", ca: fs.readFileSync(caCertPath(dir)) },
            (res) => {
              let out = "";
              res.setEncoding("utf8");
              res.on("data", (chunk) => (out += chunk));
              res.on("end", () => resolve(out));
            }
          );
          req.on("error", reject);
          req.end();
        });
        expect(body).toBe("ok");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      clearMitmDir(dir);
    }
  });

  it("returns the same leaf for the same host without minting twice", () => {
    const dir = tempDir();
    try {
      ensureCa(dir);
      const first = certForHost("cached.test", dir);
      const second = certForHost("cached.test", dir);
      expect(second).toBe(first);
    } finally {
      clearMitmDir(dir);
    }
  });

  it("clearMitmDir removes the key material and tolerates a directory that is not there", () => {
    const dir = tempDir();
    ensureCa(dir);
    expect(fs.existsSync(path.join(dir, "ca.key"))).toBe(true);
    clearMitmDir(dir);
    expect(fs.existsSync(dir)).toBe(false);
    expect(() => clearMitmDir(dir)).not.toThrow();
  });
});
