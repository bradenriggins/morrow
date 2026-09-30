#!/usr/bin/env node
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";

const root = resolve(import.meta.dirname, "../..");
const flag = process.argv.indexOf("--receipt");
const receiptPath = flag > 0 ? resolve(process.argv[flag + 1]) : resolve(root, "output/item-bank-isolation/receipt.json");
const directory = mkdtempSync(join(tmpdir(), "morrow-item-bank-isolation-"));
const extension = join(directory, "extension");
mkdirSync(extension);
const source = join(root, "connector/extension/src/item-bank-executor.js");
cpSync(source, join(extension, "item-bank-executor.js"));
writeFileSync(join(extension, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Morrow isolated execution fixture", version: "1.0.0", permissions: ["scripting", "tabs"], host_permissions: ["https://*.instructure.com/*"], background: { service_worker: "worker.js", type: "module" } }));
writeFileSync(join(extension, "worker.js"), 'import { executeItemBankInPage } from "./item-bank-executor.js"; globalThis.executeItemBankInPage = executeItemBankInPage;');
const origin = "https://school.instructure.com";
const lti = "https://school.quiz-lti.instructure.com";
const api = "https://school.quiz-api.instructure.com";
const token = "Signature " + "seeded-private-bank-token-".repeat(4);
const catalog = JSON.parse(readFileSync(join(root, "artifacts/canvas-api/canvas-api-catalog.json")));
const operation = catalog.operations.find((o) => o.service === "item_bank" && o.nickname === "list_banks");
const context = await chromium.launchPersistentContext(join(directory, "profile"), { headless: true, executablePath: chromium.executablePath(), ignoreDefaultArgs: ["--disable-extensions"], args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
const requests = [];
const results = [];
try {
  await context.route("https://*.instructure.com/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = { "access-control-allow-origin": lti, "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "authorization,authtype,accept", "content-type": "application/json" };
    if (url.origin === api) {
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      requests.push({ url: url.href, headers: await request.allHeaders() });
      return route.fulfill({ status: 200, headers, body: JSON.stringify({ banks: [{ id: "51", title: "Cell structure" }] }) });
    }
    if (url.origin === origin) return route.fulfill({ contentType: "text/html", body: `<iframe referrerpolicy="unsafe-url" src="${lti}/banks"></iframe>` });
    return route.fulfill({ contentType: "text/html", body: `<script>
      sessionStorage.setItem("current_user", JSON.stringify({id:"7"}));
      window.captured = [];
      const originalParse = JSON.parse;
      JSON.parse = function(value, ...args) { if (typeof value === "string" && value.includes("seeded-private-bank-token")) window.captured.push(value); return originalParse.call(this,value,...args); };
      const originalFetch = fetch;
      window.fetch = function(...args) { window.captured.push("page-fetch"); return originalFetch.apply(this,args); };
    </script><p>Item Bank fixture</p>` });
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const page = await context.newPage();
  await page.goto(`${origin}/courses/42/external_tools/71234`);
  const frame = page.frames().find((f) => f.url().startsWith(lti));
  assert.ok(frame);
  await frame.waitForFunction(() => sessionStorage.getItem("current_user") !== null);
  const tabs = await worker.evaluate(() => chrome.tabs.query({}));
  const tab = tabs.find((t) => t.url === "https://school.instructure.com/courses/42/external_tools/71234");
  assert.ok(tab);
  const probes = await worker.evaluate(({ tabId, operation }) => chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: "MAIN", func: globalThis.executeItemBankInPage,
    args: [JSON.stringify({ operation, principalId: "7", canvasOrigin: "https://school.instructure.com", courseId: "42", contextOnly: true, expiresAt: Date.now() + 30_000 })] }), { tabId: tab.id, operation });
  const matchedFrames = probes.filter((entry) => entry.result?.matched === true && entry.result?.ok === true);
  assert.equal(matchedFrames.length, 1);
  const frameId = matchedFrames[0].frameId;
  assert.notEqual(frameId, 0);
  for (const [name, principal, world] of [["valid-isolated", "7", "ISOLATED"], ["wrong-principal", "8", "ISOLATED"], ["main-world-control", "7", "MAIN"]]) {
    const now = Date.now();
    const input = { operation, principalId: principal, canvasOrigin: origin, courseId: "42", arguments: { course_id: "42" }, expiresAt: now + 30_000,
      credential: { apiOrigin: api, token, authType: "Signature", contextUuid: "fixture-context-uuid", canvasLocalContextId: "42", externalToolId: "71234", launchUrl: `${origin}/courses/42/external_tools/71234`, launchNonce: "b28f3aae-8888-4c5b-9a17-458f2e1fe309", launchedAt: now - 1000, capturedAt: now } };
    const beforeRequests = requests.length;
    const [execution] = await worker.evaluate(async ({ tabId, frameId, input, world }) => {
      return chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, world, func: globalThis.executeItemBankInPage, args: [JSON.stringify(input)] });
    }, { tabId: tab.id, frameId, input, world });
    assert.ok(execution);
    const captured = await frame.evaluate(() => window.captured);
    if (name === "wrong-principal") {
      assert.equal(execution.result.matched, false);
      assert.equal(requests.length, beforeRequests);
    } else {
      assert.equal(execution.result.ok, true, JSON.stringify(execution.result));
      assert.equal(requests.length, beforeRequests + 1);
      assert.equal(requests.at(-1).headers.authorization, token);
    }
    if (world === "ISOLATED") assert.deepEqual(captured, []);
    else assert.ok(captured.some((value) => value.includes("seeded-private-bank-token")), "MAIN control did not exercise the page hook");
    assert.equal(JSON.stringify(execution.result).includes(token), false);
    results.push({ name, passed: true, matched: execution.result.matched, pageCapturedCredential: world === "MAIN", providerReads: requests.length - beforeRequests });
  }
  const receipt = { schema: "morrow.item-bank-isolation-proof.v1", generatedAt: new Date().toISOString(), sourceSha256: createHash("sha256").update(readFileSync(source)).digest("hex"), browser: context.browser()?.version(), cases: results };
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ passed: results.length, receipt: receiptPath }) + "\n");
} finally { await context.close(); }
