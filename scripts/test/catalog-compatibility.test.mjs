import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchBoundedCatalogText,
} from "../../connector/extension/src/catalog-compatibility.js";

test("packaged catalog transport bounds header and body stalls", async () => {
  let headerSignal;
  const headerStarted = Date.now();
  await assert.rejects(fetchBoundedCatalogText("chrome-extension://fixture/catalog.json", "Fixture catalog", {
    timeoutMs: 25,
    fetchImplementation: async (_input, options) => {
      headerSignal = options.signal;
      return await new Promise(() => {});
    },
  }), /Fixture catalog response timed out/);
  assert.equal(headerSignal.aborted, true);
  assert.ok(Date.now() - headerStarted < 500);

  let cancelled = 0;
  const body = new ReadableStream({
    start() {},
    cancel() {
      cancelled += 1;
      return new Promise(() => {});
    },
  });
  const bodyStarted = Date.now();
  await assert.rejects(fetchBoundedCatalogText("chrome-extension://fixture/catalog.json", "Fixture catalog", {
    timeoutMs: 25,
    fetchImplementation: async () => new Response(body, {
      headers: { "content-type": "application/json" },
    }),
  }), /Fixture catalog response timed out/);
  assert.equal(cancelled, 1);
  assert.ok(Date.now() - bodyStarted < 500);
});

test("packaged catalog transport carries its exact request policy and preserves valid fragments", async () => {
  let requestOptions;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"name":"mor'));
      controller.enqueue(new TextEncoder().encode('row"}'));
      controller.close();
    },
  });
  const text = await fetchBoundedCatalogText("chrome-extension://fixture/catalog.json", "Fixture catalog", {
    timeoutMs: 1_000,
    fetchImplementation: async (_input, options) => {
      requestOptions = options;
      return new Response(body, { headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(text, '{"name":"morrow"}');
  assert.equal(requestOptions.cache, "no-store");
  assert.equal(requestOptions.redirect, "error");
  assert.equal(requestOptions.signal.aborted, false);
});
