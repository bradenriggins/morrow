import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInThisContext } from "node:vm";
import { canvasOperationAdmission } from "../../connector/extension/generated/canvas-operation-admission.js";

const ORIGIN = "https://school.instructure.com";
const COURSE_ID = "42";
const QUIZ_ID = "77";
const ITEM_ID = "88";
const CREATED_ID = "99";
const ITEMS_PATH = `/api/quiz/v1/courses/${COURSE_ID}/quizzes/${QUIZ_ID}/items`;
const CONTENT_SOURCE = readFileSync(new URL("../../connector/extension/src/canvas-content.js", import.meta.url), "utf8");
const CATALOG = JSON.parse(readFileSync(new URL("../../artifacts/canvas-api/canvas-api-catalog.json", import.meta.url), "utf8"));

const ESSAY_PAYLOAD = {
  entry_type: "Item",
  points_possible: 2,
  position: 1,
  entry: {
    item_body: "<p>Explain how a cell membrane controls transport.</p>",
    interaction_type_slug: "essay",
    interaction_data: {
      rce: true,
      essay: null,
      word_count: true,
      file_upload: false,
      spell_check: true,
      word_limit_enabled: true,
      word_limit_min: "0",
      word_limit_max: "500",
    },
    scoring_algorithm: "None",
    scoring_data: { value: "Use evidence." },
  },
};

const CREATE_ARGS = {
  course_id: COURSE_ID,
  assignment_id: QUIZ_ID,
  item_entry_type: ESSAY_PAYLOAD.entry_type,
  item_points_possible: ESSAY_PAYLOAD.points_possible,
  item_position: ESSAY_PAYLOAD.position,
  item_entry_item_body: ESSAY_PAYLOAD.entry.item_body,
  item_entry_interaction_type_slug: ESSAY_PAYLOAD.entry.interaction_type_slug,
  item_entry_interaction_data: ESSAY_PAYLOAD.entry.interaction_data,
  item_entry_scoring_algorithm: ESSAY_PAYLOAD.entry.scoring_algorithm,
  item_entry_scoring_data: ESSAY_PAYLOAD.entry.scoring_data,
};

const DEFAULT_DELETE_ITEM = { id: ITEM_ID, entry_type: "Item", status: "mutable", entry_editable: true };

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function operation(toolName) {
  const entry = CATALOG.operations.find((candidate) => candidate.toolName === toolName);
  assert.ok(entry, `missing Canvas operation ${toolName}`);
  return { ...entry, morrowCourseTarget: canvasOperationAdmission(entry).courseTarget };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function rows(ids, entryType = "Item") {
  return ids.map((id, index) => ({ id, position: index + 1, entry_type: entryType }));
}

async function send(toolName, args, {
  beforeIds = [],
  afterIds = beforeIds,
  beforeRows = rows(beforeIds),
  afterRows = rows(afterIds),
  item = DEFAULT_DELETE_ITEM,
  savedItem = { id: CREATED_ID, ...ESSAY_PAYLOAD, position: 1 },
  writeThrows = false,
} = {}) {
  const keys = ["location", "document", "fetch", "chrome", "__morrowCanvasConnectorInstalled"];
  const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const requests = [];
  const listeners = [];
  let written = false;
  try {
    Object.defineProperties(globalThis, {
      location: { configurable: true, value: { origin: ORIGIN, protocol: "https:", pathname: `/courses/${COURSE_ID}/quizzes` } },
      document: { configurable: true, value: { cookie: "_csrf_token=csrf-value" } },
      chrome: { configurable: true, value: { runtime: { onMessage: { addListener: (listener) => listeners.push(listener) } } } },
      fetch: { configurable: true, value: async (input, options = {}) => {
        const url = new URL(String(input?.href ?? input), ORIGIN);
        const method = options.method || "GET";
        if (url.pathname === "/api/v1/users/self/profile") return json({ id: "7", name: "Teacher" });
        if (url.pathname === `/api/v1/courses/${COURSE_ID}`) return json({ id: COURSE_ID, name: "Biology" });
        requests.push({ method, pathname: url.pathname, body: options.body ?? null });
        if (method !== "GET") {
          written = true;
          if (writeThrows) throw new Error("connection lost after send");
          return json(toolName === "canvas_create_quiz_item" ? { id: CREATED_ID } : {});
        }
        if (url.pathname === ITEMS_PATH) return json(written ? afterRows : beforeRows);
        if (url.pathname === `${ITEMS_PATH}/${ITEM_ID}`) return json(item);
        if (url.pathname === `${ITEMS_PATH}/${CREATED_ID}`) return json(savedItem);
        return json({ error: "not found" }, 404);
      } },
      __morrowCanvasConnectorInstalled: { configurable: true, writable: true, value: undefined },
    });
    delete globalThis.__morrowCanvasConnectorInstalled;
    runInThisContext(CONTENT_SOURCE, { filename: "canvas-content.js" });
    const result = await new Promise((resolve, reject) => {
      const handled = listeners[0]({
        type: "morrow_canvas_execute",
        operation: operation(toolName),
        arguments: args,
        principalId: "7",
        expiresAt: Date.now() + 60_000,
        courseId: COURSE_ID,
      }, null, resolve);
      if (handled !== true) reject(new Error("content script did not accept the command"));
    });
    return { result, requests };
  } finally {
    for (const key of keys) {
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

function createGuard(beforeIds = []) {
  return { kind: "create", before_items_sha256: digest(rows(beforeIds)), payload_sha256: digest(ESSAY_PAYLOAD) };
}

function createGuardForRows(beforeRows, payload) {
  return { kind: "create", before_items_sha256: digest(beforeRows), payload_sha256: digest(payload) };
}

function deleteGuard(beforeIds = [ITEM_ID], targetItem = DEFAULT_DELETE_ITEM) {
  return {
    kind: "delete",
    before_items_sha256: digest(rows(beforeIds)),
    target_item_sha256: digest(targetItem),
    item_id: ITEM_ID,
    entry_type: "Item",
  };
}

test("guarded create keeps position numeric through validation, write, and saved-item verification", async () => {
  const { result, requests } = await send("canvas_create_quiz_item", {
    ...CREATE_ARGS,
    morrow_new_quiz_item_lifecycle_guard: createGuard(),
  }, { beforeIds: [], afterIds: [CREATED_ID] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.verification, {
    schema: "morrow.browser-verification.v1",
    strategy: "new-quiz-item-lifecycle",
    status: "verified",
    evidence: "complete_item_list_and_created_item_reread",
  });
  assert.equal(requests.filter((request) => request.method === "POST").length, 1);
  assert.deepEqual(requests.map((request) => `${request.method} ${request.pathname}`), [
    `GET ${ITEMS_PATH}`, `POST ${ITEMS_PATH}`, `GET ${ITEMS_PATH}`, `GET ${ITEMS_PATH}/${CREATED_ID}`,
  ]);
});

test("guarded create supports a quiz whose complete membership includes a Stimulus", async () => {
  const beforeRows = [{ id: "41", position: 1, entry_type: "Stimulus" }];
  const afterRows = [...beforeRows, { id: CREATED_ID, position: 2, entry_type: "Item" }];
  const payload = { ...ESSAY_PAYLOAD, position: 2 };
  const { result, requests } = await send("canvas_create_quiz_item", {
    ...CREATE_ARGS,
    item_position: 2,
    morrow_new_quiz_item_lifecycle_guard: {
      kind: "create",
      before_items_sha256: digest(beforeRows),
      payload_sha256: digest(payload),
    },
  }, { beforeRows, afterRows, savedItem: { id: CREATED_ID, ...payload } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.verification.status, "verified");
  assert.equal(requests.filter((request) => request.method === "POST").length, 1);
});

test("replacement create accepts renumbered first, middle, and final post-delete memberships and refuses stale positions", async () => {
  const original = rows(["11", "12", "13", "14"]);
  for (const removedIndex of [0, 1, 3]) {
    const postDeleteRows = original
      .filter((_, index) => index !== removedIndex)
      .map((row, index) => ({ ...row, position: index + 1 }));
    const payload = { ...ESSAY_PAYLOAD, position: removedIndex + 1 };
    const afterIds = postDeleteRows.map((row) => row.id);
    afterIds.splice(removedIndex, 0, CREATED_ID);
    const afterRows = rows(afterIds);
    const args = {
      ...CREATE_ARGS,
      item_position: payload.position,
      morrow_new_quiz_item_lifecycle_guard: createGuardForRows(postDeleteRows, payload),
    };
    const accepted = await send("canvas_create_quiz_item", args, {
      beforeRows: postDeleteRows,
      afterRows,
      savedItem: { id: CREATED_ID, ...payload },
    });
    assert.equal(accepted.result.ok, true, JSON.stringify({ removedIndex, result: accepted.result }));
    assert.equal(accepted.requests.filter((request) => request.method === "POST").length, 1);

    const staleRows = removedIndex < original.length - 1
      ? original.filter((_, index) => index !== removedIndex)
      : [...postDeleteRows, { id: "15", position: postDeleteRows.length + 1, entry_type: "Item" }];
    const stale = await send("canvas_create_quiz_item", {
      ...args,
      morrow_new_quiz_item_lifecycle_guard: createGuardForRows(staleRows, payload),
    }, { beforeRows: postDeleteRows, afterRows, savedItem: { id: CREATED_ID, ...payload } });
    assert.equal(stale.result.sent, false);
    assert.match(stale.result.error, /^new_quiz_item_lifecycle_stale:/);
    assert.equal(stale.requests.filter((request) => request.method === "POST").length, 0);
  }
});

test("create without a lifecycle guard is refused before an item-list read or write", async () => {
  const { result, requests } = await send("canvas_create_quiz_item", CREATE_ARGS);
  assert.equal(result.sent, false);
  assert.match(result.error, /^new_quiz_item_lifecycle_guard_required:/);
  assert.deepEqual(requests, []);
});

test("create refuses a stale list, changed payload, and Hot Spot before any write", async () => {
  const attempts = [
    { args: { ...CREATE_ARGS, morrow_new_quiz_item_lifecycle_guard: createGuard([ITEM_ID]) }, error: /^new_quiz_item_lifecycle_stale:/ },
    { args: { ...CREATE_ARGS, item_points_possible: 3, morrow_new_quiz_item_lifecycle_guard: createGuard() }, error: /^new_quiz_item_lifecycle_guard_invalid:/ },
    { args: { ...CREATE_ARGS, item_entry_interaction_type_slug: "hot-spot", morrow_new_quiz_item_lifecycle_guard: createGuard() }, error: /^new_quiz_item_payload_invalid:/ },
  ];
  for (const attempt of attempts) {
    const { result, requests } = await send("canvas_create_quiz_item", attempt.args);
    assert.equal(result.sent, false);
    assert.match(result.error, attempt.error);
    assert.equal(requests.filter((request) => request.method !== "GET").length, 0);
  }
});

test("guarded delete reads an editable standalone Item, writes once, and verifies exact removal", async () => {
  const { result, requests } = await send("canvas_delete_quiz_item", {
    course_id: COURSE_ID,
    assignment_id: QUIZ_ID,
    item_id: ITEM_ID,
    morrow_new_quiz_item_lifecycle_guard: deleteGuard(),
  }, { beforeIds: [ITEM_ID], afterIds: [] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.verification.status, "verified");
  assert.equal(result.verification.evidence, "complete_item_list_reread_after_delete");
  assert.equal(requests.filter((request) => request.method === "DELETE").length, 1);
});

test("delete refuses when the target item changed but kept the same id", async () => {
  const changed = { ...DEFAULT_DELETE_ITEM, points_possible: 5 };
  const { result, requests } = await send("canvas_delete_quiz_item", {
    course_id: COURSE_ID,
    assignment_id: QUIZ_ID,
    item_id: ITEM_ID,
    morrow_new_quiz_item_lifecycle_guard: deleteGuard(),
  }, { beforeIds: [ITEM_ID], item: changed, afterIds: [] });
  assert.equal(result.sent, false);
  assert.match(result.error, /^new_quiz_item_lifecycle_stale:/);
  assert.equal(requests.filter((request) => request.method === "DELETE").length, 0);
});

test("delete refuses non-Item, stimulus-linked, and locked records before DELETE", async () => {
  const items = [
    { id: ITEM_ID, entry_type: "Stimulus" },
    { id: ITEM_ID, entry_type: "Item", stimulus_quiz_entry_id: "31" },
    { id: ITEM_ID, entry_type: "Item", entry_editable: false },
    { id: ITEM_ID, entry_type: "Item", immutable: true },
    { id: ITEM_ID, entry_type: "Item", status: "immutable" },
    { id: ITEM_ID, entry_type: "Item", status: "unknown" },
  ];
  for (const item of items) {
    const entryType = item.entry_type === "Stimulus" ? "Stimulus" : "Item";
    const { result, requests } = await send("canvas_delete_quiz_item", {
      course_id: COURSE_ID,
      assignment_id: QUIZ_ID,
      item_id: ITEM_ID,
      morrow_new_quiz_item_lifecycle_guard: deleteGuard([ITEM_ID], item),
    }, { beforeIds: [ITEM_ID], item, afterIds: [], ...(entryType === "Stimulus" ? { item } : {}) });
    assert.equal(result.sent, false);
    assert.match(result.error, /^(new_quiz_item_position_list_invalid|new_quiz_item_delete_dependency_unverified):/);
    assert.equal(requests.filter((request) => request.method === "DELETE").length, 0);
  }
});

test("an uncertain create response reconciles the saved item and never retries POST", async () => {
  const { result, requests } = await send("canvas_create_quiz_item", {
    ...CREATE_ARGS,
    morrow_new_quiz_item_lifecycle_guard: createGuard(),
  }, { beforeIds: [], afterIds: [CREATED_ID], writeThrows: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.recovered, true);
  assert.equal(result.verification.status, "verified");
  assert.equal(requests.filter((request) => request.method === "POST").length, 1);
});
