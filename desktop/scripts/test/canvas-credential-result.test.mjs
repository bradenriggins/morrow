import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInThisContext } from "node:vm";
import { canvasOperationAdmission, canvasReadbackAssessment } from "../../connector/extension/generated/canvas-operation-admission.js";
import { categoriesForBinding } from "../../connector/extension/src/edit-policy.js";

const WORKER_SOURCE = readFileSync(new URL("../../connector/extension/src/service-worker.js", import.meta.url), "utf8");
const CATALOG = JSON.parse(readFileSync(new URL("../../connector/extension/generated/canvas-api-catalog.json", import.meta.url), "utf8"));
const canvasOperations = CATALOG.operations.map((operation) => ({ ...operation, provider: "canvas" }));

function operation(toolName) {
  const value = canvasOperations.find((entry) => entry.toolName === toolName);
  assert.ok(value, `missing Canvas operation ${toolName}`);
  return value;
}

// The worker redacts bearer secrets from session-credential results before they are handed back.
// The region runs here with the real admission classifier, so the test proves the wiring: the
// same classifier that names the operation also triggers the redaction.
function redactor() {
  const start = WORKER_SOURCE.indexOf("function withoutTokenSecretFields(value) {");
  const mid = WORKER_SOURCE.indexOf("function withoutSessionCredentialSecrets(result, operation) {");
  const end = WORKER_SOURCE.indexOf("\n}", mid) + 3;
  assert.ok(start > 0 && mid > start && end > mid, "the credential redaction moved in service-worker.js");
  const body = WORKER_SOURCE.slice(start, end);
  const script = [
    "globalThis.__morrowCredentialRedaction = (() => {",
    "const canvasOperationAdmission = globalThis.__morrowRealAdmission;",
    body,
    "return { withoutSessionCredentialSecrets };",
    "})();",
  ].join("\n");
  globalThis.__morrowRealAdmission = canvasOperationAdmission;
  try {
    runInThisContext(script, { filename: "service-worker-credential-region.js" });
    const value = globalThis.__morrowCredentialRedaction;
    delete globalThis.__morrowCredentialRedaction;
    return value;
  } finally {
    delete globalThis.__morrowRealAdmission;
  }
}

test("minting an access token is a session-credential request with no readback, approved change by change", () => {
  const create = operation("canvas_create_access_token");
  assert.equal(canvasOperationAdmission(create).siteClass, "session_credential");
  assert.deepEqual(canvasReadbackAssessment(canvasOperations, create), { state: "unavailable", reason: "no_safe_readback_route" });
  const option = categoriesForBinding({ provider: "canvas" }, canvasOperations)
    .find((entry) => entry.id === "action:canvas:canvas_create_access_token");
  assert.equal(option.availability, "review");
  assert.match(option.reviewReason, /Canvas has no read that shows the saved result of this change/);
  assert.match(option.description, /keeps any credential Canvas returns out of the result/);
});

test("a minted bearer secret never reaches a result handed back", () => {
  const { withoutSessionCredentialSecrets } = redactor();
  const minted = {
    ok: true,
    data: {
      id: "9", user_id: "7", purpose: "morrow", expires_at: null,
      token: "1~Op9a2wX0H6pQ bearer secret",
      nested: { token: "nested secret", id: "9" },
      list: [{ token: "listed secret" }, { id: "1" }],
    },
  };
  for (const toolName of ["canvas_create_access_token", "canvas_create_jwt", "canvas_refresh_jwt"]) {
    const redacted = withoutSessionCredentialSecrets(minted, operation(toolName));
    assert.equal(JSON.stringify(redacted).includes("secret"), false, toolName);
    assert.equal(redacted.data.id, "9", toolName);
    assert.deepEqual(redacted.data.nested, { id: "9" }, toolName);
    assert.deepEqual(redacted.data.list, [{}, { id: "1" }], toolName);
  }
});

test("redaction touches only session-credential results", () => {
  const { withoutSessionCredentialSecrets } = redactor();
  const data = { id: "9", token: "not-a-credential-context" };
  const kept = withoutSessionCredentialSecrets({ ok: true, data }, operation("canvas_create_assignment"));
  assert.equal(kept.data.token, "not-a-credential-context");
  const moodle = withoutSessionCredentialSecrets({ ok: true, data }, { provider: "moodle", toolName: "moodle_update_assignment" });
  assert.equal(moodle.data.token, "not-a-credential-context");
  const noData = withoutSessionCredentialSecrets({ ok: false, error: "x" }, operation("canvas_create_access_token"));
  assert.deepEqual(noData, { ok: false, error: "x" });
});
