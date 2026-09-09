/**
 * certs.ts — the throwaway certificate authority that MITM mode runs on.
 *
 * Qoder's default subscription route cannot be redirected: it elects its
 * inference host at run time and offers no base-URL override. The only place to
 * stand is in the middle of its TLS connection, and to be in the middle of a
 * TLS connection you have to present a certificate the client trusts. So this
 * module mints one.
 *
 * Two properties keep that from being as alarming as it sounds:
 *
 *  - The CA is handed to qodercli through NODE_EXTRA_CA_CERTS, which adds it to
 *    that process's trust store only. Nothing here touches the system or user
 *    trust store, and nothing survives the process that did.
 *  - The CA is short-lived and its directory is deleted on the way out, so a
 *    private key that can mint trusted certificates is not left on disk. It is
 *    also gitignored, because the failure mode of committing one is not a
 *    failure of this tool.
 *
 * Node has no built-in way to create an X.509 certificate, and this tool ships
 * no dependencies, so this is the one place that shells out: to `openssl`. That
 * is a real requirement and the README says so. The alternative — hand-rolling
 * ASN.1 DER — would keep the dependency count at zero and replace it with a
 * certificate whose compatibility with qodercli's TLS stack could only be
 * checked by running qodercli, which costs its owner money.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Where the CA lives for this run. Gitignored; deleted on exit. */
export const MITM_DIR = path.join(HERE, ".mitm");

/**
 * The CA certificate's own lifetime, in days. Short on purpose: this is a
 * private key that can mint a certificate for any host, and the only reason it
 * outlives the process at all is that a run can be killed in a way no exit
 * handler sees. openssl's own minimum granularity is a day.
 */
export const CA_VALIDITY_DAYS = 1;

export function caCertPath(dir: string = MITM_DIR): string {
  return path.join(dir, "ca.crt");
}

export const CA_CERT_PATH = caCertPath();

/**
 * Whether `openssl` is on PATH. MITM mode cannot start without it, and the
 * check exists so the reason is said once, up front, rather than surfacing as a
 * spawn error from somewhere deeper.
 */
export function opensslAvailable(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * The SAN entry for one host.
 *
 * An IP literal needs `IP:` and a hostname needs `DNS:`, and getting that
 * backwards produces a certificate that looks right and does not verify. This
 * matters more than it would for an ordinary proxy: Qoder resolves hosts through
 * Aliyun HTTPDNS itself, so the thing it CONNECTs to is not guaranteed to be a
 * name.
 */
export function sanEntry(host: string): string {
  return isIpAddress(host) ? `IP:${host}` : `DNS:${host}`;
}

function isIpAddress(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

/**
 * The openssl config the CA is built from.
 *
 * A config file rather than `-addext` flags because `-addext` is an OpenSSL
 * 1.1.1 addition and macOS still ships LibreSSL as `/usr/bin/openssl`. The
 * config form works on both, which is the difference between this running on a
 * stock Mac and not.
 */
export function caConfig(): string {
  return [
    "[req]",
    "distinguished_name = dn",
    "x509_extensions = v3_ca",
    "prompt = no",
    "",
    "[dn]",
    "CN = request-logger MITM (throwaway, this run only)",
    "",
    "[v3_ca]",
    "basicConstraints = critical, CA:TRUE",
    "keyUsage = critical, keyCertSign, cRLSign, digitalSignature",
    "subjectKeyIdentifier = hash",
    "",
  ].join("\n");
}

/** The openssl config one leaf certificate is built from. */
export function leafConfig(host: string): string {
  return [
    "[req]",
    "distinguished_name = dn",
    "prompt = no",
    "",
    "[dn]",
    `CN = ${host}`,
    "",
    "[v3_leaf]",
    "basicConstraints = critical, CA:FALSE",
    "keyUsage = critical, digitalSignature, keyEncipherment",
    "extendedKeyUsage = serverAuth",
    `subjectAltName = ${sanEntry(host)}`,
    "",
  ].join("\n");
}

function openssl(args: string[]): void {
  try {
    execFileSync("openssl", args, { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(
      `openssl ${args[0]} failed${stderr ? `: ${stderr}` : ""}. ` +
        "MITM mode (Qoder's default subscription route) needs openssl on PATH."
    );
  }
}

/** A host as a filename. IPv6 addresses carry colons, which are not portable. */
function stem(host: string): string {
  return host.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Create the CA for this run. Called once, before the banner is printed,
 * because the command in the banner names the CA's path and qodercli has to be
 * started after the file exists.
 */
export function ensureCa(dir: string = MITM_DIR): string {
  if (!opensslAvailable()) {
    throw new Error(
      "openssl was not found on PATH. Qoder's default subscription route can " +
        "only be logged by standing in the middle of its TLS connection, which " +
        "needs a certificate this tool has to mint. Install openssl, or run " +
        "with --force and pick Qoder's BYOK route instead."
    );
  }
  fs.mkdirSync(dir, { recursive: true });
  const config = path.join(dir, "ca.cnf");
  fs.writeFileSync(config, caConfig());
  openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-days",
    String(CA_VALIDITY_DAYS),
    "-keyout",
    path.join(dir, "ca.key"),
    "-out",
    caCertPath(dir),
    "-config",
    config,
  ]);
  return caCertPath(dir);
}

/**
 * Leaf certificates already minted this run, so a host qodercli opens several
 * connections to costs one keygen rather than one per connection. Keyed by
 * directory as well as host because the tests mint into a temporary one.
 */
const leafCache = new Map<string, { cert: string; key: string }>();

/**
 * A certificate for one host, signed by this run's CA, as PEM strings ready to
 * hand to tls.createSecureContext.
 *
 * Minted on demand rather than up front: the hosts are whatever qodercli
 * CONNECTs to, which this tool does not get to choose and cannot enumerate in
 * advance, since Qoder's inference host carries a per-tenant prefix and is
 * elected at run time.
 */
export function certForHost(
  host: string,
  dir: string = MITM_DIR
): { cert: string; key: string } {
  const cacheKey = `${dir}\u0000${host}`;
  const cached = leafCache.get(cacheKey);
  if (cached) return cached;

  const base = path.join(dir, stem(host));
  const config = `${base}.cnf`;
  fs.writeFileSync(config, leafConfig(host));
  openssl([
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-keyout",
    `${base}.key`,
    "-out",
    `${base}.csr`,
    "-config",
    config,
  ]);
  openssl([
    "x509",
    "-req",
    "-sha256",
    "-days",
    String(CA_VALIDITY_DAYS),
    "-in",
    `${base}.csr`,
    "-CA",
    caCertPath(dir),
    "-CAkey",
    path.join(dir, "ca.key"),
    "-CAcreateserial",
    "-out",
    `${base}.crt`,
    "-extfile",
    config,
    "-extensions",
    "v3_leaf",
  ]);

  const leaf = {
    cert: fs.readFileSync(`${base}.crt`, "utf8"),
    key: fs.readFileSync(`${base}.key`, "utf8"),
  };
  leafCache.set(cacheKey, leaf);
  return leaf;
}

/**
 * Delete the CA and every leaf minted from it. Called on the way out, so the
 * key material does not outlive the run that was allowed to create it.
 */
export function clearMitmDir(dir: string = MITM_DIR): void {
  for (const key of [...leafCache.keys()]) {
    if (key.startsWith(`${dir}\u0000`)) leafCache.delete(key);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
