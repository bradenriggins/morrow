export const MAX_BRIDGE_MESSAGE_BYTES = 2 * 1024 * 1024;

function resultEnvelope(command, ok, result, failure) {
  return {
    schema: "morrow.bridge.result.v1",
    protocolVersion: 1,
    requestId: command.requestId,
    operationId: command.operationId,
    generation: command.generation,
    ok,
    ...(ok ? { result } : { ...(result ? { result } : {}), problem: failure }),
    completedAt: Date.now(),
  };
}

function encodedBytes(value) {
  return new TextEncoder().encode(value).byteLength;
}

export function serializeBridgeResult(command, ok, result, failure) {
  let text;
  try {
    text = JSON.stringify(resultEnvelope(command, ok, result, failure));
  } catch {
    text = "";
  }
  if (text && encodedBytes(text) <= MAX_BRIDGE_MESSAGE_BYTES) return text;
  const write = command.kind === "invoke_write" || command.kind === "stage_write";
  const fallback = resultEnvelope(command, false, null, {
    schema: "morrow.bridge.problem.v1",
    code: write ? "write_outcome_unknown" : "bridge_result_too_large",
    message: write
      ? "Morrow could not return the browser result within the local Bridge limit. Check the existing course before another change."
      : "Morrow could not return this browser result within the local Bridge limit. Narrow the request or continue the list in smaller pages.",
    recoverable: !write,
  });
  return JSON.stringify(fallback);
}
