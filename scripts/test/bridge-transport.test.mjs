import assert from "node:assert/strict";
import test from "node:test";
import { MAX_BRIDGE_MESSAGE_BYTES, serializeBridgeResult } from "../../connector/extension/src/bridge-transport.js";

const command = {
  requestId: "request:bridge-result-1",
  operationId: "operation:bridge-result-1",
  generation: 1,
  kind: "invoke_read",
};

test("Bridge transport preserves a result that fits the socket limit", () => {
  const parsed = JSON.parse(serializeBridgeResult(command, true, { pages: [{ id: "1" }] }));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.result, { pages: [{ id: "1" }] });
});

test("Bridge transport returns a bounded read failure for an oversized result", () => {
  const serialized = serializeBridgeResult(command, true, { body: "x".repeat(MAX_BRIDGE_MESSAGE_BYTES) });
  const parsed = JSON.parse(serialized);
  assert.ok(Buffer.byteLength(serialized, "utf8") <= MAX_BRIDGE_MESSAGE_BYTES);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.problem.code, "bridge_result_too_large");
  assert.equal(parsed.problem.recoverable, true);
});

test("Bridge transport marks an oversized write result as unknown", () => {
  const serialized = serializeBridgeResult({ ...command, kind: "invoke_write" }, true, {
    body: "x".repeat(MAX_BRIDGE_MESSAGE_BYTES),
  });
  const parsed = JSON.parse(serialized);
  assert.ok(Buffer.byteLength(serialized, "utf8") <= MAX_BRIDGE_MESSAGE_BYTES);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.problem.code, "write_outcome_unknown");
  assert.equal(parsed.problem.recoverable, false);
});

test("Bridge transport returns a bounded failure for a nonserializable result", () => {
  const result = {};
  result.self = result;
  const parsed = JSON.parse(serializeBridgeResult(command, true, result));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.problem.code, "bridge_result_too_large");
});
