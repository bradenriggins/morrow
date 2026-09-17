// Canvas reads a list of records from a form one record at a time. Morrow takes
// those records as one array per field, so the executor has to write them back
// interleaved: every field of the first record, then every field of the second.
// Written field by field instead, Rails reads `name, name, value, value` as
// three records rather than two, and the change Canvas saves is not the change
// the person reviewed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInThisContext } from "node:vm";
import { canvasOperationAdmission } from "../../connector/extension/generated/canvas-operation-admission.js";

const ORIGIN = "https://school.instructure.com";
const CONTENT_SOURCE = readFileSync(new URL("../../connector/extension/src/canvas-content.js", import.meta.url), "utf8");
const CATALOG = JSON.parse(readFileSync(new URL("../../artifacts/canvas-api/canvas-api-catalog.json", import.meta.url), "utf8"));

function catalogOperation(toolName) {
  const operation = CATALOG.operations.find((entry) => entry.toolName === toolName);
  assert.ok(operation, `missing Canvas operation ${toolName}`);
  const admission = canvasOperationAdmission(operation);
  return { ...operation, morrowCourseTarget: admission.courseTarget, morrowAuthority: admission.authority };
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

async function sendWrite(toolName, args, saved) {
  const keys = ["location", "document", "fetch", "chrome", "__morrowCanvasConnectorInstalled"];
  const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const operation = catalogOperation(toolName);
  const sent = [];
  const listeners = [];
  const values = {
    location: { origin: ORIGIN, protocol: "https:", pathname: "/courses/42/assignments" },
    document: { cookie: "_csrf_token=csrf-value; _legacy_normandy_session=session" },
    fetch: async (input, options = {}) => {
      const url = new URL(String(input?.href ?? input), ORIGIN);
      if (url.pathname === "/api/v1/users/self/profile") return jsonResponse({ id: "7", name: "Teacher" });
      if (url.pathname === "/api/v1/courses/42") return jsonResponse({ id: "42", name: "Biology" });
      if ((options.method || "GET") !== "GET") sent.push(String(options.body ?? ""));
      return jsonResponse(saved);
    },
    chrome: { runtime: { onMessage: { addListener: (listener) => listeners.push(listener) } } },
    __morrowCanvasConnectorInstalled: undefined,
  };
  try {
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    delete globalThis.__morrowCanvasConnectorInstalled;
    runInThisContext(CONTENT_SOURCE, { filename: "canvas-content.js" });
    await new Promise((resolve, reject) => {
      const handled = listeners[0]({
        type: "morrow_canvas_execute",
        operation,
        arguments: args,
        principalId: "7",
        expiresAt: Date.now() + 60_000,
        courseId: "42",
      }, null, resolve);
      if (handled !== true) reject(new Error("the content script did not accept the execute message"));
    });
    return sent;
  } finally {
    for (const key of keys) {
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test("a two-entry grading scheme reaches Canvas as two whole records", async () => {
  const sent = await sendWrite(
    "canvas_create_new_grading_standard_courses",
    { course_id: "42", title: "Scheme", grading_scheme_entry_name: ["A", "F"], grading_scheme_entry_value: [90, 0] },
    { id: 7, title: "Scheme" },
  );
  assert.equal(sent.length, 1);
  const pairs = [...new URLSearchParams(sent[0])].filter(([name]) => name.startsWith("grading_scheme_entry"));
  assert.deepEqual(pairs, [
    ["grading_scheme_entry[][name]", "A"],
    ["grading_scheme_entry[][value]", "90"],
    ["grading_scheme_entry[][name]", "F"],
    ["grading_scheme_entry[][value]", "0"],
  ]);
});
