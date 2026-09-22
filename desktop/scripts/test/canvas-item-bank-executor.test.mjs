import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { absoluteItemBankTabUrls, executeItemBankInPage } from "../../connector/extension/src/item-bank-executor.js";
import { itemBankLaunchFromCourseTabs } from "../../connector/extension/src/item-bank-credential.js";
import { itemBankMediaFindings, itemBankNewMediaReason } from "../../connector/extension/src/item-bank-guard.js";

const catalog = JSON.parse(readFileSync(new URL("../../artifacts/canvas-api/canvas-api-catalog.json", import.meta.url), "utf8"));
const operations = new Map(catalog.operations.filter((operation) => operation.service === "item_bank").map((operation) => [operation.nickname, operation]));
const TOKEN = `Signature ${"secret-credential-".repeat(8)}`;
const EXTERNAL_TOOL_ID = "54065";
const LAUNCH_URL = `https://school.instructure.com/courses/42/external_tools/${EXTERNAL_TOOL_ID}`;
const CONTEXT_UUID = "course-context-uuid";
const stable = (value) => Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value === undefined ? null : value);
const digest = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)))), (byte) => byte.toString(16).padStart(2, "0")).join("");
const storage = (values) => ({ getItem: (key) => Object.hasOwn(values, key) ? values[key] : null });

async function withPageContext(callback, overrides = {}) {
  const keys = ["location", "document", "sessionStorage", "localStorage", "fetch", "ENV"];
  const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const values = {
    location: { hostname: "school.quiz-lti.instructure.com" },
    document: { referrer: LAUNCH_URL },
    sessionStorage: storage({ current_user: JSON.stringify({ id: "7" }) }),
    localStorage: storage({}), ENV: {}, ...overrides,
  };
  try {
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    return await callback();
  } finally {
    for (const key of keys) {
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
}

function input(nickname, argumentsValue) {
  const operation = operations.get(nickname);
  assert.ok(operation, `missing Item Bank operation ${nickname}`);
  const capturedAt = Date.now();
  return { principalId: "7", canvasOrigin: "https://school.instructure.com", courseId: "42", operation, arguments: argumentsValue, credential: {
    apiOrigin: "https://school.quiz-api.instructure.com", token: TOKEN, authType: "Signature", contextUuid: CONTEXT_UUID,
    canvasLocalContextId: "42", externalToolId: EXTERNAL_TOOL_ID, launchUrl: LAUNCH_URL, launchNonce: "b28f3aae-8888-4c5b-9a17-458f2e1fe309",
    launchedAt: capturedAt - 1_000, capturedAt,
  } };
}

/**
 * The private Item Bank credential, its context UUID, and every control object
 * the reviewer supplied are frame-private. None of them may travel back in a
 * result, whatever the result says.
 */
function assertPrivate(result, label) {
  const encoded = JSON.stringify(result ?? null);
  for (const secret of [TOKEN, CONTEXT_UUID, "morrow_item_bank_guard", "acknowledged_course_ids", "consumers_sha256", "fan_out", "expected_snapshot"]) {
    assert.equal(encoded.includes(secret), false, `${label} carried ${secret}`);
  }
}

/**
 * One Item Banks API. `writeStatus` answers the dispatched change with a chosen
 * status, and `sabotage` accepts the change and then does not apply it, so the
 * authoritative readback has something real to disagree with.
 *
 * `shareCasing` fixes the key casing this tenant answers a share row with.
 * Canvas pins no one casing, and Morrow's own share request body mixes them, so
 * the shape of a stored row is the tenant's property. The default echoes that
 * body verbatim; "snake" and "camel" answer with one casing throughout.
 */
// What the live bank service answers for an entry: the row with its question embedded.
// A live entry row has no `entry_id`: it names its question only as `entry.id`.
function embeddedEntry(state, row) {
  if (String(row?.entry_type) === "Stimulus") {
    const stimulus = state.stimuli.get(String(row.entry_id));
    if (!stimulus) return row;
    const { entry_id: stimulusId, ...rest } = row;
    return { ...rest, entry: { ...stimulus, id: String(stimulusId) } };
  }
  const question = String(row?.entry_type) === "Item" ? state.items.get(String(row.entry_id)) : null;
  if (!question) return row;
  const { entry_id: entryId, ...rest } = row;
  return { ...rest, entry: { ...question.entry, id: String(entryId) } };
}

// Shares as Morrow reads them: the private launch context never travels back in a result.
const sharesAsRead = (state) => state.shares.map((row) => JSON.parse(JSON.stringify(row).split(CONTEXT_UUID).join("[redacted]")));

// The question as Morrow reads it back through its entry: its documented fields only.
const asRead = (item) => item;

function provider({ writeStatus = 0, sabotage = false, banks, items, entries, shareCasing } = {}) {
  const state = {
    banks: banks ?? [{ id: "91", title: "Bank A", language: "en" }],
    items: items ?? new Map([["501", { id: "501", entry_type: "Item", entry: { title: "Question A", item_body: "<p>A</p>" } }]]),
    entries: entries ?? new Map([["401", { id: "401", bank_id: "91", entry_type: "Item", entry_id: "501" }]]),
    shares: [],
    tags: [{ id: "23", value: "Chapter: 01" }], tagged: new Map(), associations: new Map(), stimuli: new Map(),
    nextBank: 92, nextItem: 502, nextEntry: 402, nextTagAssociation: 7600, nextStimulus: 301,
  };
  // What the live service does: a course lists only the banks shared with it. A bank made by a
  // bare POST /api/banks belongs to its creator until it is shared with the course.
  const associated = new Set(state.banks.map((bank) => bank.id));
  state.associated = associated;
  const requests = [];
  const json = (data, status = 200) => new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url, options = {}) => {
    const parsed = new URL(url); const method = options.method || "GET"; const path = parsed.pathname;
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ method, path, query: Object.fromEntries(parsed.searchParams), body, options });
    if (method !== "GET" && writeStatus >= 400) return json({ errors: [{ message: "refused" }] }, writeStatus);
    const listPage = (rows) => parsed.searchParams.get("page") && parsed.searchParams.get("page") !== "1" ? [] : rows;
    if (path === "/api/banks" && method === "GET") {
      const course = parsed.searchParams.get("course_id");
      return json(listPage(course === null ? state.banks : state.banks.filter((bank) => associated.has(bank.id))));
    }
    if (path === "/api/banks" && method === "POST") {
      // The live service keeps the language it was sent out of every bank it answers with.
      const { language: _language, ...kept } = body.bank;
      const bank = { id: String(state.nextBank++), ...kept, ...(sabotage ? { title: "A title nobody reviewed" } : {}) };
      state.banks.push(bank);
      return json(bank, 201);
    }
    const bankMatch = path.match(/^\/api\/banks\/(\d+)$/);
    if (bankMatch) {
      const index = state.banks.findIndex((bank) => bank.id === bankMatch[1]);
      if (method === "GET") return index < 0 ? json({ error: "missing" }, 404) : json(state.banks[index]);
      if (method === "PATCH") { if (!sabotage) state.banks[index] = { ...state.banks[index], ...body.bank }; return json(state.banks[index]); }
      // The live service archives a deleted bank: the read still answers, and the course no longer lists it.
      if (method === "DELETE") {
        if (!sabotage) { state.banks[index] = { ...state.banks[index], archived: true, archived_at: "2026-09-19T15:17:40.598Z" }; associated.delete(state.banks[index].id); }
        return json(null, 204);
      }
    }
    // The live service has no question read under a bank, and takes a question flat.
    const itemMatch = path.match(/^\/api\/banks\/(\d+)\/items\/(\d+)$/);
    if (itemMatch) {
      if (method === "GET") return json({ status: 404, error: "not found" }, 404);
      if (method === "PATCH") {
        if (!sabotage) state.items.set(itemMatch[2], { id: itemMatch[2], entry_type: "Item", entry: structuredClone(body.item) });
        return json({ id: itemMatch[2], ...state.items.get(itemMatch[2])?.entry });
      }
    }
    if (/^\/api\/banks\/\d+\/items$/.test(path) && method === "POST") {
      const itemId = String(state.nextItem++);
      const entry = sabotage ? { title: "Not the reviewed question" } : structuredClone(body.item);
      state.items.set(itemId, { id: itemId, entry_type: "Item", entry });
      return json({ id: itemId, ...entry }, 201);
    }
    const entryMatch = path.match(/^\/api\/banks\/(\d+)\/bank_entries\/(\d+)$/);
    if (entryMatch) {
      if (method === "GET") return state.entries.has(entryMatch[2]) ? json(embeddedEntry(state, state.entries.get(entryMatch[2]))) : json({ error: "missing" }, 404);
      if (method === "DELETE") { if (!sabotage) state.entries.delete(entryMatch[2]); return json(null, 204); }
    }
    if (/^\/api\/banks\/\d+\/bank_entries$/.test(path)) {
      const listedBank = path.split("/")[3];
      if (method === "GET") return json(listPage([...state.entries.values()].filter((row) => String(row.bank_id) === listedBank).map((row) => embeddedEntry(state, row))));
      if (method === "POST") {
        const entry = { id: String(state.nextEntry++), ...body.bank_entry, ...(sabotage ? { entry_id: "999" } : {}) };
        state.entries.set(entry.id, entry);
        return json(entry, 201);
      }
    }
    // A stimulus is created in the bank and then held by a bank entry, like a question.
    const stimulusListMatch = path.match(/^\/api\/banks\/(\d+)\/stimuli$/);
    if (stimulusListMatch && method === "POST") {
      const stimulus = { id: String(state.nextStimulus++), ...body.stimulus };
      state.stimuli.set(stimulus.id, stimulus);
      return json({ stimulus }, 201);
    }
    const stimulusMatch = path.match(/^\/api\/banks\/(\d+)\/stimuli\/(\d+)$/);
    if (stimulusMatch && method === "PATCH") {
      const current = state.stimuli.get(stimulusMatch[2]);
      if (!current) return json({ error: "missing" }, 404);
      if (!sabotage) state.stimuli.set(stimulusMatch[2], { ...current, ...body.stimulus });
      return json({ stimulus: state.stimuli.get(stimulusMatch[2]) });
    }
    // The question search, the account's tags, and copy, move and tag writes, as the live service answers them.
    const searchMatch = path.match(/^\/api\/banks\/(\d+)\/bank_entries\/search$/);
    if (searchMatch && method === "GET") {
      const tagFilter = parsed.searchParams.getAll("tag_ids[]");
      const text = String(parsed.searchParams.get("text") || "").toLowerCase();
      const rows = [...state.entries.values()].filter((row) => String(row.bank_id) === searchMatch[1])
        .filter((row) => tagFilter.length === 0 || tagFilter.some((tag) => (state.tagged.get(String(row.id)) || []).includes(tag)))
        .map((row) => embeddedEntry(state, row))
        .filter((row) => !text || JSON.stringify(row).toLowerCase().includes(text));
      return json({ total: rows.length, entries: rows });
    }
    if (path === "/api/tags" && method === "GET") {
      const filter = parsed.searchParams.get("filter");
      return json(filter ? state.tags.filter((row) => String(row.value).includes(filter)) : state.tags);
    }
    const transferMatch = path.match(/^\/api\/banks\/(\d+)\/bank_entries\/(copy|move)$/);
    if (transferMatch && method === "POST") {
      const [, targetBank, kind] = transferMatch;
      const source = state.entries.get(String(body.source_bank_entry_id));
      if (!source || String(source.bank_id) !== String(body.source_bank_id)) return json({ error: "missing" }, 404);
      if (sabotage) return json({ id: source.id, bank_id: targetBank }, 200);
      if (kind === "move") {
        state.entries.set(String(source.id), { ...source, bank_id: targetBank });
        return json(embeddedEntry(state, state.entries.get(String(source.id))));
      }
      const itemId = String(state.nextItem++);
      state.items.set(itemId, structuredClone(state.items.get(String(source.entry_id))));
      const copied = { id: String(state.nextEntry++), bank_id: targetBank, entry_type: "Item", entry_id: itemId };
      state.entries.set(copied.id, copied);
      return json(embeddedEntry(state, copied), 201);
    }
    const tagListMatch = path.match(/^\/api\/bank_entries\/(\d+)\/tag_associations$/);
    if (tagListMatch && method === "POST") {
      const tag = state.tags.find((row) => row.value === body.tag_value) ?? { id: String(state.tags.length + 24), value: String(body.tag_value) };
      if (!state.tags.includes(tag)) state.tags.push(tag);
      // Live: posting a tag a question already carries answers with that same association and
      // adds nothing, which is the only way Canvas names an association that already exists.
      const existing = state.associations.get(`${tagListMatch[1]}:${tag.id}`);
      if (existing) return json(existing, 201);
      const association = { id: String(state.nextTagAssociation++), tag_id: tag.id, tag_value: tag.value };
      if (!sabotage) state.tagged.set(tagListMatch[1], [...(state.tagged.get(tagListMatch[1]) || []), tag.id]);
      if (!sabotage) state.associations.set(`${tagListMatch[1]}:${tag.id}`, association);
      state.tagged.set(`association:${association.id}`, [tagListMatch[1], tag.id]);
      return json(association, 201);
    }
    const tagMatch = path.match(/^\/api\/bank_entries\/(\d+)\/tag_associations\/(\d+)$/);
    if (tagMatch && method === "DELETE") {
      const named = state.tagged.get(`association:${tagMatch[2]}`);
      const removed = named ? named[1] : "23";
      if (!sabotage) {
        state.tagged.set(tagMatch[1], (state.tagged.get(tagMatch[1]) || []).filter((tag) => tag !== removed));
        state.associations.delete(`${tagMatch[1]}:${removed}`);
      }
      return json(null, 204);
    }
    const shareMatch = path.match(/^\/api\/banks\/(\d+)\/shared_banks\/(\d+)$/);
    if (shareMatch && method === "PATCH") {
      const index = state.shares.findIndex((row) => String(row.id) === shareMatch[2]);
      if (index < 0) return json({ error: "missing" }, 404);
      if (!sabotage) state.shares[index] = { ...state.shares[index], ...body.shared_bank };
      return json(state.shares[index]);
    }
    if (/^\/api\/banks\/\d+\/shared_banks$/.test(path)) {
      if (method === "GET") return json(state.shares);
      if (method === "POST") {
        const created = { id: String(state.shares.length + 1), ...body.shared_bank };
        const share = !shareCasing ? created : {
          id: created.id, bank_id: created.bank_id, permission: created.permission,
          ...(shareCasing === "camel"
            ? { entityId: created.entity_id ?? created.entityId, entityType: created.entityType ?? created.entity_type }
            : { entity_id: created.entity_id ?? created.entityId, entity_type: created.entityType ?? created.entity_type }),
        };
        if (!sabotage) state.shares.push(share);
        if (!sabotage && (created.entityType ?? created.entity_type) === "course" && String(created.entity_id ?? created.entityId) === CONTEXT_UUID) {
          associated.add(String(created.bank_id));
        }
        return json(share, 201);
      }
    }
    throw new Error(`unhandled ${method} ${path}`);
  };
  return { state, requests, fetch, dispatches: () => requests.filter((request) => request.method !== "GET").length };
}

/**
 * The observed-reach disclosure every existing-bank change carries. It is never
 * a complete claim, and the reviewer acknowledges the exact observed external
 * courses.
 */
async function observed({ bankId = "91", consumers = [], acknowledged = [] } = {}) {
  const sorted = [...consumers].sort((left, right) => left.course_id.length - right.course_id.length || (left.course_id < right.course_id ? -1 : left.course_id > right.course_id ? 1 : 0));
  const external = [...new Set(sorted.map((consumer) => consumer.course_id))].filter((value) => value !== "42");
  return {
    fan_out: {
      schema: "morrow.canvas.item-bank.fan-out.v1", bank_id: bankId, course_id: "42",
      established_at: new Date().toISOString(), sources: [], unreachable: ["quiz_uses", "shared_banks"], complete: false,
      consumers: sorted, consumer_count: sorted.length, external_course_ids: external, consumers_sha256: await digest(sorted),
    },
    fan_out_receipt: "a".repeat(64), acknowledged_course_ids: acknowledged,
  };
}

const TWO_IMAGES = [
  "<p>Which slide shows metaphase?</p>",
  '<p><img src="/courses/42/files/77"></p>',
  '<p><img src="/courses/42/files/78"></p>',
].join("");
const ONE_REPAIRED = TWO_IMAGES.replace('<img src="/courses/42/files/77">', '<img src="/courses/42/files/77" alt="Chromosomes lined up at the centre">');
const undescribedItem = (body) => ({ id: "501", entry_type: "Item", entry: { title: "Mitosis", item_body: body } });

/** Every reviewed write shape, with the snapshot and payload each one needs. */
const WRITE_SHAPES = [
  {
    nickname: "create_bank",
    args: async (state) => ({ course_id: "42", title: "Bank B", language: "fr", expected_snapshot: { banks_sha256: await digest(state.banks) } }),
    stale: (state) => { state.banks.push({ id: "93", title: "Added behind the reviewer", language: "en" }); state.associated.add("93"); },
    mismatch: "created_bank_title_did_not_match",
    // Canvas's own Item Banks page creates the bank, then shares it with the course.
    dispatches: 2,
  },
  {
    nickname: "rename_bank",
    args: async (state) => ({ course_id: "42", bank_id: "91", title: "Renamed", expected_snapshot: { bank_sha256: await digest(state.banks[0]) }, ...await observed() }),
    mismatch: "renamed_bank_title_did_not_match",
  },
  {
    nickname: "archive_bank",
    args: async (state) => ({ course_id: "42", bank_id: "91", expected_snapshot: { bank_sha256: await digest(state.banks[0]), entries_sha256: await digest([...state.entries.values()].map((row) => embeddedEntry(state, row))), shares_sha256: await digest(sharesAsRead(state)) }, ...await observed() }),
    mismatch: "bank_still_present_after_delete",
  },
  {
    nickname: "create_item",
    args: async (state) => ({ course_id: "42", bank_id: "91", item: { entry_type: "Item", entry: { title: "Question B", item_body: "<p>B</p>" } }, expected_snapshot: { bank_sha256: await digest(state.banks[0]) }, ...await observed() }),
    mismatch: "created_item_entry_not_found",
    // Canvas's own Item Banks page creates the question, then its entry in the bank.
    dispatches: 2,
  },
  {
    nickname: "update_item",
    args: async (state) => ({ course_id: "42", bank_id: "91", item_id: "501", item: { id: "501", entry_type: "Item", entry: { title: "Question A2", item_body: "<p>A2</p>" } }, expected_snapshot: { bank_sha256: await digest(state.banks[0]), item_sha256: await digest(asRead(state.items.get("501"))) }, ...await observed() }),
    mismatch: "updated_item_did_not_match_payload",
  },
  {
    nickname: "attach_item",
    args: async (state) => {
      // The question to attach lives in another bank of this course.
      state.banks.push({ id: "90", title: "Source bank", language: "en" });
      state.associated.add("90");
      const row = state.entries.get("401");
      state.entries.clear();
      state.entries.set("401", { ...row, bank_id: "90" });
      return { course_id: "42", bank_id: "91", item_id: "501", expected_snapshot: { bank_sha256: await digest(state.banks[0]), item_sha256: await digest(asRead(state.items.get("501"))), entries_sha256: await digest([]) }, ...await observed() };
    },
    mismatch: "attached_entry_did_not_match_item",
  },
  {
    nickname: "delete_entry",
    args: async (state) => ({ course_id: "42", bank_id: "91", bank_entry_id: "401", expected_snapshot: { bank_sha256: await digest(state.banks[0]), entry_sha256: await digest(embeddedEntry(state, state.entries.get("401"))), entries_sha256: await digest([...state.entries.values()].map((row) => embeddedEntry(state, row))) }, ...await observed() }),
    mismatch: "bank_entry_still_present_after_delete",
  },
  {
    nickname: "copy_entry",
    args: async (state) => {
      state.banks.push({ id: "90", title: "Source bank", language: "en" });
      state.associated.add("90");
      state.entries.set("403", { id: "403", bank_id: "90", entry_type: "Item", entry_id: "501" });
      return { course_id: "42", bank_id: "91", source_bank_id: "90", source_bank_entry_id: "403",
        expected_snapshot: { bank_sha256: await digest(state.banks[0]), entries_sha256: await digest([...state.entries.values()].filter((row) => row.bank_id === "91").map((row) => embeddedEntry(state, row))), source_entry_sha256: await digest(embeddedEntry(state, state.entries.get("403"))) }, ...await observed() };
    },
    mismatch: "copied_entry_not_found_in_bank",
  },
  {
    nickname: "move_entry",
    args: async (state) => {
      state.banks.push({ id: "90", title: "Source bank", language: "en" });
      state.associated.add("90");
      state.entries.set("403", { id: "403", bank_id: "90", entry_type: "Item", entry_id: "501" });
      return { course_id: "42", bank_id: "91", source_bank_id: "90", source_bank_entry_id: "403",
        expected_snapshot: { bank_sha256: await digest(state.banks[0]), entries_sha256: await digest([...state.entries.values()].filter((row) => row.bank_id === "91").map((row) => embeddedEntry(state, row))), source_entry_sha256: await digest(embeddedEntry(state, state.entries.get("403"))) }, ...await observed() };
    },
    mismatch: "moved_entry_not_found_in_bank",
  },
  {
    nickname: "update_share",
    args: async (state) => {
      state.shares.push({ id: "1", bank_id: "91", entity_type: "course", entity_id: "77", permission: "read" });
      return { course_id: "42", bank_id: "91", share_id: "1", permission: "edit",
        expected_snapshot: { bank_sha256: await digest(state.banks[0]), shares_sha256: await digest(sharesAsRead(state)) }, ...await observed() };
    },
    mismatch: "share_permission_did_not_match",
  },
  {
    nickname: "add_entry_tag",
    args: async (state) => ({ course_id: "42", bank_id: "91", bank_entry_id: "401", tag_value: "Chapter: 01",
      expected_snapshot: { bank_sha256: await digest(state.banks[0]), entry_sha256: await digest(embeddedEntry(state, state.entries.get("401"))) }, ...await observed() }),
    mismatch: "tagged_question_not_found",
  },
  {
    nickname: "remove_entry_tag",
    args: async (state) => {
      state.tagged.set("401", ["23"]);
      return { course_id: "42", bank_id: "91", bank_entry_id: "401", tag_association_id: "7600", tag_id: "23",
        expected_snapshot: { bank_sha256: await digest(state.banks[0]), entry_sha256: await digest(embeddedEntry(state, state.entries.get("401"))) }, ...await observed() };
    },
    mismatch: "question_still_carries_the_tag",
  },
  {
    nickname: "create_stimulus",
    args: async (state) => ({ course_id: "42", bank_id: "91", title: "The passage", body: "<p>Read this.</p>",
      expected_snapshot: { bank_sha256: await digest(state.banks[0]) }, ...await observed() }),
    mismatch: "created_stimulus_entry_not_found",
    // The stimulus, then the bank entry that holds it: the shape Canvas's own page sends.
    dispatches: 2,
  },
  {
    nickname: "update_stimulus",
    args: async (state) => {
      state.stimuli.set("300", { id: "300", title: "The passage", body: "<p>Read this.</p>", passage: false });
      state.entries.set("410", { id: "410", bank_id: "91", entry_type: "Stimulus", entry_id: "300" });
      return { course_id: "42", bank_id: "91", stimulus_id: "300", title: "The passage, revised",
        expected_snapshot: { bank_sha256: await digest(state.banks[0]), entries_sha256: await digest([...state.entries.values()].filter((row) => String(row.bank_id) === "91").map((row) => embeddedEntry(state, row))) },
        ...await observed() };
    },
    mismatch: "stimulus_did_not_match_request",
  },
  {
    nickname: "share_bank",
    args: async (state) => ({ course_id: "42", bank_id: "91", entity_type: "course", entity_id: "77", permission: "read", expected_snapshot: { bank_sha256: await digest(state.banks[0]), shares_sha256: await digest(sharesAsRead(state)) }, ...await observed() }),
    mismatch: "course_read_share_not_found",
  },
];

async function runShape(shape, options = {}) {
  return await withPageContext(async () => {
    const api = provider(options);
    globalThis.fetch = api.fetch;
    const args = await shape.args(api.state);
    if (options.stale && shape.stale) shape.stale(api.state);
    else if (options.stale) api.state.banks[0] = { ...api.state.banks[0], title: "Renamed behind the reviewer" };
    const request = input(shape.nickname, args);
    if (["create_item", "update_item"].includes(shape.nickname)) request.payloadContractSha256 = await digest(args.item);
    const result = await executeItemBankInPage(request);
    assertPrivate(result, shape.nickname);
    return { result, api, args };
  });
}

test("Item Bank catalog exposes nine reads and twenty course-bound writes", () => {
  assert.equal(operations.size, 29);
  assert.equal([...operations.values()].filter((operation) => operation.readOnly).length, 9);
  for (const operation of [...operations.values()].filter((candidate) => !candidate.readOnly)) {
    assert.ok(operation.inputSchema.required.includes("course_id"), operation.nickname);
    assert.ok(operation.inputSchema.required.includes("expected_snapshot"), operation.nickname);
  }
  assert.deepEqual(WRITE_SHAPES.map((shape) => shape.nickname).sort(), [
    "add_entry_tag", "archive_bank", "attach_item", "copy_entry", "create_bank", "create_item", "create_stimulus",
    "delete_entry", "move_entry", "remove_entry_tag", "rename_bank", "share_bank", "update_item", "update_share",
    "update_stimulus",
  ]);
});

test("the relative native Canvas Item Banks tab resolves to the exact course launch", () => {
  const origin = "https://chcp.instructure.com";
  const tabs = absoluteItemBankTabUrls([{
    id: "context_external_tool_98188",
    type: "internal",
    label: "Item Banks",
    html_url: "/courses/89585/banks",
  }], origin);
  assert.deepEqual(itemBankLaunchFromCourseTabs(tabs, origin, "89585"), {
    externalToolId: "98188",
    launchUrl: "https://chcp.instructure.com/courses/89585/banks",
    native: true,
  });
  const foreign = absoluteItemBankTabUrls([{ ...tabs[0], html_url: "//evil.example/courses/89585/banks" }], origin);
  assert.equal(itemBankLaunchFromCourseTabs(foreign, origin, "89585"), null);
});

test("the native Canvas Item Banks page keeps its token private and completes a bank read", async () => {
  await withPageContext(async () => {
    const p = provider({ banks: [] });
    // The bank service keys a course by its Canvas uuid, read from Canvas itself; the page's
    // numeric `canvas_context_id` names no course to the bank service.
    const COURSE_UUID = "OxO4Y5yErxxwmlKpXV7qWx9wnFyMoQG17sLQndNi";
    const canvasReads = [];
    globalThis.fetch = async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.origin === "https://school.instructure.com") {
        canvasReads.push(parsed.pathname);
        return new Response(JSON.stringify({ id: 42, uuid: COURSE_UUID }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return p.fetch(url, options);
    };
    const request = input("list_banks", { course_id: "42" });
    delete request.credential;
    const result = await executeItemBankInPage(request);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.sent, true);
    assert.deepEqual(canvasReads, ["/api/v1/courses/42"]);
    assert.equal(p.requests.length, 1);
    assert.equal(p.requests[0].query.course_id, COURSE_UUID);
    assert.equal(JSON.stringify(result).includes(COURSE_UUID), false);
    assert.equal(p.requests[0].options.headers.Authorization, TOKEN);
    assert.equal(JSON.stringify(result).includes(TOKEN), false);
    assert.equal(JSON.stringify(result).includes(CONTEXT_UUID), false);
  }, {
    location: { hostname: "school.instructure.com", href: "https://school.instructure.com/courses/42/banks" },
    document: { referrer: "" },
    sessionStorage: storage({
      current_user: JSON.stringify({ id: "7" }),
      canvas_local_context_id: "42",
      canvas_context_id: CONTEXT_UUID,
      "banks.build_token": TOKEN,
    }),
    localStorage: storage({
      canvas_host: "https://school.instructure.com",
      backend_url: "https://school.quiz-lti.instructure.com",
    }),
    ENV: { current_user_id: "7" },
  });
});

test("the native Item Banks page sends nothing when Canvas does not name the course uuid", async () => {
  for (const [label, answer] of [["course read refused", null], ["another course", { id: 43, uuid: "OxO4Y5yErxxwmlKpXV7qWx9wnFyMoQG17sLQndNi" }], ["no uuid", { id: 42 }]]) {
    await withPageContext(async () => {
      const p = provider({ banks: [] });
      globalThis.fetch = async (url, options = {}) => new URL(url).origin === "https://school.instructure.com"
        ? new Response(answer ? JSON.stringify(answer) : "", { status: answer ? 200 : 403 })
        : p.fetch(url, options);
      const request = input("list_banks", { course_id: "42" });
      delete request.credential;
      const result = await executeItemBankInPage(request);
      assert.equal(result.error, "item_bank_course_identity_unavailable", label);
      assert.equal(result.sent, false, label);
      assert.equal(p.requests.length, 0, label);
    }, {
      location: { hostname: "school.instructure.com", href: "https://school.instructure.com/courses/42/banks" },
      document: { referrer: "" },
      sessionStorage: storage({ current_user: JSON.stringify({ id: "7" }), canvas_local_context_id: "42", canvas_context_id: CONTEXT_UUID, "banks.build_token": TOKEN }),
      localStorage: storage({ canvas_host: "https://school.instructure.com", backend_url: "https://school.quiz-lti.instructure.com" }),
      ENV: { current_user_id: "7" },
    });
  }
});

test("the native Item Banks page refuses mismatched course, tenant, and context state before fetch", async () => {
  const base = {
    location: { hostname: "school.instructure.com", href: "https://school.instructure.com/courses/42/banks" },
    document: { referrer: "" },
    sessionStorage: storage({
      current_user: JSON.stringify({ id: "7" }),
      canvas_local_context_id: "42",
      canvas_context_id: CONTEXT_UUID,
      "banks.build_token": TOKEN,
    }),
    localStorage: storage({
      canvas_host: "https://school.instructure.com",
      backend_url: "https://school.quiz-lti.instructure.com",
    }),
    ENV: { current_user_id: "7" },
  };
  for (const [label, overrides] of [
    ["wrong page course", { location: { hostname: "school.instructure.com", href: "https://school.instructure.com/courses/43/banks" } }],
    ["wrong Canvas host", { localStorage: storage({ canvas_host: "https://other.instructure.com", backend_url: "https://school.quiz-lti.instructure.com" }) }],
    ["wrong backend tenant", { localStorage: storage({ canvas_host: "https://school.instructure.com", backend_url: "https://other.quiz-lti.instructure.com" }) }],
    ["wrong local course", { sessionStorage: storage({ current_user: JSON.stringify({ id: "7" }), canvas_local_context_id: "43", canvas_context_id: CONTEXT_UUID, "banks.build_token": TOKEN }) }],
  ]) {
    await withPageContext(async () => {
      let calls = 0;
      globalThis.fetch = async () => { calls += 1; return new Response("[]"); };
      const request = input("list_banks", { course_id: "42" });
      delete request.credential;
      const result = await executeItemBankInPage(request);
      assert.notEqual(result.ok, true, label);
      assert.equal(calls, 0, label);
    }, { ...base, ...overrides });
  }
});

test("all private bank-surface reads bind the selected course and return a snapshot digest", async () => {
  await withPageContext(async () => {
    const p = provider(); globalThis.fetch = p.fetch;
    for (const [nickname, args] of [
      ["list_banks", { course_id: "42" }], ["get_bank", { course_id: "42", bank_id: "91" }],
      ["list_entries", { course_id: "42", bank_id: "91" }], ["get_entry", { course_id: "42", bank_id: "91", bank_entry_id: "401" }],
      ["list_shares", { course_id: "42", bank_id: "91" }], ["get_item", { course_id: "42", bank_id: "91", item_id: "501" }],
    ]) {
      const result = await executeItemBankInPage(input(nickname, args));
      assert.equal(result.ok, true, nickname); assert.match(result.snapshotSha256, /^[0-9a-f]{64}$/); assert.equal(JSON.stringify(result).includes(TOKEN), false);
    }
  });
});

test("every reviewed write sends exactly one request and proves the saved result", async () => {
  for (const shape of WRITE_SHAPES) {
    const { result, api } = await runShape(shape);
    assert.equal(result.ok, true, `${shape.nickname}: ${JSON.stringify(result)}`);
    assert.equal(result.sent, true, shape.nickname);
    assert.equal(result.verification.status, "verified", shape.nickname);
    assert.equal(result.outcomeUnknown, false, shape.nickname);
    assert.equal(api.dispatches(), shape.dispatches ?? 1, shape.nickname);
    assert.equal(api.requests.filter((entry) => entry.method === operations.get(shape.nickname).method).length, shape.dispatches ?? 1, shape.nickname);
  }
});

test("a snapshot that changed after the review stops every write before dispatch", async () => {
  for (const shape of WRITE_SHAPES) {
    const { result, api } = await runShape(shape, { stale: true });
    assert.equal(result.error, "item_bank_snapshot_changed", shape.nickname);
    assert.equal(result.sent, false, shape.nickname);
    assert.equal(api.dispatches(), 0, shape.nickname);
  }
});

test("a definite provider refusal is reported as refused and never repeated", async () => {
  for (const shape of WRITE_SHAPES) {
    const { result, api } = await runShape(shape, { writeStatus: 422 });
    assert.equal(result.ok, false, shape.nickname);
    assert.equal(result.sent, true, shape.nickname);
    assert.equal(result.status, 422, shape.nickname);
    assert.equal(result.outcomeUnknown, false, shape.nickname);
    assert.equal(api.dispatches(), 1, shape.nickname);
  }
});

test("an uncertain provider answer is never dispatched a second time", async () => {
  for (const status of [408, 429, 500, 503]) {
    for (const shape of WRITE_SHAPES) {
      const { result, api } = await runShape(shape, { writeStatus: status });
      assert.equal(result.ok, false, `${shape.nickname} ${status}`);
      assert.equal(result.sent, true, `${shape.nickname} ${status}`);
      assert.equal(result.outcomeUnknown, true, `${shape.nickname} ${status}`);
      assert.notEqual(result.verification?.status, "verified", `${shape.nickname} ${status}`);
      assert.equal(api.dispatches(), 1, `${shape.nickname} ${status}`);
    }
  }
});

test("a lost transport answer leaves the outcome unknown and sends nothing more", async () => {
  await withPageContext(async () => {
    const api = provider();
    let sent = 0;
    globalThis.fetch = async (url, options = {}) => {
      if ((options.method || "GET") !== "GET") { sent += 1; throw new TypeError("the Item Banks frame lost the answer"); }
      return api.fetch(url, options);
    };
    const state = api.state;
    const result = await executeItemBankInPage(input("rename_bank", {
      course_id: "42", bank_id: "91", title: "Renamed",
      expected_snapshot: { bank_sha256: await digest(state.banks[0]) }, ...await observed(),
    }));
    assert.equal(sent, 1);
    assert.equal(result.sent, true);
    assert.equal(result.outcomeUnknown, true);
    assert.notEqual(result.verification.status, "verified");
    assertPrivate(result, "rename_bank transport");
  });
});

test("a write the provider accepted but did not apply is never reported as verified", async () => {
  for (const shape of WRITE_SHAPES) {
    const { result, api } = await runShape(shape, { sabotage: true });
    assert.equal(result.ok, false, shape.nickname);
    assert.equal(result.sent, true, shape.nickname);
    assert.equal(result.outcomeUnknown, true, shape.nickname);
    assert.equal(result.verification.status, "mismatch", `${shape.nickname}: ${JSON.stringify(result.verification)}`);
    assert.equal(result.verification.reason, shape.mismatch, shape.nickname);
    assert.equal(api.dispatches(), shape.dispatches ?? 1, shape.nickname);
  }
});

test("repairing one image is never blocked by another image that still needs work", async () => {
  await withPageContext(async () => {
    const items = new Map([["501", undescribedItem(TWO_IMAGES)]]);
    const api = provider({ items });
    globalThis.fetch = api.fetch;
    const item = undescribedItem(ONE_REPAIRED);
    const args = {
      course_id: "42", bank_id: "91", item_id: "501", item,
      expected_snapshot: { bank_sha256: await digest(api.state.banks[0]), item_sha256: await digest(asRead(items.get("501"))) },
      ...await observed(),
    };
    const request = input("update_item", args);
    request.payloadContractSha256 = await digest(item);
    const result = await executeItemBankInPage(request);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.verification.status, "verified");
    assert.equal(api.dispatches(), 1);
    // Exactly one image gained alternative text. The other known issue is left
    // as it was, and nothing else in the question moved.
    const saved = api.state.items.get("501");
    assert.equal(saved.entry.item_body, ONE_REPAIRED);
    assert.ok(saved.entry.item_body.includes('<img src="/courses/42/files/78">'));
    assertPrivate(result, "two-image repair");
  });
});

test("a change that adds a new undescribed image is refused before dispatch", async () => {
  const cases = [
    ["a third image with no alternative text", `${ONE_REPAIRED}<p><img src="/courses/42/files/79"></p>`, "item_bank_payload_media_image_alt_missing"],
    ["a second copy of the image that already has none", `${ONE_REPAIRED}<p><img src="/courses/42/files/78"></p>`, "item_bank_payload_media_image_alt_missing"],
    ["a media source Canvas cannot serve", ONE_REPAIRED.replace('"/courses/42/files/77" alt=', '"javascript:0" alt='), "item_bank_payload_media_src_unsupported"],
  ];
  for (const [label, body, expected] of cases) {
    await withPageContext(async () => {
      const items = new Map([["501", undescribedItem(TWO_IMAGES)]]);
      const api = provider({ items });
      globalThis.fetch = api.fetch;
      const item = undescribedItem(body);
      const args = {
        course_id: "42", bank_id: "91", item_id: "501", item,
        expected_snapshot: { bank_sha256: await digest(api.state.banks[0]), item_sha256: await digest(asRead(items.get("501"))) },
        ...await observed(),
      };
      const request = input("update_item", args);
      request.payloadContractSha256 = await digest(item);
      const result = await executeItemBankInPage(request);
      assert.equal(result.error, expected, `${label}: ${JSON.stringify(result)}`);
      assert.equal(result.sent, false, label);
      assert.equal(api.dispatches(), 0, label);
    });
  }
});

test("a new question with an undescribed image is still refused outright", async () => {
  await withPageContext(async () => {
    const api = provider();
    globalThis.fetch = api.fetch;
    const item = { entry_type: "Item", entry: { title: "New", item_body: '<p><img src="/courses/42/files/77"></p>' } };
    const args = { course_id: "42", bank_id: "91", item, expected_snapshot: { bank_sha256: await digest(api.state.banks[0]) }, ...await observed() };
    const request = input("create_item", args);
    request.payloadContractSha256 = await digest(item);
    const result = await executeItemBankInPage(request);
    assert.equal(result.error, "item_bank_payload_media_image_alt_missing");
    assert.equal(result.sent, false);
    assert.equal(api.dispatches(), 0);
  });
});

/**
 * The hole a per-code comparison would leave open: the stored question already
 * carries `media_image_alt_missing`, so a rule that compared codes would let a
 * brand-new undescribed image ride in behind it. The match is per element and
 * counted, so it cannot.
 */
test("a problem the question already has never excuses a new one", async () => {
  const stored = undescribedItem(TWO_IMAGES);
  const accepted = undescribedItem(ONE_REPAIRED);
  const refused = undescribedItem(`${ONE_REPAIRED}<p><img src="/courses/42/files/79"></p>`);
  // Both payloads carry the same finding code. Only one of them adds an element.
  assert.deepEqual(itemBankMediaFindings(accepted).map((finding) => finding.reason), ["media_image_alt_missing"]);
  assert.deepEqual(itemBankMediaFindings(refused).map((finding) => finding.reason), ["media_image_alt_missing", "media_image_alt_missing"]);
  assert.equal(itemBankNewMediaReason(accepted, stored), null);
  assert.equal(itemBankNewMediaReason(refused, stored), "media_image_alt_missing");
  // The same pair through the frame that actually reaches Canvas.
  for (const [label, item, expected] of [["describes the first image", accepted, true], ["also adds a third", refused, false]]) {
    await withPageContext(async () => {
      const items = new Map([["501", undescribedItem(TWO_IMAGES)]]);
      const api = provider({ items });
      globalThis.fetch = api.fetch;
      const request = input("update_item", {
        course_id: "42", bank_id: "91", item_id: "501", item,
        expected_snapshot: { bank_sha256: await digest(api.state.banks[0]), item_sha256: await digest(asRead(items.get("501"))) },
        ...await observed(),
      });
      request.payloadContractSha256 = await digest(item);
      const result = await executeItemBankInPage(request);
      if (expected) {
        assert.equal(result.ok, true, `${label}: ${JSON.stringify(result)}`);
        assert.equal(api.dispatches(), 1, label);
      } else {
        assert.equal(result.error, "item_bank_payload_media_image_alt_missing", label);
        assert.equal(result.sent, false, label);
        assert.equal(api.dispatches(), 0, label);
      }
    });
  }
});

test("the in-frame media rule and the shared module rule agree", async () => {
  const stored = undescribedItem(TWO_IMAGES);
  assert.deepEqual(itemBankMediaFindings(stored).map((finding) => finding.reason), ["media_image_alt_missing", "media_image_alt_missing"]);
  assert.equal(itemBankNewMediaReason(undescribedItem(ONE_REPAIRED), stored), null);
  assert.equal(itemBankNewMediaReason(undescribedItem(`${ONE_REPAIRED}<img src="/courses/42/files/79">`), stored), "media_image_alt_missing");
  assert.equal(itemBankNewMediaReason(stored, stored), null);
  assert.equal(itemBankNewMediaReason(undescribedItem('<img src="ftp://x/y" alt="a">'), stored), "media_src_unsupported");
  assert.equal(itemBankNewMediaReason(undescribedItem("<script><img src='/courses/42/files/1'>"), stored), "media_markup_unreadable");
  // The in-frame copy is the one that runs against Canvas. It must answer the
  // same way for the same question.
  await withPageContext(async () => {
    const items = new Map([["501", stored]]);
    const api = provider({ items });
    globalThis.fetch = api.fetch;
    const item = undescribedItem(ONE_REPAIRED);
    const request = input("update_item", {
      course_id: "42", bank_id: "91", item_id: "501", item,
      expected_snapshot: { bank_sha256: await digest(api.state.banks[0]), item_sha256: await digest(asRead(stored)) },
      ...await observed(),
    });
    request.payloadContractSha256 = await digest(item);
    assert.equal((await executeItemBankInPage(request)).ok, true);
  });
});

test("a read and the pre-write snapshot of the same list use one page size and one digest", async () => {
  await withPageContext(async () => {
    const rows = Array.from({ length: 150 }, (_, index) => ({ id: String(index + 1), title: `Bank ${index + 1}` }));
    const seen = [];
    globalThis.fetch = async (url) => {
      const parsed = new URL(url);
      const size = Number(parsed.searchParams.get("per_page") || 25);
      const page = Number(parsed.searchParams.get("page") || 1);
      seen.push({ page, size });
      return new Response(JSON.stringify(rows.slice((page - 1) * size, page * size)));
    };
    const read = await executeItemBankInPage(input("list_banks", { course_id: "42" }));
    assert.equal(read.ok, true);
    assert.equal(read.data.length, 150);
    assert.equal(read.truncated, false);
    // Every page is asked for with the same size the pre-write snapshot uses,
    // and the walk stops only on an empty page.
    assert.deepEqual(seen, [{ page: 1, size: 100 }, { page: 2, size: 100 }, { page: 3, size: 100 }]);
    assert.equal(read.snapshotSha256, await digest(read.data));
  });
});

test("collection reads continue after a full page and stop only on an empty page", async () => {
  await withPageContext(async () => {
    const rows = Array.from({ length: 101 }, (_, index) => ({ id: String(index + 1), title: `Bank ${index + 1}` }));
    const pages = [];
    globalThis.fetch = async (url) => {
      const parsed = new URL(url);
      const page = Number(parsed.searchParams.get("page"));
      pages.push(page);
      return new Response(JSON.stringify(page === 1 ? rows.slice(0, 100) : page === 2 ? rows.slice(100) : []));
    };
    const result = await executeItemBankInPage(input("list_banks", { course_id: "42" }));
    assert.equal(result.ok, true);
    assert.equal(result.data.length, 101);
    assert.deepEqual(pages, [1, 2, 3]);
    assert.equal(result.snapshotSha256, await digest(result.data));
  });
});

test("a bank list the pre-write snapshot cannot finish stops the write before dispatch", async () => {
  await withPageContext(async () => {
    let dispatches = 0;
    globalThis.fetch = async (url, options = {}) => {
      if ((options.method || "GET") !== "GET") dispatches += 1;
      // Never an empty page: the walk can never prove it saw the whole list.
      return new Response(JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ id: String(index + 1) }))));
    };
    const result = await executeItemBankInPage(input("create_bank", {
      course_id: "42", title: "Bank B", expected_snapshot: { banks_sha256: "b".repeat(64) },
    }));
    assert.equal(result.error, "item_bank_snapshot_unreadable");
    assert.equal(result.sent, false);
    assert.equal(dispatches, 0);
  });
});

test("sanitized read data and its snapshot omit credential-like fields", async () => {
  await withPageContext(async () => {
    const p = provider();
    p.state.banks[0].access_token = TOKEN;
    p.state.banks[0].nested = { client_secret: TOKEN, label: "safe" };
    // The context UUID is the other private value this frame holds: Morrow sends
    // it as the `course_id` query claim on every bank list read, so a tenant that
    // echoes the request back into a row returns it. It came from the captured
    // launch, not from the person, so no result may carry it either.
    p.state.banks[0].course_id = CONTEXT_UUID;
    p.state.banks[0].nested.context = `lti_context ${CONTEXT_UUID} inline`;
    globalThis.fetch = p.fetch;
    const result = await executeItemBankInPage(input("list_banks", { course_id: "42" }));
    assert.equal(result.ok, true);
    assert.equal(JSON.stringify(result).includes(TOKEN), false);
    assert.equal(JSON.stringify(result).includes(CONTEXT_UUID), false);
    assert.deepEqual(result.data[0].nested, { label: "safe", context: "lti_context [redacted] inline" });
    assert.equal(result.data[0].course_id, "[redacted]");
    // The snapshot digest is over the sanitized rows, so the read and the
    // pre-write snapshot of the same list still agree.
    assert.equal(result.snapshotSha256, await digest(result.data));
    assertPrivate(result, "list_banks with an echoed context UUID");
  });
});

test("every digest the reviewer pinned is compared, not only the required ones", async () => {
  await withPageContext(async () => {
    const api = provider();
    globalThis.fetch = api.fetch;
    const result = await executeItemBankInPage(input("rename_bank", {
      course_id: "42", bank_id: "91", title: "Renamed",
      expected_snapshot: { bank_sha256: await digest(api.state.banks[0]), entries_sha256: "c".repeat(64) },
      ...await observed(),
    }));
    assert.equal(result.error, "item_bank_snapshot_changed");
    assert.equal(api.dispatches(), 0);
  });
});

test("a missing, unknown, or malformed snapshot key stops the write before dispatch", async () => {
  const cases = [
    ["no snapshot", undefined, "expected_snapshot is required"],
    ["a snapshot key this operation does not use", { bank_sha256: "d".repeat(64), unknown_sha256: "d".repeat(64) }, "item_bank_snapshot_invalid"],
    ["a required key that is not a digest", { bank_sha256: "not-a-digest" }, "item_bank_snapshot_invalid"],
    ["only some of the required keys", {}, "item_bank_snapshot_invalid"],
    ["a snapshot that is not an object", "bank_sha256", "item_bank_snapshot_invalid"],
  ];
  for (const [label, expected_snapshot, expected] of cases) {
    await withPageContext(async () => {
      const api = provider();
      globalThis.fetch = api.fetch;
      const result = await executeItemBankInPage(input("rename_bank", { course_id: "42", bank_id: "91", title: "Renamed", expected_snapshot, ...await observed() }));
      assert.equal(result.error, expected, label);
      assert.equal(result.sent, false, label);
      assert.equal(api.dispatches(), 0, label);
    });
  }
});

test("an observed-reach record that claims completeness or hides a course is refused", async () => {
  const base = await observed({ consumers: [{ course_id: "77", entity_type: "course", entity_id: "77" }], acknowledged: ["77"] });
  const cases = [
    ["a complete claim", { fan_out: { ...base.fan_out, complete: true } }, "item_bank_fan_out_authoritative_reach_claim_refused"],
    ["every source walked to its end", { fan_out: { ...base.fan_out, unreachable: [], sources: [{ name: "bank_entries", exhausted: true }, { name: "shared_banks", exhausted: true }, { name: "quiz_uses", exhausted: true }] } }, "item_bank_fan_out_authoritative_reach_claim_refused"],
    ["an unacknowledged observed course", { acknowledged_course_ids: [] }, "item_bank_fan_out_acknowledgement_mismatch"],
    ["a hidden external course", { fan_out: { ...base.fan_out, external_course_ids: [] }, acknowledged_course_ids: [] }, "item_bank_fan_out_external_course_ids_mismatch"],
    ["a consumer list that does not match its digest", { fan_out: { ...base.fan_out, consumers: [] } }, "item_bank_fan_out_consumer_count_mismatch"],
    ["a record from another bank", { fan_out: { ...base.fan_out, bank_id: "92" } }, "item_bank_fan_out_bank_mismatch"],
    ["a record with no timestamp", { fan_out: { ...base.fan_out, established_at: "just now" } }, "item_bank_fan_out_established_at_unreadable"],
    ["a record from the future", { fan_out: { ...base.fan_out, established_at: new Date(Date.now() + 60_000).toISOString() } }, "item_bank_fan_out_record_from_future"],
    ["a record older than one hour", { fan_out: { ...base.fan_out, established_at: new Date(Date.now() - 61 * 60 * 1_000).toISOString() } }, "item_bank_fan_out_record_too_old"],
    ["no record at all", { fan_out: undefined }, "fan_out is required"],
    ["a record that is not an object", { fan_out: "none" }, "item_bank_fan_out_missing_record"],
  ];
  for (const [label, overrides, expected] of cases) {
    await withPageContext(async () => {
      const api = provider();
      globalThis.fetch = api.fetch;
      const result = await executeItemBankInPage(input("rename_bank", {
        course_id: "42", bank_id: "91", title: "Renamed",
        expected_snapshot: { bank_sha256: await digest(api.state.banks[0]) }, ...base, ...overrides,
      }));
      assert.equal(result.error, expected, label);
      assert.equal(result.sent, false, label);
      assert.equal(api.dispatches(), 0, label);
    });
  }
});

test("an acknowledged observed external course lets the reviewed change through", async () => {
  await withPageContext(async () => {
    const api = provider();
    globalThis.fetch = api.fetch;
    const result = await executeItemBankInPage(input("rename_bank", {
      course_id: "42", bank_id: "91", title: "Renamed",
      expected_snapshot: { bank_sha256: await digest(api.state.banks[0]) },
      ...await observed({ consumers: [{ course_id: "9", entity_type: "quiz", entity_id: "5150" }, { course_id: "77", entity_type: "course", entity_id: "77" }], acknowledged: ["77", "9"] }),
    }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.verification.status, "verified");
    assert.equal(api.dispatches(), 1);
  });
});

test("a bank the selected course does not hold is refused before any bank request", async () => {
  await withPageContext(async () => {
    const api = provider();
    globalThis.fetch = api.fetch;
    const result = await executeItemBankInPage(input("rename_bank", {
      course_id: "42", bank_id: "92", title: "Renamed",
      expected_snapshot: { bank_sha256: "e".repeat(64) }, ...await observed({ bankId: "92" }),
    }));
    assert.equal(result.error, "item_bank_course_association_unverified");
    assert.equal(result.sent, false);
    assert.equal(api.dispatches(), 0);
    assert.deepEqual([...new Set(api.requests.map((request) => request.path))], ["/api/banks"]);
  });
});

test("share reads make one unpaged request and report pagination as unestablished", async () => {
  await withPageContext(async () => {
    const p = provider(); p.state.shares.push({ id: "1", entity_type: "course", entity_id: "course-context-77", permission: "read" });
    globalThis.fetch = p.fetch;
    const result = await executeItemBankInPage(input("list_shares", { course_id: "42", bank_id: "91" }));
    assert.equal(result.ok, true);
    assert.equal(result.truncated, true);
    assert.equal(result.paginationComplete, false);
    assert.equal(result.paginationUnestablished, true);
    const requests = p.requests.filter((request) => request.path === "/api/banks/91/shared_banks");
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].query, {});
  });
});

test("an unsupported share scope or permission is refused before any preflight read", async () => {
  for (const [label, extra] of [
    ["an account share", { entity_type: "account" }],
    ["an edit permission", { entity_type: "course", permission: "edit" }],
  ]) {
    await withPageContext(async () => {
      const api = provider(); globalThis.fetch = api.fetch;
      const result = await executeItemBankInPage(input("share_bank", {
        course_id: "42", bank_id: "91", entity_id: "77", ...extra,
        expected_snapshot: { bank_sha256: await digest(api.state.banks[0]), shares_sha256: await digest([]) }, ...await observed(),
      }));
      assert.match(result.error, /^item_bank_share_(?:scope|permission)_unsupported$/, label);
      assert.equal(result.sent, false, label);
      assert.equal(api.dispatches(), 0, label);
    });
  }
});

test("a share row is read with either key casing, before the write and after it", async () => {
  // Canvas pins no one casing for a share row, and Morrow's own request body
  // mixes them, so all three shapes are live. Both readers of a share row are
  // exercised over each one: the pre-write duplicate check and the post-write
  // readback of the same write. A reader quietly stricter than its twin compares
  // against "undefined", so it either sends a duplicate share or reports a share
  // Canvas did create as unconfirmed.
  const shapes = [
    ["snake", "snake", { id: "1", bank_id: "91", entity_id: "77", entity_type: "course", permission: "read" }],
    ["camel", "camel", { id: "1", bank_id: "91", entityId: "77", entityType: "course", permission: "read" }],
    ["the mixed casing Morrow itself sends", undefined, { id: "1", bank_id: "91", entity_id: "77", entityType: "course", permission: "read" }],
  ];
  for (const [label, casing, row] of shapes) {
    await withPageContext(async () => {
      const api = provider({ shareCasing: casing });
      api.state.shares.push(row);
      globalThis.fetch = api.fetch;
      const result = await executeItemBankInPage(input("share_bank", {
        course_id: "42", bank_id: "91", entity_type: "course", entity_id: "77", permission: "read",
        expected_snapshot: { bank_sha256: await digest(api.state.banks[0]), shares_sha256: await digest(api.state.shares) },
        ...await observed(),
      }));
      assert.equal(result.error, "item_bank_share_already_present", label);
      assert.equal(result.sent, false, label);
      assert.equal(api.dispatches(), 0, label);
      assertPrivate(result, `share_bank already present, ${label}`);
    });
    await withPageContext(async () => {
      const api = provider({ shareCasing: casing });
      globalThis.fetch = api.fetch;
      const result = await executeItemBankInPage(input("share_bank", {
        course_id: "42", bank_id: "91", entity_type: "course", entity_id: "77", permission: "read",
        expected_snapshot: { bank_sha256: await digest(api.state.banks[0]), shares_sha256: await digest(api.state.shares) },
        ...await observed(),
      }));
      assert.equal(result.ok, true, `${label}: ${JSON.stringify(result)}`);
      assert.equal(result.verification.status, "verified", label);
      assert.equal(result.verification.evidence, "exact_course_read_share_found", label);
      assert.equal(result.outcomeUnknown, false, label);
      assert.equal(api.dispatches(), 1, label);
      assertPrivate(result, `share_bank readback, ${label}`);
    });
  }
});

test("a share a tenant applied but answered for in another casing is still refused as a duplicate", async () => {
  // The readback casing and the pre-existing row casing are independent: a
  // tenant may store one shape and answer another. Neither reader may depend on
  // the two agreeing.
  for (const [stored, answered] of [["snake", "camel"], ["camel", "snake"]]) {
    await withPageContext(async () => {
      const api = provider({ shareCasing: answered });
      api.state.shares.push(stored === "snake"
        ? { id: "1", bank_id: "91", entity_id: "77", entity_type: "course", permission: "read" }
        : { id: "1", bank_id: "91", entityId: "77", entityType: "course", permission: "read" });
      globalThis.fetch = api.fetch;
      const result = await executeItemBankInPage(input("share_bank", {
        course_id: "42", bank_id: "91", entity_type: "course", entity_id: "77", permission: "read",
        expected_snapshot: { bank_sha256: await digest(api.state.banks[0]), shares_sha256: await digest(api.state.shares) },
        ...await observed(),
      }));
      assert.equal(result.error, "item_bank_share_already_present", `${stored} row, ${answered} tenant`);
      assert.equal(api.dispatches(), 0, stored);
    });
  }
});

test("a duplicate effect is refused instead of sent a second time", async () => {
  const cases = [
    ["create_bank", async (api) => ({ course_id: "42", title: "Bank A", language: "en", expected_snapshot: { banks_sha256: await digest(api.state.banks) } }), "item_bank_create_recovery_ambiguous"],
    ["attach_item", async (api) => ({ course_id: "42", bank_id: "91", item_id: "501", expected_snapshot: { bank_sha256: await digest(api.state.banks[0]), item_sha256: await digest(asRead(api.state.items.get("501"))), entries_sha256: await digest([...api.state.entries.values()].map((row) => embeddedEntry(api.state, row))) }, ...await observed() }), "item_bank_item_already_attached"],
    ["share_bank", async (api) => { api.state.shares.push({ id: "1", entity_id: "77", entity_type: "course", permission: "read" }); return { course_id: "42", bank_id: "91", entity_type: "course", entity_id: "77", permission: "read", expected_snapshot: { bank_sha256: await digest(api.state.banks[0]), shares_sha256: await digest(api.state.shares) }, ...await observed() }; }, "item_bank_share_already_present"],
  ];
  for (const [nickname, argsFor, expected] of cases) {
    await withPageContext(async () => {
      const api = provider(); globalThis.fetch = api.fetch;
      const result = await executeItemBankInPage(input(nickname, await argsFor(api)));
      assert.equal(result.error, expected, nickname);
      assert.equal(result.sent, false, nickname);
      assert.equal(api.dispatches(), 0, nickname);
    });
  }
});

test("a bank creation whose answer carries no id is never resolved by matching a title", async () => {
  // Morrow's create is dispatched and its answer is lost. In the same window
  // another person with access to this course creates a bank with the same title
  // and language, including the same person retrying in the Canvas UI after
  // Morrow appeared to fail, and Morrow's own create did not land. A recovery
  // that relisted the course and took the one new row matching the title would
  // adopt that person's bank, then confirm its title, its language and its course
  // association, all of which match by construction, and report Morrow's own
  // verified creation with that bank's id as the target for every later
  // operation. Title and language are a label a person chose, not an identity.
  await withPageContext(async () => {
    const api = provider();
    let dispatches = 0;
    globalThis.fetch = async (url, options = {}) => {
      if ((options.method || "GET") !== "GET") {
        dispatches += 1;
        api.state.banks.push({ id: "77", title: "Bank B", language: "fr" });
        return new Response("", { status: 503, headers: { "content-type": "application/json" } });
      }
      return api.fetch(url, options);
    };
    const result = await executeItemBankInPage(input("create_bank", {
      course_id: "42", title: "Bank B", language: "fr",
      expected_snapshot: { banks_sha256: await digest(api.state.banks) },
    }));
    assert.equal(result.sent, true, JSON.stringify(result));
    assert.equal(result.ok, false);
    assert.equal(result.outcomeUnknown, true);
    assert.equal(result.verification.status, "unconfirmed");
    assert.equal(result.verification.reason, "created_bank_id_not_returned");
    // The bank another person created is never handed back as Morrow's target.
    assert.equal(api.state.banks.some((bank) => bank.id === "77"), true);
    assert.equal(JSON.stringify(result).includes("targetId"), false);
    assert.equal(dispatches, 1);
    assertPrivate(result, "create_bank lost answer");
  });
  // The same refusal holds when the create did land but its answer was lost, and
  // when two new rows match. Neither case may pick one.
  for (const label of ["the create landed and its answer was lost", "two new rows match the title"]) {
    await withPageContext(async () => {
      const api = provider();
      let dispatches = 0;
      globalThis.fetch = async (url, options = {}) => {
        if ((options.method || "GET") !== "GET") {
          dispatches += 1;
          api.state.banks.push({ id: "77", title: "Bank B", language: "fr" });
          if (label.startsWith("two")) api.state.banks.push({ id: "78", title: "Bank B", language: "fr" });
          return new Response("{ not json", { status: 500, headers: { "content-type": "application/json" } });
        }
        return api.fetch(url, options);
      };
      const result = await executeItemBankInPage(input("create_bank", {
        course_id: "42", title: "Bank B", language: "fr",
        expected_snapshot: { banks_sha256: await digest(api.state.banks) },
      }));
      assert.equal(result.sent, true, label);
      assert.equal(result.ok, false, label);
      assert.equal(result.outcomeUnknown, true, label);
      assert.equal(result.verification.status, "unconfirmed", label);
      assert.equal(result.verification.reason, "created_bank_id_not_returned", label);
      assert.equal(JSON.stringify(result).includes("targetId"), false, label);
      assert.equal(dispatches, 1, label);
      assertPrivate(result, label);
    });
  }
});

test("a bank creation Canvas answered with its own id is still reread and verified", async () => {
  // Refusing to guess must not cost the honest case: an id Canvas returned is an
  // identity, so the created bank is reread by that id and confirmed.
  await withPageContext(async () => {
    const api = provider();
    globalThis.fetch = api.fetch;
    const result = await executeItemBankInPage(input("create_bank", {
      course_id: "42", title: "Bank B", language: "fr",
      expected_snapshot: { banks_sha256: await digest(api.state.banks) },
    }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.verification.status, "verified");
    assert.equal(result.verification.targetId, "92");
    assert.equal(result.outcomeUnknown, false);
    assert.equal(api.dispatches(), 2);
    const share = api.requests.find((entry) => entry.method === "POST" && entry.path === "/api/banks/92/shared_banks");
    assert.deepEqual(share?.body, { shared_bank: { entity_id: CONTEXT_UUID, entityType: "course", bank_id: "92", permission: "read" } });
    assertPrivate(result, "create_bank verified");
  });
});

test("a reviewed question payload without its matching certificate is refused", async () => {
  for (const [label, certificate] of [["no certificate", undefined], ["a certificate for another payload", "f".repeat(64)], ["a certificate that is not a digest", "nope"]]) {
    await withPageContext(async () => {
      const api = provider(); globalThis.fetch = api.fetch;
      const request = input("create_item", {
        course_id: "42", bank_id: "91", item: { entry_type: "Item", entry: { title: "Q", item_body: "<p>Q</p>" } },
        expected_snapshot: { bank_sha256: await digest(api.state.banks[0]) }, ...await observed(),
      });
      request.payloadContractSha256 = certificate;
      const result = await executeItemBankInPage(request);
      assert.equal(result.error, "item_bank_payload_contract_unverified", label);
      assert.equal(result.sent, false, label);
      assert.equal(api.dispatches(), 0, label);
    });
  }
});

test("tenant, principal, course, credential and descriptor mismatches stop before fetch", async () => {
  const capturedAt = Date.now();
  const cases = [
    ["another signed-in person", (value) => ({ ...value, principalId: "8" })],
    ["another course", (value) => ({ ...value, courseId: "43" })],
    ["no credential", (value) => ({ ...value, credential: undefined })],
    ["a credential from another launch", (value) => ({ ...value, credential: { ...value.credential, launchUrl: "https://school.instructure.com/courses/43/external_tools/54065" } })],
    ["a credential for another deployment", (value) => ({ ...value, credential: { ...value.credential, externalToolId: "71234" } })],
    ["a credential older than ten minutes", (value) => ({ ...value, credential: { ...value.credential, launchedAt: capturedAt - 11 * 60 * 1_000 - 1_000, capturedAt: capturedAt - 11 * 60 * 1_000 } })],
    ["a credential for another tenant", (value) => ({ ...value, credential: { ...value.credential, apiOrigin: "https://other.quiz-api.instructure.com" } })],
    ["a route that is not this operation", (value) => ({ ...value, operation: { ...value.operation, path: "/api/other" } })],
  ];
  for (const [label, mutate] of cases) {
    await withPageContext(async () => {
      let calls = 0; globalThis.fetch = async () => { calls += 1; return new Response("{}"); };
      const result = await executeItemBankInPage(mutate(input("list_banks", { course_id: "42" })));
      assert.notEqual(result.ok, true, label); assert.equal(calls, 0, label);
    });
  }
  // The frame itself must be the exact Item Banks frame of the exact launch.
  for (const [label, overrides] of [
    ["a frame on another host", { location: { hostname: "school.instructure.com" } }],
    ["a launch opened from another origin", { document: { referrer: "https://evil.example/courses/42/external_tools/54065" } }],
  ]) {
    await withPageContext(async () => {
      let calls = 0; globalThis.fetch = async () => { calls += 1; return new Response("{}"); };
      const result = await executeItemBankInPage(input("list_banks", { course_id: "42" }));
      assert.equal(result.matched, false, label); assert.equal(calls, 0, label);
    }, overrides);
  }
  await withPageContext(async () => {
    let calls = 0; globalThis.fetch = async () => { calls += 1; return new Response("{}"); };
    const result = await executeItemBankInPage(input("list_banks", { course_id: "42" }));
    assert.equal(result.matched, true);
    assert.equal(result.error, "item_bank_credential_unavailable");
    assert.equal(calls, 0);
  }, { document: { referrer: "https://school.instructure.com/courses/42/external_tools/9" } });
});

test("an expired Item Bank command starts no provider request", async () => {
  await withPageContext(async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; throw new Error("expired request reached fetch"); };
    const result = await executeItemBankInPage({
      ...input("list_banks", { course_id: "42" }),
      expiresAt: Date.now() - 1,
    });
    assert.deepEqual(result, { matched: true, ok: false, sent: false, error: "item_bank_operation_timeout" });
    assert.equal(calls, 0);
  });
});

// The deadline can also pass after the last pinned snapshot read returns, while that snapshot is
// sanitized, stringified and digested. The write is refused before it is dispatched, so nothing
// reached Canvas: a write reported as sent with an unknown outcome would hold the bank until a
// person states what Canvas shows.
test("a deadline that passes after the snapshot reads leaves the write unsent", async () => {
  for (const shape of WRITE_SHAPES) {
    const { api: measured } = await runShape(shape);
    const readsBeforeWrite = measured.requests.findIndex((entry) => entry.method !== "GET");
    assert.ok(readsBeforeWrite > 0, shape.nickname);
    const { result, api } = await withPageContext(async () => {
      const api = provider();
      const args = await shape.args(api.state);
      const request = input(shape.nickname, args);
      request.expiresAt = Date.now() + 60_000;
      if (["create_item", "update_item"].includes(shape.nickname)) request.payloadContractSha256 = await digest(args.item);
      globalThis.fetch = async (url, options = {}) => {
        const response = await api.fetch(url, options);
        if (api.requests.length >= readsBeforeWrite) request.expiresAt = Date.now() - 1;
        return response;
      };
      const result = await executeItemBankInPage(request);
      assertPrivate(result, shape.nickname);
      return { result, api };
    });
    assert.equal(api.dispatches(), 0, `${shape.nickname}: ${JSON.stringify(result)}`);
    assert.equal(result.sent, false, `${shape.nickname}: ${JSON.stringify(result)}`);
    assert.notEqual(result.outcomeUnknown, true, shape.nickname);
    assert.equal(result.ok, false, shape.nickname);
  }
});

// The bank search reads an index the service fills after the tag write returns. Measured live
// on 2026-09-19: the question a tag was just added to is missing from that search for about a
// second and a half, so one immediate read would report a saved tag as missing.
test("a tag is verified once the search the service fills catches up, and a tag that never appears is a mismatch", async () => {
  for (const [lateReads, expected] of [[2, "verified"], [99, "mismatch"]]) {
    await withPageContext(async () => {
      const api = provider();
      let searches = 0;
      globalThis.fetch = async (url, options = {}) => {
        const path = new URL(url).pathname;
        if (path === "/api/banks/91/bank_entries/search" && (options.method || "GET") === "GET") {
          searches += 1;
          if (searches <= lateReads) {
            return new Response(JSON.stringify({ total: 0, entries: [] }), { status: 200, headers: { "content-type": "application/json" } });
          }
        }
        return await api.fetch(url, options);
      };
      const shape = WRITE_SHAPES.find((candidate) => candidate.nickname === "add_entry_tag");
      const result = await executeItemBankInPage(input(shape.nickname, await shape.args(api.state)));
      assert.equal(result.sent, true);
      assert.equal(result.verification.status, expected, JSON.stringify(result.verification));
      assert.equal(result.ok, expected === "verified");
      // The tag is written once however many times the search is read.
      assert.equal(api.requests.filter((request) => request.method === "POST" && request.path.endsWith("/tag_associations")).length, 1);
      assert.ok(searches > 1, "the search was read again after it disagreed");
    });
  }
});

// Canvas has no read that reports one question's tags, so a removal names the tag by its value:
// Morrow resolves the exact tag, proves this question carries it, and asks Canvas for the
// association by posting that same tag again, which adds nothing.
test("a tag is removed by its value, and a tag the question does not carry is refused before any write", async () => {
  await withPageContext(async () => {
    const api = provider();
    globalThis.fetch = api.fetch;
    // The question already carries "Chapter: 01".
    api.state.tagged.set("401", ["23"]);
    api.state.associations.set("401:23", { id: "7600", tag_id: "23", tag_value: "Chapter: 01" });
    const args = async (overrides) => ({
      course_id: "42", bank_id: "91", bank_entry_id: "401",
      expected_snapshot: { bank_sha256: await digest(api.state.banks[0]), entry_sha256: await digest(embeddedEntry(api.state, api.state.entries.get("401"))) },
      ...await observed(), ...overrides,
    });

    const absent = await executeItemBankInPage(input("remove_entry_tag", await args({ tag_value: "Chapter: 02" })));
    assert.deepEqual(absent, { matched: true, ok: false, sent: false, error: "item_bank_tag_value_unresolved" });
    assert.equal(api.dispatches(), 0);

    api.state.tags.push({ id: "24", value: "Chapter: 02" });
    const untagged = await executeItemBankInPage(input("remove_entry_tag", await args({ tag_value: "Chapter: 02" })));
    assert.deepEqual(untagged, { matched: true, ok: false, sent: false, error: "item_bank_question_does_not_carry_that_tag" });
    assert.equal(api.dispatches(), 0);

    const result = await executeItemBankInPage(input("remove_entry_tag", await args({ tag_value: "Chapter: 01" })));
    assert.equal(result.ok, true, JSON.stringify(result.verification ?? result));
    assert.equal(result.verification.status, "verified");
    assert.deepEqual(api.state.tagged.get("401"), []);
    // One resolving post that added nothing, then exactly one delete.
    assert.deepEqual(api.requests.filter((request) => request.method !== "GET").map((request) => `${request.method} ${request.path}`), [
      "POST /api/bank_entries/401/tag_associations",
      "DELETE /api/bank_entries/401/tag_associations/7600",
    ]);
  });
});

// Canvas has no route that deletes a share: its own Item Banks page unshares a bank by setting
// that share's permission to removed_access, so that is how Morrow removes one.
test("a share is removed by the permission Canvas uses for it, answered as either shape", async () => {
  for (const answer of ["row", "absent"]) {
    await withPageContext(async () => {
      const api = provider();
      globalThis.fetch = async (url, options = {}) => {
        const path = new URL(url).pathname;
        const method = options.method || "GET";
        if (path === "/api/banks/91/shared_banks/1" && method === "PATCH") {
          const sent = JSON.parse(options.body).shared_bank;
          api.requests.push({ method, path, body: JSON.parse(options.body) });
          if (answer === "absent") api.state.shares = api.state.shares.filter((row) => String(row.id) !== "1");
          else api.state.shares = api.state.shares.map((row) => String(row.id) === "1" ? { ...row, ...sent } : row);
          return new Response(JSON.stringify({ id: "1", ...sent }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return await api.fetch(url, options);
      };
      api.state.shares.push({ id: "1", bank_id: "91", entity_type: "course", entity_id: "77", permission: "read" });
      const result = await executeItemBankInPage(input("update_share", {
        course_id: "42", bank_id: "91", share_id: "1", permission: "removed_access",
        expected_snapshot: { bank_sha256: await digest(api.state.banks[0]), shares_sha256: await digest(sharesAsRead(api.state)) },
        ...await observed(),
      }));
      assert.equal(result.ok, true, `${answer}: ${JSON.stringify(result.verification ?? result)}`);
      assert.equal(result.verification.evidence, "exact_share_removed_reread");
      assert.deepEqual(api.requests.filter((request) => request.method === "PATCH").map((request) => request.body),
        [{ shared_bank: { permission: "removed_access" } }]);
    });
  }
});

test("a share Canvas still reports as readable is not taken for a removed one", async () => {
  await withPageContext(async () => {
    const api = provider();
    globalThis.fetch = async (url, options = {}) => {
      const path = new URL(url).pathname;
      if (path === "/api/banks/91/shared_banks/1" && (options.method || "GET") === "PATCH") {
        api.requests.push({ method: "PATCH", path });
        return new Response(JSON.stringify({ id: "1", permission: "read" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return await api.fetch(url, options);
    };
    api.state.shares.push({ id: "1", bank_id: "91", entity_type: "course", entity_id: "77", permission: "read" });
    const result = await executeItemBankInPage(input("update_share", {
      course_id: "42", bank_id: "91", share_id: "1", permission: "removed_access",
      expected_snapshot: { bank_sha256: await digest(api.state.banks[0]), shares_sha256: await digest(sharesAsRead(api.state)) },
      ...await observed(),
    }));
    assert.equal(result.ok, false);
    assert.equal(result.sent, true);
    assert.equal(result.verification.status, "mismatch");
    assert.equal(result.verification.reason, "share_still_present");
  });
});
