import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-post-retry-"));
const key = join(directory, "key.pem");
const certificate = join(directory, "certificate.pem");
const outputDirectory = new URL("../../output/research/", import.meta.url);
const receipt = new URL("moodle-gradebook-post-transport-retry-repro.json", outputDirectory);

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });

const posts = [];
let appliedCount = 0;
let server;
let browser;
let context;
try {
  server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>Morrow transport repro</title>");
      return;
    }
    if (request.method !== "POST" || request.url !== "/gradebook-rename") {
      response.writeHead(404).end();
      return;
    }
    const body = await readBody(request);
    appliedCount += 1;
    posts.push({
      http_version: request.httpVersion,
      remote_port: request.socket.remotePort,
      content_length: request.headers["content-length"] || null,
      body_bytes: Buffer.byteLength(body),
    });
    request.socket.destroy();
  });
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("repro_server_unavailable");
  const origin = `https://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.goto(origin);
  const browserResult = await page.evaluate(async () => {
    let explicitFetchCalls = 0;
    try {
      explicitFetchCalls += 1;
      await fetch("/gradebook-rename", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "fullname=Applied+once",
      });
      return { explicit_fetch_calls: explicitFetchCalls, fetch_rejected: false };
    } catch {
      return { explicit_fetch_calls: explicitFetchCalls, fetch_rejected: true };
    }
  });
  const distinctRemotePorts = [...new Set(posts.map((post) => post.remote_port))].length;
  const result = {
    schema: "morrow.moodle_gradebook_post_transport_retry_repro.v1",
    captured_at: new Date().toISOString(),
    scope: "local HTTPS test server only; no Moodle account, course, learner, credential, or live write",
    browser: { engine: "Chrome for Testing", version: browser.version() },
    transport: {
      protocol: [...new Set(posts.map((post) => post.http_version))],
      explicit_fetch_calls: browserResult.explicit_fetch_calls,
      fetch_rejected: browserResult.fetch_rejected,
      server_post_count: posts.length,
      server_applied_count: appliedCount,
      distinct_remote_ports: distinctRemotePorts,
      posts: posts.map(({ remote_port, ...post }) => post),
    },
    finding: "A single explicit browser fetch can produce more than one server-observed POST after the server applies the first request and drops the connection before a response. The browser-level retry is outside the helper's explicit retry logic.",
  };
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(receipt, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(`${receipt.pathname}\n`);
} finally {
  await context?.close();
  await browser?.close();
  await new Promise((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()) ?? resolve());
  rmSync(directory, { recursive: true, force: true });
}
