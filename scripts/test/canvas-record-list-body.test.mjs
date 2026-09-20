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

// Canvas types a list of records as [Model], which the generic catalog mapper
// flattens to an array of strings. A record cannot be rebuilt from that shape,
// so applyRecordListWriteParameters() declares the fields each route reads.
test("the record list writes declare the record fields their route reads", () => {
  const declared = new Map([
    ["canvas_batch_create_overrides_in_course", { wireName: "assignment_overrides", required: ["assignment_id"] }],
    ["canvas_batch_update_overrides_in_course", { wireName: "assignment_overrides", required: ["assignment_id", "id"] }],
    ["canvas_update_module_s_overrides", { wireName: "overrides", required: undefined }],
    ["canvas_bulk_update_column_data", { wireName: "column_data", required: ["column_id", "content", "user_id"] }],
  ]);
  for (const [toolName, expected] of declared) {
    const operation = catalogOperation(toolName);
    const parameter = operation.parameters.find((entry) => entry.wireName === expected.wireName);
    assert.ok(parameter, `${toolName} no longer documents ${expected.wireName}`);
    assert.equal(parameter.schema.type, "array", toolName);
    assert.equal(parameter.schema.items.type, "object", toolName);
    assert.equal(parameter.schema.items.additionalProperties, false, toolName);
    assert.deepEqual(parameter.schema.items.required, expected.required, toolName);
    assert.equal(operation.inputSchema.properties[parameter.inputName].items.type, "object", toolName);
  }
  const overrideFields = catalogOperation("canvas_batch_update_overrides_in_course")
    .parameters.find((entry) => entry.wireName === "assignment_overrides").schema.items.properties;
  assert.deepEqual(Object.keys(overrideFields).sort(), [
    "assignment_id", "course_section_id", "due_at", "group_id", "id", "lock_at", "student_ids", "title", "unlock_at",
  ]);
  const moduleFields = catalogOperation("canvas_update_module_s_overrides")
    .parameters.find((entry) => entry.wireName === "overrides").schema.items.properties;
  assert.deepEqual(Object.keys(moduleFields).sort(), ["course_section_id", "group_id", "id", "student_ids", "title"]);
});

// The shipped catalog is generator output, so the rule and the catalog must agree.
test("the shipped catalog carries exactly what the generator rule declares", async () => {
  const { applyRecordListWriteParameters } = await import("../generate-canvas-api-catalog.mjs");
  const operations = JSON.parse(JSON.stringify(CATALOG.operations));
  applyRecordListWriteParameters(operations);
  assert.deepEqual(operations, CATALOG.operations);
});

test("a batch override create reaches Canvas as whole override records", async () => {
  const sent = await sendWrite(
    "canvas_batch_create_overrides_in_course",
    {
      course_id: "42",
      assignment_overrides: [
        { assignment_id: "77", course_section_id: "5", due_at: "2026-10-21T18:48:00Z" },
        { assignment_id: "78", student_ids: ["9", "11"], title: "Extension" },
      ],
    },
    [{ id: 512, assignment_id: 77 }],
  );
  assert.equal(sent.length, 1);
  assert.deepEqual([...new URLSearchParams(sent[0])], [
    ["assignment_overrides[][assignment_id]", "77"],
    ["assignment_overrides[][course_section_id]", "5"],
    ["assignment_overrides[][due_at]", "2026-10-21T18:48:00Z"],
    ["assignment_overrides[][assignment_id]", "78"],
    ["assignment_overrides[][student_ids][]", "9"],
    ["assignment_overrides[][student_ids][]", "11"],
    ["assignment_overrides[][title]", "Extension"],
  ]);
});

test("a bulk custom column update reaches Canvas as whole datum records", async () => {
  const sent = await sendWrite(
    "canvas_bulk_update_column_data",
    {
      course_id: "42",
      column_data: [
        { column_id: "3", user_id: "9", content: "Nut allergy" },
        { column_id: "3", user_id: "11", content: "" },
      ],
    },
    { id: 1, workflow_state: "queued" },
  );
  assert.equal(sent.length, 1);
  assert.deepEqual([...new URLSearchParams(sent[0])], [
    ["column_data[][column_id]", "3"],
    ["column_data[][user_id]", "9"],
    ["column_data[][content]", "Nut allergy"],
    ["column_data[][column_id]", "3"],
    ["column_data[][user_id]", "11"],
    ["column_data[][content]", ""],
  ]);
});
