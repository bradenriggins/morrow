const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { mkdtemp, rm } = require("node:fs/promises");
const http = require("node:http");
const { createRequire } = require("node:module");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { promisify } = require("node:util");

const run = promisify(execFile);
const root = path.resolve(__dirname, "..");
const builderRequire = createRequire(require.resolve("electron-builder"));
const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib/package.json"));
const downloader = appBuilderRequire.resolve("app-builder-lib/out/util/electronGet.js");
const { loadAll } = appBuilderRequire("js-yaml");

test("the builder proxy dependency removes the unpatched sprintf-js chain", () => {
  const lock = Object.assign({}, ...loadAll(readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8")));
  assert.equal(lock.overrides["@electron/get@3.1.0>global-agent"], "4.1.3");
  assert.ok(Object.keys(lock.packages).includes("global-agent@4.1.3"));
  assert.ok(!Object.keys(lock.packages).some((name) => /^(?:sprintf-js|roarr|global-agent@3)@?/u.test(name)));
  const config = loadAll(readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8"))[0];
  assert.deepEqual(config.auditConfig.ignoreGhsas, ["GHSA-86w9-cpqp-85rv", "GHSA-ch52-4w7c-c8xp"]);
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

test("the pinned builder downloads and checks an artifact through the replacement proxy and NO_PROXY", { timeout: 45_000 }, async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "morrow-builder-proxy-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const bytes = Buffer.from("Morrow dependency downloader fixture\n");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const filename = "electron-v99.0.0-darwin-arm64.zip";
  const originRequests = [];
  const origin = http.createServer((request, response) => {
    originRequests.push(request.url);
    if (request.url.endsWith("/SHASUMS256.txt")) response.end(`${digest} *${filename}\n`);
    else if (request.url.endsWith(`/${filename}`)) response.end(bytes);
    else { response.writeHead(404); response.end(); }
  });
  const originPort = await listen(origin);
  t.after(() => close(origin));
  const proxyRequests = [];
  const proxy = http.createServer((request, response) => {
    proxyRequests.push(request.url);
    const target = new URL(request.url);
    assert.equal(target.hostname, "127.0.0.1");
    assert.equal(Number(target.port), originPort);
    const forward = http.request(target, { method: request.method, headers: request.headers }, (source) => {
      response.writeHead(source.statusCode, source.headers);
      source.pipe(response);
    });
    forward.on("error", () => { response.writeHead(502); response.end(); });
    request.pipe(forward);
  });
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));
  const child = `
    const assert = require('node:assert/strict');
    const { readFileSync } = require('node:fs');
    const { createHash } = require('node:crypto');
    const { downloadElectronArtifactZip } = require(process.argv[1]);
    assert.ok(global.GLOBAL_AGENT, 'the actual downloader must initialize the proxy');
    (async () => {
      const file = await downloadElectronArtifactZip({
        artifactName: 'electron', version: '99.0.0', arch: 'arm64', platformName: 'darwin',
        cacheDir: process.argv[2], electronDownload: { mirror: process.argv[3] }
      });
      const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
      assert.equal(digest, process.argv[4]);
      console.log(JSON.stringify({ digest }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/proxy|electron.*mirror|electron.*cache|electron_get/iu.test(name)));
  for (const bypass of [false, true]) {
    proxyRequests.length = 0;
    originRequests.length = 0;
    const { stdout } = await run(process.execPath, ["-e", child, downloader, path.join(temporary, String(bypass)), `http://127.0.0.1:${originPort}/`, digest], {
      timeout: 15_000,
      env: { ...inherited, ELECTRON_GET_USE_PROXY: "1", GLOBAL_AGENT_HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, GLOBAL_AGENT_NO_PROXY: bypass ? "127.0.0.1" : "" },
    });
    assert.equal(JSON.parse(stdout.trim().split("\n").at(-1)).digest, digest);
    assert.equal(originRequests.length, 2, "artifact and checksum must reach the origin");
    assert.equal(proxyRequests.length, bypass ? 0 : 2, "proxy routing must respect NO_PROXY");
  }
});
