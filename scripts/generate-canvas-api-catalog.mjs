#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = "https://canvas.instructure.com/doc/api/";
const INDEX_URL = `${ROOT}api-docs.json`;
const DEFAULT_OUTPUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../artifacts/canvas-api/canvas-api-catalog.json",
);
const DEFAULT_MIRRORS = [
  resolve(dirname(fileURLToPath(import.meta.url)), "../connector/extension/generated/canvas-api-catalog.json"),
];

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("The Canvas specification contains a non-finite number.");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") throw new TypeError("The Canvas specification contains a non-JSON value.");
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function ascii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function cleanText(value, maximum = 4_000) {
  return String(value || "").replace(/\u2014/g, ":").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function safeName(value) {
  const parts = String(value || "")
    .replace(/\[([^\]]*)\]/g, "__$1")
    .replace(/[<>*:.\-/]+/g, "_")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return (/^[a-z_]/.test(parts) ? parts : `value_${parts || "parameter"}`).slice(0, 96);
}

function pathSlug(path) {
  return String(path)
    .replace(/[{}]/g, "")
    .split("/")
    .filter(Boolean)
    .slice(-4)
    .map(safeName)
    .filter(Boolean)
    .join("_")
    .slice(0, 54);
}

function schemaType(parameter) {
  const type = String(parameter.type || "").toLowerCase();
  const format = String(parameter.format || "").toLowerCase();
  if (parameter.name === "url_or_id") return { type: "string", minLength: 1, maxLength: 1000 };
  if (format === "int64" || /(?:^|_)id$/.test(parameter.name) || /\[(?:\w+_)?id\]$/.test(parameter.name)) {
    return { type: "string", pattern: "^[1-9][0-9]*$" };
  }
  if (["integer", "positive integer"].includes(type)) return { type: "integer" };
  if (["number", "numeric"].includes(type)) return { type: "number" };
  if (type === "boolean") return { type: "boolean" };
  if (["array", "string[]"].includes(type) || type.startsWith("multiple ") || /^\[.+\]$/.test(type)) {
    const itemType = String(parameter.items?.type || "string").toLowerCase();
    return { type: "array", items: itemType === "integer" ? { type: "integer" } : { type: "string" } };
  }
  if (["hash", "object", "json", "serializedhash", "lticonfigurationoverlay", "blueprintrestriction"].includes(type)) {
    return { type: "object", additionalProperties: true };
  }
  if (type === "file") {
    return {
      type: "object",
      format: "binary",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 255 },
        type: { type: "string", maxLength: 200 },
        base64: { type: "string", minLength: 1 },
      },
      required: ["name", "base64"],
      additionalProperties: false,
    };
  }
  return { type: "string" };
}

function parameterRecords(parameters) {
  const used = new Set();
  return (parameters || []).map((parameter) => {
    const base = safeName(parameter.name);
    let inputName = base;
    if (used.has(inputName)) inputName = `${base}_${sha256(`${parameter.paramType}\0${parameter.name}`).slice(0, 8)}`;
    used.add(inputName);
    return {
      inputName,
      wireName: String(parameter.name),
      location: parameter.paramType,
      required: parameter.required === true,
      deprecated: parameter.deprecated === true,
      schema: {
        ...schemaType(parameter),
        ...(cleanText(parameter.description) && cleanText(parameter.description) !== "no description"
          ? { description: cleanText(parameter.description) }
          : {}),
      },
    };
  }).sort((left, right) => ascii(left.inputName, right.inputName));
}

function inputSchema(parameters, readOnly = false) {
  return {
    type: "object",
    properties: {
      ...Object.fromEntries(parameters.map((parameter) => [parameter.inputName, parameter.schema])),
      ...(readOnly ? {
        morrow_max_pages: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          default: 25,
          description: "Maximum Canvas Link-header pages to load for this read.",
        },
      } : {}),
    },
    required: parameters.filter((parameter) => parameter.required).map((parameter) => parameter.inputName).sort(ascii),
    additionalProperties: false,
  };
}

function bulkAssignmentDatesParameter() {
  return {
    inputName: "assignment_dates",
    wireName: "assignment_dates",
    location: "form",
    required: true,
    deprecated: false,
    schema: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      description: "The exact AssignmentDate updates. Morrow sends this value as the documented raw JSON request array, then verifies every requested assignment and date.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "all_dates"],
        properties: {
          id: { type: "string", pattern: "^[1-9][0-9]*$" },
          all_dates: {
            type: "array",
            minItems: 1,
            maxItems: 200,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", pattern: "^[1-9][0-9]*$" },
                base: { type: "boolean" },
                due_at: { type: ["string", "null"] },
                unlock_at: { type: ["string", "null"] },
                lock_at: { type: ["string", "null"] },
              },
              oneOf: [
                { required: ["base"], properties: { base: { const: true } } },
                { required: ["id"] },
              ],
              anyOf: [
                { required: ["due_at"] },
                { required: ["unlock_at"] },
                { required: ["lock_at"] },
              ],
            },
          },
        },
      },
    },
  };
}

// The Canvas specification types question[answers] as [Answer], which the generic
// mapper flattens to an array of strings. No question payload can be rebuilt from
// that shape. The fields are the documented Answer model, plus answer_html, which
// the Canvas multiple-choice and multiple-answers answer parsers read as the HTML
// answer body. docs/implementation/CATALOG-RECONCILIATION.md records each source.
function classicQuizAnswersParameter(parameter) {
  return {
    ...parameter,
    schema: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      description: "The exact answers for this Classic Quiz question. Morrow sends each answer as indexed question[answers][n][field] form fields, starting at 0. Supported question types: multiple_choice_question, true_false_question, multiple_answers_question, short_answer_question, essay_question.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["answer_text", "answer_weight"],
        properties: {
          id: { type: "string", pattern: "^[1-9][0-9]*$" },
          answer_text: { type: "string", maxLength: 16_384 },
          answer_weight: { type: "integer", minimum: 0, maximum: 100 },
          answer_comments: { type: "string", maxLength: 16_384 },
          answer_html: { type: "string", maxLength: 16_384 },
          text_after_answers: { type: "string", maxLength: 16_384 },
        },
      },
    },
  };
}

// The New Quizzes model describes IP ranges as pairs and these settings as
// nullable. Swagger's scalar parameter types lose both parts of that contract.
// https://developerdocs.instructure.com/services/canvas/resources/new_quizzes
function newQuizSettingsParameter(parameter) {
  if (parameter.location !== "form") return parameter;
  const allowed = new Map([
    ["quiz_report[report_type]", ["student_analysis", "item_analysis"]],
    ["quiz_report[format]", ["csv", "json"]],
    ["quiz[grading_type]", ["pass_fail", "percent", "letter_grade", "gpa_scale", "points"]],
    ["quiz[quiz_settings][calculator_type]", [null, "none", "basic", "scientific"]],
    ["quiz[quiz_settings][multiple_attempts][score_to_keep]", ["average", "first", "highest", "latest"]],
    ["quiz[quiz_settings][one_at_a_time_type]", ["none", "question"]],
    ["quiz[quiz_settings][result_view_settings][display_item_response_qualifier]", ["always", "once_per_attempt", "after_last_attempt", "once_after_last_attempt"]],
    ["quiz[quiz_settings][result_view_settings][display_item_response_correctness_qualifier]", ["always", "after_last_attempt"]],
    ["item[entry_type]", ["Item"]],
    ["item[entry][calculator_type]", ["none", "basic", "scientific"]],
    ["item[entry][interaction_type_slug]", ["multi-answer", "matching", "categorization", "file-upload", "formula", "ordering", "rich-fill-blank", "hot-spot", "choice", "numeric", "true-false", "essay"]],
  ]);
  if (["extra_time", "extra_attempts"].includes(parameter.wireName)) {
    const maximum = parameter.wireName === "extra_time" ? { maximum: 10_080 } : {};
    return { ...parameter, schema: { description: parameter.schema.description, type: "integer", minimum: 0, ...maximum } };
  }
  const positive = new Set([
    "quiz[points_possible]",
    "quiz[quiz_settings][session_time_limit_in_seconds]",
    "quiz[quiz_settings][multiple_attempts][max_attempts]",
    "quiz[quiz_settings][multiple_attempts][cooling_period_seconds]",
    "item[points_possible]",
  ]);
  if (parameter.wireName === "item[position]") {
    const { pattern: _pattern, ...positionSchema } = parameter.schema;
    return { ...parameter, schema: { ...positionSchema, type: "integer", exclusiveMinimum: 0 } };
  }
  const dateTimes = new Set([
    "quiz[due_at]", "quiz[lock_at]", "quiz[unlock_at]",
    "quiz[quiz_settings][result_view_settings][show_item_responses_at]",
    "quiz[quiz_settings][result_view_settings][hide_item_responses_at]",
    "quiz[quiz_settings][result_view_settings][show_item_response_correctness_at]",
    "quiz[quiz_settings][result_view_settings][hide_item_response_correctness_at]",
  ]);
  const nullable = new Set([
    "quiz[quiz_settings][calculator_type]",
    "quiz[quiz_settings][student_access_code]",
    "quiz[quiz_settings][session_time_limit_in_seconds]",
    "quiz[quiz_settings][multiple_attempts][max_attempts]",
    "quiz[quiz_settings][multiple_attempts][cooling_period_seconds]",
    "quiz[quiz_settings][result_view_settings][show_item_responses_at]",
    "quiz[quiz_settings][result_view_settings][hide_item_responses_at]",
    "quiz[quiz_settings][result_view_settings][show_item_response_correctness_at]",
    "quiz[quiz_settings][result_view_settings][hide_item_response_correctness_at]",
  ]);
  if (["quiz[quiz_settings][filters][ips]", "quiz[quiz_settings][filters][ips][]"].includes(parameter.wireName)) {
    return {
      ...parameter,
      schema: {
        ...parameter.schema,
        type: ["array", "null"],
        items: { type: "array", minItems: 2, maxItems: 2, items: { type: "string" } },
      },
    };
  }
  let schema = parameter.schema;
  if (nullable.has(parameter.wireName)) schema = { ...schema, type: [schema.type, "null"] };
  if (allowed.has(parameter.wireName)) schema = { ...schema, enum: [...allowed.get(parameter.wireName)] };
  if (positive.has(parameter.wireName)) schema = { ...schema, exclusiveMinimum: 0 };
  if (dateTimes.has(parameter.wireName)) schema = { ...schema, format: "date-time" };
  return schema === parameter.schema ? parameter : { ...parameter, schema };
}

function createModuleItemInputSchema(parameters) {
  return {
    ...inputSchema(parameters),
    allOf: [
      {
        if: { properties: { module_item_type: { const: "Page" } }, required: ["module_item_type"] },
        then: { required: ["module_item_page_url"] },
      },
      {
        if: { properties: { module_item_type: { enum: ["ExternalUrl", "ExternalTool"] } }, required: ["module_item_type"] },
        then: { required: ["module_item_external_url"] },
      },
      {
        if: {
          properties: { module_item_type: { not: { enum: ["ExternalUrl", "Page", "SubHeader"] } } },
          required: ["module_item_type"],
        },
        then: { required: ["module_item_content_id"] },
      },
    ],
  };
}

function riskFor(method, path, nickname) {
  if (method === "GET") return "read";
  const text = `${path} ${nickname}`.toLowerCase();
  if (method === "DELETE" || /(?:destroy|delete|remove|conclude|deactivate|reset|unpublish|archive)/.test(text)) {
    return "destructive";
  }
  if (/(?:grade|score|submission|enroll|user|account|blueprint|moderated)/.test(text)) return "sensitive_write";
  return "write";
}

function operationFamily(resource, path) {
  if (/\/quiz\/v1\//.test(path)) return "new-quizzes";
  return safeName(resource) || "canvas-api";
}

function assignToolNames(operations) {
  const groups = new Map();
  for (const operation of operations) {
    const base = `canvas_${safeName(operation.nickname)}`.slice(0, 112);
    const group = groups.get(base) || [];
    group.push(operation);
    groups.set(base, group);
  }
  for (const [base, group] of groups) {
    group.sort((left, right) => ascii(left.key, right.key));
    for (const operation of group) {
      const suffix = group.length === 1 ? "" : `_${pathSlug(operation.path)}_${operation.method.toLowerCase()}`;
      const candidate = `${base.slice(0, Math.max(1, 128 - suffix.length))}${suffix}`;
      operation.toolName = candidate.length <= 128 ? candidate : `${base.slice(0, 119)}_${sha256(operation.key).slice(0, 8)}`;
    }
  }
  const names = new Set();
  for (const operation of operations) {
    if (names.has(operation.toolName)) operation.toolName = `${operation.toolName.slice(0, 119)}_${sha256(operation.key).slice(0, 8)}`;
    if (names.has(operation.toolName)) throw new Error(`Tool-name collision for ${operation.key}`);
    names.add(operation.toolName);
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Canvas documentation returned HTTP ${response.status} for ${url}`);
  return { value: await response.json(), lastModified: response.headers.get("last-modified") || null };
}

async function mapConcurrent(values, concurrency, mapper) {
  const result = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      result[index] = await mapper(values[index], index);
    }
  }));
  return result;
}

function normalizeOfficialOperation(resource, api, rawOperation) {
  const method = String(rawOperation.method || "").toUpperCase();
  const path = String(api.path || "");
  const nickname = String(rawOperation.nickname || "");
  const createModuleItem = method === "POST"
    && path === "/v1/courses/{course_id}/modules/{module_id}/items"
    && nickname === "create_module_item";
  const bulkAssignmentDates = method === "PUT"
    && path === "/v1/courses/{course_id}/assignments/bulk_update"
    && nickname === "bulk_update_assignment_dates";
  const parameters = parameterRecords(rawOperation.parameters).map((parameter) => (
    createModuleItem && parameter.wireName === "module_item[content_id]"
      ? { ...parameter, required: false }
      : path.startsWith("/quiz/v1/") ? newQuizSettingsParameter(parameter) : parameter
  ));
  const inputParameters = [
    ...parameters,
    ...(bulkAssignmentDates ? [bulkAssignmentDatesParameter()] : []),
  ].sort((left, right) => ascii(left.inputName, right.inputName));
  const risk = riskFor(method, path, nickname);
  return {
    key: `${method} ${path}#${nickname}`,
    toolName: "",
    source: "canvas-official-swagger-1.2",
    service: "canvas",
    resource,
    family: operationFamily(resource, path),
    nickname,
    method,
    path,
    summary: cleanText(rawOperation.summary || api.description || nickname, 500),
    description: cleanText(rawOperation.notes || rawOperation.summary || api.description || nickname),
    deprecated: rawOperation.deprecated === true,
    risk,
    readOnly: method === "GET",
    parameters,
    inputSchema: createModuleItem ? createModuleItemInputSchema(parameters) : inputSchema(inputParameters, method === "GET"),
    responseType: cleanText(rawOperation.type || "object", 200),
  };
}

function itemBankOperation({ name, method, path, summary, parameters, destructive = false, note = "" }) {
  // Declared values stay here rather than in schemaType: the official Canvas
  // specification carries its own enum lists, and honouring those in the shared
  // mapper would change every official operation schema.
  const allowedValues = new Map((parameters || [])
    .filter((parameter) => Array.isArray(parameter.enum) && parameter.enum.length > 0)
    .map((parameter) => [String(parameter.name), parameter.enum]));
  const normalized = parameterRecords(parameters).map((parameter) => (
    allowedValues.has(parameter.wireName)
      ? { ...parameter, schema: { ...parameter.schema, enum: [...allowedValues.get(parameter.wireName)] } }
      : parameter
  ));
  return {
    // Several verified Item Bank actions share one private route. The nickname
    // keeps every operation addressable in admission and recovery tables.
    key: `ITEM_BANK ${method} ${path}#${name}`,
    toolName: `canvas_item_bank_${name}`,
    source: "morrow-clean-browser-session-contract",
    service: "item_bank",
    resource: "New Quizzes Item Banks",
    family: "new-quizzes-item-banks",
    nickname: name,
    method,
    path,
    summary,
    description: `${summary} Uses the signed-in New Quizzes Item Banks browser session. Credentials remain inside the browser page.${note ? ` ${note}` : ""}`,
    deprecated: false,
    risk: method === "GET" ? "read" : destructive ? "destructive" : "sensitive_write",
    readOnly: method === "GET",
    parameters: normalized,
    inputSchema: inputSchema(normalized, method === "GET"),
    responseType: "object",
  };
}

const id = (name, required = true) => ({ paramType: "path", name, type: "string", format: "int64", required });
const form = (name, type = "string", required = false) => ({ paramType: "form", name, type, required });
const enumForm = (name, values, required = false) => ({ paramType: "form", name, type: "string", enum: values, required });
const controlId = (name) => ({ paramType: "control", name, type: "string", format: "int64", required: true });
const itemBankSnapshot = () => ({ paramType: "control", name: "expected_snapshot", type: "object", required: true });
const itemBankFanOut = () => ({
  paramType: "control", name: "fan_out", type: "object", required: true,
  description: "Fresh observed Item Bank reach record from morrow_read_item_bank_fan_out. It reports observed courses and unread sources and does not claim account-wide completeness.",
});
const itemBankAcknowledgement = () => ({
  paramType: "control", name: "acknowledged_course_ids", type: "string[]", required: true,
  description: "Exact sorted list of observed external numeric Canvas course ids in fan_out.external_course_ids. An empty observed list requires an empty array.",
});
const itemBankFanOutReceipt = () => ({
  paramType: "control", name: "fan_out_receipt", type: "string", required: true,
  description: "Process-local receipt proving the exact fan_out record came from morrow_read_item_bank_fan_out for this selected course connection.",
});
const itemBankImpact = () => [itemBankFanOut(), itemBankFanOutReceipt(), itemBankAcknowledgement()];

function itemBankOperations() {
  return [
    itemBankOperation({ name: "list_banks", method: "GET", path: "/api/banks", summary: "List New Quizzes item banks associated with one selected course.", parameters: [form("course_id", "string", true), form("page", "integer"), form("per_page", "integer")] }),
    itemBankOperation({ name: "get_bank", method: "GET", path: "/api/banks/{bank_id}", summary: "Get one New Quizzes item bank associated with the selected course.", parameters: [id("bank_id"), controlId("course_id")] }),
    itemBankOperation({ name: "list_entries", method: "GET", path: "/api/banks/{bank_id}/bank_entries", summary: "List entries in one New Quizzes item bank associated with the selected course.", parameters: [id("bank_id"), controlId("course_id"), form("page", "integer"), form("per_page", "integer")] }),
    itemBankOperation({ name: "get_entry", method: "GET", path: "/api/banks/{bank_id}/bank_entries/{bank_entry_id}", summary: "Get one entry from a New Quizzes item bank associated with the selected course.", parameters: [id("bank_id"), id("bank_entry_id"), controlId("course_id")] }),
    itemBankOperation({ name: "list_shares", method: "GET", path: "/api/banks/{bank_id}/shared_banks", summary: "Read one observed page of contexts that can use one New Quizzes item bank associated with the selected course.", parameters: [id("bank_id"), controlId("course_id")], note: "Canvas Item Bank share pagination is not established. This read makes one unpaged request and always reports the collection as incomplete." }),
    itemBankOperation({ name: "create_bank", method: "POST", path: "/api/banks", summary: "Create a New Quizzes item bank.", parameters: [controlId("course_id"), form("title", "string", true), form("language", "string"), itemBankSnapshot()] }),
    itemBankOperation({ name: "rename_bank", method: "PATCH", path: "/api/banks/{bank_id}", summary: "Rename a New Quizzes item bank.", parameters: [id("bank_id"), controlId("course_id"), form("title", "string", true), itemBankSnapshot(), ...itemBankImpact()] }),
    itemBankOperation({ name: "archive_bank", method: "DELETE", path: "/api/banks/{bank_id}", summary: "Delete one exact New Quizzes item bank.", parameters: [id("bank_id"), controlId("course_id"), itemBankSnapshot(), ...itemBankImpact()], destructive: true, note: "The retained tool name uses archive for compatibility, but ExamplePlatform's proven route is DELETE and its saved-state result is bank absence. The review shows observed downstream courses and unread reach sources." }),
    itemBankOperation({ name: "attach_item", method: "POST", path: "/api/banks/{bank_id}/bank_entries", summary: "Attach an existing New Quizzes item to an item bank.", parameters: [id("bank_id"), controlId("course_id"), form("item_id", "string", true), itemBankSnapshot(), ...itemBankImpact()] }),
    itemBankOperation({ name: "create_item", method: "POST", path: "/api/banks/{bank_id}/items", summary: "Create a standalone New Quizzes item for an item bank.", parameters: [id("bank_id"), controlId("course_id"), form("item", "object", true), itemBankSnapshot(), ...itemBankImpact()], note: "This creates a standalone item. A separately reviewed attach_item operation adds it to the bank entries. The response id is read back exactly. A lost response cannot be reconciled without an item id because this private service exposes no standalone-item listing route." }),
    itemBankOperation({ name: "get_item", method: "GET", path: "/api/banks/{bank_id}/items/{item_id}", summary: "Get one item from a New Quizzes item bank associated with the selected course.", parameters: [id("bank_id"), id("item_id"), controlId("course_id")] }),
    itemBankOperation({ name: "update_item", method: "PATCH", path: "/api/banks/{bank_id}/items/{item_id}", summary: "Update a New Quizzes item-bank item.", parameters: [id("bank_id"), id("item_id"), controlId("course_id"), form("item", "object", true), itemBankSnapshot(), ...itemBankImpact()] }),
    itemBankOperation({ name: "delete_entry", method: "DELETE", path: "/api/banks/{bank_id}/bank_entries/{bank_entry_id}", summary: "Delete an entry from a New Quizzes item bank.", parameters: [id("bank_id"), id("bank_entry_id"), controlId("course_id"), itemBankSnapshot(), ...itemBankImpact()], destructive: true, note: "This removes the entry's association with the bank. It does not delete the standalone item object or the bank." }),
    itemBankOperation({ name: "share_bank", method: "POST", path: "/api/banks/{bank_id}/shared_banks", summary: "Share a New Quizzes item bank with one exact Canvas course.", parameters: [id("bank_id"), controlId("course_id"), enumForm("entity_type", ["course"], true), form("entity_id", "string", true), enumForm("permission", ["read"]), itemBankSnapshot(), ...itemBankImpact()], note: "Only the course entity type and the read permission are verified. Share update and removal stay absent because no exact route contract is established." }),
    itemBankOperation({ name: "list_quiz_draws", method: "GET", path: "/api/quizzes/{builder_quiz_id}/quiz_entries", summary: "List the Item Bank draw groups in one exact New Quiz assignment.", parameters: [controlId("course_id"), controlId("assignment_id")], note: "Morrow derives the private quiz id from the selected assignment's fresh New Quiz builder launch. The assignment-bound builder credential remains inside that frame." }),
    itemBankOperation({ name: "attach_bank_to_quiz", method: "POST", path: "/api/quizzes/{builder_quiz_id}/quiz_entries", summary: "Attach an Item Bank to one exact New Quiz as a random draw or as every item in the bank.", parameters: [controlId("course_id"), controlId("assignment_id"), form("bank_id", "string", true), form("pick_count", "integer"), form("points_per_item", "number", true), form("position", "integer", true), itemBankSnapshot(), ...itemBankImpact()], note: "Morrow derives the private quiz id from the selected assignment's fresh New Quiz builder launch. The fixed Bank payload sets the source bank, points per item, and position. A pick count sets the random draw size as ItemProperties sample_num. Omitting it sends the documented all-items value, sample_num null, and the readback requires that exact saved value." }),
    itemBankOperation({ name: "attach_bank_entry_to_quiz", method: "POST", path: "/api/quizzes/{builder_quiz_id}/quiz_entries", summary: "Attach one exact Item Bank entry to one exact New Quiz.", parameters: [controlId("course_id"), controlId("assignment_id"), form("bank_id", "string", true), form("bank_entry_id", "string", true), form("points_per_item", "number", true), form("position", "integer", true), itemBankSnapshot(), ...itemBankImpact()], note: "The fixed BankEntry payload names the exact bank-entry row, points, and position. Morrow verifies that row in the selected bank before opening the assignment-bound builder." }),
    itemBankOperation({ name: "delete_quiz_bank_entry", method: "DELETE", path: "/api/quizzes/{builder_quiz_id}/quiz_entries/{quiz_entry_id}", summary: "Remove one exact Item Bank draw or BankEntry row from one exact New Quiz.", parameters: [controlId("course_id"), controlId("assignment_id"), form("bank_id", "string", true), form("bank_entry_id", "string"), id("quiz_entry_id"), itemBankSnapshot(), ...itemBankImpact()], destructive: true, note: "ExamplePlatform production automation uses this exact builder route and verifies an empty re-list after clearing a quiz. Morrow still requires attended disposable-tenant proof. The complete pre-write list binds the exact row; a BankEntry row also requires its exact bank entry snapshot." }),
  ];
}

function courseFileTextOperation() {
  const parameters = parameterRecords([id("course_id"), id("file_id")]);
  return {
    key: "CANVAS_COURSE_FILE_TEXT GET /v1/courses/{course_id}/files/{file_id}/text",
    toolName: "canvas_read_course_file_text",
    source: "morrow-privileged-canvas-file-content-contract",
    service: "course_file_content",
    resource: "Canvas Course Files",
    family: "files",
    nickname: "read_course_file_text",
    method: "GET",
    path: "/v1/courses/{course_id}/files/{file_id}/text",
    summary: "Read one confirmed text course file.",
    description: "Read one UTF-8 text, HTML, or XHTML Canvas course file after a fresh course-scoped file check. This requires the user's separate HTTPS file-reading permission and never sends browser credentials to the file storage host.",
    deprecated: false,
    risk: "read",
    readOnly: true,
    parameters,
    inputSchema: inputSchema(parameters),
    responseType: "CanvasCourseFileText",
  };
}

function applyCustomGradebookColumnUpdateParameters(operations) {
  const create = operations.find((operation) => (
    operation.method === "POST"
    && operation.path === "/v1/courses/{course_id}/custom_gradebook_columns"
    && operation.nickname === "create_custom_gradebook_column"
  ));
  const update = operations.find((operation) => (
    operation.method === "PUT"
    && operation.path === "/v1/courses/{course_id}/custom_gradebook_columns/{id}"
    && operation.nickname === "update_custom_gradebook_column"
  ));
  if (!create || !update) throw new Error("Canvas custom Gradebook Column create/update operations are required.");

  const inherited = create.parameters
    .filter((parameter) => parameter.location === "form" && parameter.wireName.startsWith("column["))
    .map((parameter) => ({ ...parameter, required: false }));
  const expectedWireNames = ["column[title]", "column[position]", "column[hidden]", "column[teacher_notes]", "column[read_only]"];
  if (inherited.length !== expectedWireNames.length || expectedWireNames.some((wireName) => !inherited.some((parameter) => parameter.wireName === wireName))) {
    throw new Error("Canvas custom Gradebook Column creation parameters no longer match the documented update contract.");
  }

  const byWireName = new Map(update.parameters.map((parameter) => [parameter.wireName, parameter]));
  for (const parameter of inherited) byWireName.set(parameter.wireName, parameter);
  update.parameters = [...byWireName.values()].sort((left, right) => ascii(left.inputName, right.inputName));
  update.inputSchema = inputSchema(update.parameters);
}

function applyClassicQuizUpdateParameters(operations) {
  const create = operations.find((operation) => (
    operation.method === "POST"
    && operation.path === "/v1/courses/{course_id}/quizzes"
    && operation.nickname === "create_quiz"
  ));
  const update = operations.find((operation) => (
    operation.method === "PUT"
    && operation.path === "/v1/courses/{course_id}/quizzes/{id}"
    && operation.nickname === "edit_quiz"
  ));
  if (!create || !update) throw new Error("Canvas Classic Quiz create/update operations are required.");

  // Canvas's edit contract inherits the create fields and adds notify_of_update.
  // https://developerdocs.instructure.com/services/canvas/resources/quizzes
  const inherited = create.parameters.filter((parameter) => parameter.location === "form")
    .map((parameter) => ({ ...parameter, required: false }));
  if (!inherited.some((parameter) => parameter.wireName === "quiz[title]")) {
    throw new Error("Canvas Classic Quiz creation fields no longer match the documented update contract.");
  }

  const byWireName = new Map(update.parameters.map((parameter) => [parameter.wireName, parameter]));
  for (const parameter of inherited) byWireName.set(parameter.wireName, parameter);
  update.parameters = [...byWireName.values()].sort((left, right) => ascii(left.inputName, right.inputName));
  update.inputSchema = inputSchema(update.parameters);
}

function applyClassicQuizAnswerParameters(operations) {
  const routes = [
    { method: "POST", path: "/v1/courses/{course_id}/quizzes/{quiz_id}/questions", nickname: "create_single_quiz_question" },
    { method: "PUT", path: "/v1/courses/{course_id}/quizzes/{quiz_id}/questions/{id}", nickname: "update_existing_quiz_question" },
  ];
  for (const route of routes) {
    const operation = operations.find((candidate) => (
      candidate.method === route.method && candidate.path === route.path && candidate.nickname === route.nickname
    ));
    if (!operation) throw new Error(`Canvas Classic Quiz question operation ${route.nickname} is required.`);
    const answers = operation.parameters.filter((parameter) => (
      parameter.location === "form" && parameter.wireName === "question[answers]"
    ));
    if (answers.length !== 1 || answers[0].schema.type !== "array") {
      throw new Error(`Canvas Classic Quiz question operation ${route.nickname} no longer documents one question[answers] array.`);
    }
    operation.parameters = operation.parameters.map((parameter) => (
      parameter === answers[0] ? classicQuizAnswersParameter(parameter) : parameter
    ));
    operation.inputSchema = inputSchema(operation.parameters);
  }
}

async function buildCatalog() {
  const indexResult = await fetchJson(INDEX_URL);
  const resources = [...indexResult.value.apis].sort((left, right) => ascii(left.path, right.path));
  const documents = await mapConcurrent(resources, 12, async (resource) => {
    const url = `${ROOT}${String(resource.path).replace(/^\//, "")}`;
    const fetched = await fetchJson(url);
    return { resource, url, ...fetched };
  });
  const official = [];
  for (const document of documents) {
    for (const api of document.value.apis || []) {
      for (const operation of api.operations || []) {
        official.push(normalizeOfficialOperation(document.resource.description, api, operation));
      }
    }
  }
  assignToolNames(official);
  applyCustomGradebookColumnUpdateParameters(official);
  applyClassicQuizUpdateParameters(official);
  applyClassicQuizAnswerParameters(official);
  const itemBank = itemBankOperations();
  const courseFileContent = [courseFileTextOperation()];
  const browser = [...itemBank, ...courseFileContent];
  const operations = [...official, ...browser].sort((left, right) => ascii(left.toolName, right.toolName));
  const sourceDigest = sha256(canonicalJson({
    index: indexResult.value,
    resources: documents.map((document) => ({ path: document.resource.path, value: document.value })),
  }));
  const catalogBase = {
    schema: "morrow.canvas-api-catalog.v1",
    source: {
      indexUrl: INDEX_URL,
      swaggerVersion: String(indexResult.value.swaggerVersion || "1.2"),
      apiVersion: String(indexResult.value.apiVersion || ""),
      resourceCount: resources.length,
      sourceDigest,
      lastModified: indexResult.lastModified,
    },
    counts: {
      officialOperations: official.length,
      browserSessionOperations: browser.length,
      totalOperations: operations.length,
      newQuizzesOperations: operations.filter((operation) => operation.family.startsWith("new-quizzes")).length,
      itemBankOperations: itemBank.length,
      courseFileContentOperations: courseFileContent.length,
      reads: operations.filter((operation) => operation.readOnly).length,
      writes: operations.filter((operation) => !operation.readOnly).length,
    },
    operations,
  };
  return { ...catalogBase, catalogDigest: sha256(canonicalJson(catalogBase)) };
}

const args = new Set(process.argv.slice(2));
const outputArgument = process.argv.find((value) => value.startsWith("--output="));
const outputPath = outputArgument ? resolve(outputArgument.slice("--output=".length)) : DEFAULT_OUTPUT;
const catalog = await buildCatalog();
const bytes = `${canonicalJson(catalog)}\n`;
if (args.has("--check")) {
  const current = await readFile(outputPath, "utf8").catch(() => "");
  if (current !== bytes) {
    process.stderr.write(`Canvas API catalog is stale: ${outputPath}\n`);
    process.exitCode = 1;
  }
} else {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes, "utf8");
  if (!outputArgument) {
    for (const mirror of DEFAULT_MIRRORS) {
      await mkdir(dirname(mirror), { recursive: true });
      await writeFile(mirror, bytes, "utf8");
    }
  }
}
process.stdout.write(`${JSON.stringify({ path: outputPath, digest: catalog.catalogDigest, ...catalog.counts })}\n`);
