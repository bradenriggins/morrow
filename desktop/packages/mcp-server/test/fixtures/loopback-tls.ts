import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface LoopbackTlsIdentity {
  readonly key: Buffer;
  readonly cert: Buffer;
}

/**
 * A fresh loopback TLS pair for one test's fixture HTTPS server,
 * generated at test time with openssl (self-signed CN=127.0.0.1, one
 * day). No private key material is committed: the pair is minted into
 * the test's own directory, which the fixture removes when it closes,
 * and nothing pins the key across runs (the clients under test run
 * with TLS verification disabled, as they did against the old
 * committed pair).
 */
export async function generateLoopbackTls(directory: string): Promise<LoopbackTlsIdentity> {
  const keyPath = join(directory, "loopback-test-key.pem");
  const certificatePath = join(directory, "loopback-test-cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
    "-keyout", keyPath, "-out", certificatePath,
  ], { stdio: "ignore" });
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certificatePath)]);
  return { key, cert };
}
