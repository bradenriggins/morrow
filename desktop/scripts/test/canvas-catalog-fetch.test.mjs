import assert from "node:assert/strict";
import test from "node:test";
import { fetchJson } from "../generate-canvas-api-catalog.mjs";

const url = "https://canvas.instructure.com/doc/api/api-docs.json";

function response(chunks, headers = {}) {
  let cancelled = 0;
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
    cancel() { cancelled += 1; },
  });
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json; charset=utf-8", ...headers }),
    body,
    cancelled: () => cancelled,
  };
}

function responseWithUnsettledCancellation(chunks) {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
    },
    cancel() { return new Promise(() => {}); },
  });
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    body,
  };
}

test("Canvas catalog fetch reads bounded strict JSON and refuses malformed bytes", async () => {
  let requestOptions;
  const valid = response([Buffer.from('{"name":"mor'), Buffer.from('row"}')]);
  const result = await fetchJson(url, {
    fetchImplementation: async (_url, options) => { requestOptions = options; return valid; },
    timeoutMs: 1_000,
    maxBytes: 1_024,
  });
  assert.deepEqual(result.value, { name: "morrow" });
  assert.equal(requestOptions.redirect, "error");
  assert.equal(requestOptions.headers.Accept, "application/json");
  assert.equal(requestOptions.signal instanceof AbortSignal, true);

  const invalid = response([Buffer.concat([Buffer.from('{"name":"'), Buffer.from([0xff]), Buffer.from('"}')])]);
  await assert.rejects(fetchJson(url, {
    fetchImplementation: async () => invalid,
    timeoutMs: 1_000,
    maxBytes: 1_024,
  }), /invalid UTF-8/);
});

test("Canvas catalog fetch refuses declared and streamed overflow before full-body allocation", async () => {
  const declared = response([], { "content-length": "1025" });
  await assert.rejects(fetchJson(url, {
    fetchImplementation: async () => declared,
    timeoutMs: 1_000,
    maxBytes: 1_024,
  }), /exceeded 1024 bytes/);

  const streamed = response([new Uint8Array(1_024), new Uint8Array(1)]);
  await assert.rejects(fetchJson(url, {
    fetchImplementation: async () => streamed,
    timeoutMs: 1_000,
    maxBytes: 1_024,
  }), /exceeded 1024 bytes/);

  const startedAt = Date.now();
  await assert.rejects(fetchJson(url, {
    fetchImplementation: async () => responseWithUnsettledCancellation([new Uint8Array(1_025)]),
    timeoutMs: 1_000,
    maxBytes: 1_024,
  }), /exceeded 1024 bytes/);
  assert.ok(Date.now() - startedAt < 500);
});

test("Canvas catalog fetch aborts a response that never reaches its headers", async () => {
  let signal;
  const startedAt = Date.now();
  await assert.rejects(fetchJson(url, {
    fetchImplementation: async (_url, options) => {
      signal = options.signal;
      return new Promise(() => {});
    },
    timeoutMs: 20,
    maxBytes: 1_024,
  }), /timed out/);
  assert.equal(signal.aborted, true);
  assert.ok(Date.now() - startedAt < 500);
});
