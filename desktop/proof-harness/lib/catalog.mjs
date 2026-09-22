// The catalog-driven argument filler and the seed pool of real ids read from the sandbox course.
// Ported from the live BT2 sweep, which is where this machinery was proven: one pool of ids read
// once, an argument filled from the catalog's own parameter list, and a receipt that survives a
// stop so a long run resumes where it left off.
// Shared machinery for the full BT2 sweep: one seed pool of real ids read from
// Canvas, a catalog-driven argument filler, and receipts that survive a stop so a
// sweep resumes where it left off. Person ids are learner tokens, because that is
// how Morrow addresses a person across its privacy boundary.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { SANDBOX, SOURCE_BINDING as SB, connect } from "../connect.mjs";
import { makeTools } from "./tools.mjs";

const COURSE = SANDBOX.courseId;

export const CATALOG = JSON.parse(readFileSync(new URL("../../artifacts/canvas-api/canvas-api-catalog.json", import.meta.url), "utf8"));
export const OPERATIONS = CATALOG.operations;
export { COURSE, SB, connect, makeTools };

export function loadReceipt(path, seed) {
  if (existsSync(path)) {
    try { return JSON.parse(readFileSync(path, "utf8")); } catch { /* start again */ }
  }
  return seed;
}

export function saveReceipt(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

// Canvas returns some collections inside an envelope named after the kind, such
// as { polls: [...] }. Those records are the collection, not one record holding
// a list, so the envelope is opened before the records are read.
const envelopeOf = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  // Canvas adds its own `meta` beside the records, so the collection is the one
  // field that holds a list, not the only field.
  const lists = Object.keys(value).filter((key) => Array.isArray(value[key]));
  return lists.length === 1 ? value[lists[0]] : null;
};

const rows = (value) => {
  if (Array.isArray(value)) {
    // A read over several pages returns one envelope per page, so the records
    // are every page's records rather than the pages themselves.
    const pages = value.map((page) => envelopeOf(page));
    if (value.length > 0 && pages.every((page) => page !== null)) return pages.flat();
    return value;
  }
  const held = envelopeOf(value);
  if (held) return held;
  return value && typeof value === "object" ? [value] : [];
};
const idOf = (row, ...names) => {
  for (const name of names) {
    const value = row?.[name];
    if (value !== undefined && value !== null && String(value) !== "") return String(value);
  }
  return null;
};

const SEED_CACHE = new URL("../seed-pool.json", import.meta.url);

/**
 * The seed pool, read from Canvas once and kept on disk. Several sweep workers
 * share one connection to Canvas, so seeding once keeps the course reads out of
 * everyone else's way.
 */
export async function cachedSeedPool(read, log, { refresh = false } = {}) {
  if (!refresh && existsSync(SEED_CACHE)) {
    try {
      const cached = JSON.parse(readFileSync(SEED_CACHE, "utf8"));
      if (cached && typeof cached === "object" && cached.course_id) {
        if (log) await log(`seed pool: reused ${Object.keys(cached).length} kinds`);
        return cached;
      }
    } catch { /* seed again */ }
  }
  const pool = await seedPool(read, log);
  writeFileSync(SEED_CACHE, `${JSON.stringify(pool, null, 2)}\n`, { mode: 0o600 });
  return pool;
}

/** Real ids this sweep may use, read from the connected course and person. */
export async function seedPool(read, log) {
  const pool = { course_id: COURSE, user_id: "self" };
  // A seed read that fails leaves its whole family without an id, and every
  // operation of that family is then recorded unreachable for a reason that has
  // nothing to do with it. A reading can fail because the course connection was
  // briefly rebuilding, so it is asked twice before its kind is left unset.
  const take = async (tool, args, assign) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const value = await read(tool, args);
        if (value.ok) { assign(rows(value.data)); return; }
      } catch { /* try once more before leaving the kind unset */ }
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    if (log) await log(`seed ${tool}: no answer, its kind stays unset`);
  };
  const first = (list, assign, ...names) => {
    for (const row of list) {
      const value = idOf(row, ...names);
      if (value) { assign(value, row); return; }
    }
  };

  await take("canvas_list_assignments_assignments", { course_id: COURSE }, (list) => first(list, (v) => { pool.assignment_id = v; }, "id"));
  await take("canvas_list_pages_courses", { course_id: COURSE }, (list) => first(list, (v) => { pool.url_or_id = v; pool.page_id = v; }, "url", "page_id"));
  await take("canvas_list_modules", { course_id: COURSE }, (list) => first(list, (v) => { pool.module_id = v; }, "id"));
  await take("canvas_list_quizzes_in_course", { course_id: COURSE }, (list) => first(list, (v) => { pool.quiz_id = v; }, "id"));
  await take("canvas_list_discussion_topics_courses", { course_id: COURSE }, (list) => first(list, (v) => { pool.topic_id = v; }, "id"));
  await take("canvas_list_course_sections", { course_id: COURSE }, (list) => first(list, (v) => { pool.section_id = v; }, "id"));
  await take("canvas_list_assignment_groups", { course_id: COURSE }, (list) => first(list, (v) => { pool.assignment_group_id = v; }, "id"));
  await take("canvas_list_files_courses", { course_id: COURSE }, (list) => first(list, (v) => { pool.file_id = v; }, "id"));
  await take("canvas_list_all_folders_courses", { course_id: COURSE }, (list) => first(list, (v) => { pool.folder_id = v; }, "id"));
  await take("canvas_list_rubrics_courses", { course_id: COURSE }, (list) => first(list, (v) => { pool.rubric_id = v; }, "id"));
  await take("canvas_list_external_tools_courses", { course_id: COURSE }, (list) => first(list, (v) => { pool.external_tool_id = v; pool.tool_id = v; }, "id"));
  await take("canvas_list_calendar_events", { context_codes: [`course_${COURSE}`], all_events: true }, (list) => first(list, (v) => { pool.event_id = v; }, "id"));
  await take("canvas_list_your_courses", {}, (list) => first(list, (v) => { pool.account_id = v; }, "account_id"));
  // Canvas keeps terms, SIS imports and reports on the root account, so a
  // sub-account answers "no such thing" for every one of them. The root account
  // this person administers is the account those readings are about. Only
  // readings use it: this sweep sends no change outside the connected course.
  await take("canvas_list_accounts", { morrow_max_pages: 2 }, (list) => {
    const root = list.find((row) => row && row.parent_account_id === null && row.root_account_id === null);
    if (root?.id) pool.account_id = String(root.id);
  });
  if (pool.account_id) {
    await take("canvas_list_enrollment_terms", { account_id: pool.account_id }, (list) => first(list, (v) => { pool.term_id = v; pool.enrollment_term_id = v; }, "id"));
    await take("canvas_get_sis_import_list", { account_id: pool.account_id }, (list) => first(list, (v) => { pool.sis_import_id = v; }, "id"));
    await take("canvas_list_available_reports", { account_id: pool.account_id }, (list) => first(list, (v) => { pool.report_type = v; pool.report = v; }, "report", "title"));
  }
  await take("canvas_list_group_categories_for_context_courses", { course_id: COURSE }, (list) => first(list, (v) => { pool.group_category_id = v; }, "id"));
  await take("canvas_list_groups_available_in_context_courses", { course_id: COURSE }, (list) => first(list, (v) => { pool.group_id = v; }, "id"));
  await take("canvas_list_conversations", {}, (list) => first(list, (v) => { pool.conversation_id = v; }, "id"));
  // A folder names its own path, which is what the by-path routes read.
  await take("canvas_list_all_folders_courses", { course_id: COURSE }, (list) => first(list, (v) => { pool.full_path = v; }, "full_name"));
  await take("canvas_list_user_communication_channels", { user_id: "self" }, (list) => first(list, (v, row) => {
    pool.communication_channel_id = v;
    if (row?.type) pool.type = String(row.type);
    // Morrow removes the address across its privacy boundary, and a removal
    // notice is not an address. The reads that need one stay unreachable.
    if (typeof row?.address === "string" && !/^\[.*\]$/.test(row.address.trim())) pool.address = row.address;
  }, "id"));
  await take("canvas_list_question_banks", { course_id: COURSE, context_id: COURSE }, (list) => first(list, (v) => { pool.question_bank_id = v; }, "id"));
  // A New Quiz is an assignment Canvas marks as its own quiz kind, and the
  // New Quizzes service addresses it by that assignment id.
  await take("canvas_list_assignments_assignments", { course_id: COURSE, morrow_max_pages: 3 }, (list) => {
    const quiz = list.find((row) => row?.is_quiz_lti_assignment === true);
    if (quiz?.id) pool["quiz:assignment_id"] = String(quiz.id);
  });
  await take("canvas_list_polls", {}, (list) => first(list, (v) => { pool.poll_id = v; }, "id"));
  if (pool.poll_id) {
    await take("canvas_list_poll_sessions", { poll_id: pool.poll_id }, (list) => first(list, (v) => { pool.poll_session_id = v; }, "id"));
    await take("canvas_list_poll_choices_in_poll", { poll_id: pool.poll_id }, (list) => first(list, (v) => { pool.poll_choice_id = v; }, "id"));
  }
  await take("canvas_list_appointment_groups", {}, (list) => first(list, (v) => { pool.appointment_group_id = v; }, "id"));
  await take("canvas_list_question_banks", { course_id: COURSE }, (list) => first(list, (v) => { pool.question_bank_id = v; pool.bank_id = v; }, "id"));
  await take("canvas_list_content_migrations_courses", { course_id: COURSE }, (list) => first(list, (v) => { pool.content_migration_id = v; }, "id"));
  await take("canvas_list_blackout_dates_courses", { course_id: COURSE }, (list) => first(list, (v) => { pool.blackout_date_id = v; }, "id"));
  await take("canvas_list_line_items", { course_id: COURSE }, (list) => first(list, (v) => { pool.line_item_id = v; }, "id"));
  await take("canvas_list_media_objects_courses_media_objects", { course_id: COURSE }, (list) => first(list, (v) => { pool.media_object_id = v; pool.attachment_id = v; }, "media_id", "id"));
  await take("canvas_list_enabled_features_courses", { course_id: COURSE }, (list) => {
    const name = list.find((row) => typeof row === "string") || null;
    if (name) pool.feature = name;
  });
  await take("canvas_list_outcome_groups_courses", { course_id: COURSE }, (list) => first(list, (v) => { pool.outcome_group_id = v; }, "id"));
  await take("canvas_get_all_eportfolios_for_user", { user_id: "self" }, (list) => first(list, (v) => { pool.eportfolio_id = v; }, "id"));
  // A person is named by the learner token Morrow gives across its privacy
  // boundary, never by a raw Canvas person id.
  await take("canvas_list_enrollments_courses", { course_id: COURSE }, (list) => {
    first(list, (v) => { pool.enrollment_id = v; }, "id");
    for (const row of list) {
      if (typeof row?.learnerToken === "string" && row.learnerToken.trim()) {
        pool.learner_token = row.learnerToken;
        break;
      }
    }
  });
  if (pool.learner_token) {
    pool.student_id = pool.learner_token;
    pool.course_user_id = pool.learner_token;
  }
  // The same object under another route's name for it. An alias is never a new
  // id: it repeats one this sweep already read from the connected course.
  if (pool.module_id) pool.context_module_id = pool.module_id;
  if (pool.file_id && !pool.attachment_id) pool.attachment_id = pool.file_id;
  if (pool.quiz_id) pool.assignment_or_quiz_id = pool.quiz_id;
  if (pool.content_migration_id) pool.content_migration_id_or_migration_id = pool.content_migration_id;

  if (log) await log(`seed pool: ${Object.entries(pool).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  return pool;
}

/**
 * The arguments for one operation, taken from the seed pool. A required id with
 * no real value returns the names it lacks, which is how an operation is reported
 * as unreachable instead of being attempted with an invented id.
 */
/**
 * A value the operation's own schema accepts for a required input that names no
 * object: an enum takes its first value, and the plain types take the smallest
 * value Canvas documents. An id has no such value and is never invented.
 */
// A value Canvas accepts for an input that names no object. The input's own name
// says what shape it wants: a url is a url, a date is a date, a colour is a
// colour. Sending the word "sweep" where Canvas wants a url proves nothing about
// Morrow, only that Canvas reads its own contract.
const NAMED_VALUE = [
  [/(?:^|_)(?:url|uri|href|feed_url|redirect_uri)$/, "https://example.edu/morrow-sweep"],
  [/(?:^|_)(?:email|contact)$/, "morrow-sweep@example.edu"],
  [/(?:^|_)(?:at|date|start|end|due|unlock|lock|until)$/, "2026-10-04T15:00:00Z"],
  [/(?:^|_)(?:color|colour)$/, "3366AA"],
  [/(?:^|_)(?:domain|host)$/, "example.edu"],
  [/(?:^|_)(?:locale|language)$/, "en"],
  [/(?:^|_)(?:time_zone|timezone)$/, "America/Chicago"],
  [/(?:^|_)(?:migration_type)$/, "course_copy_importer"],
  [/(?:^|_)(?:sis_.*_id|integration_id)$/, "morrow-sweep"],
  [/^address$/, "morrow-sweep@example.edu"],
  // Canvas names a context by its kind and id, and a custom-data namespace by a
  // reverse-domain string. The word "sweep" in either place proves nothing.
  [/(?:^|_)context_codes$/, `course_${COURSE}`],
  [/^ns$/, "com.morrow.sweep"],
  [/(?:^|_)(?:body|message|description|instructions|text|comment)$/, "Morrow sweep"],
];

function namedValue(name) {
  for (const [pattern, value] of NAMED_VALUE) if (pattern.test(name)) return value;
  return null;
}

function schemaValue(parameter) {
  const schema = parameter.schema || {};
  const name = String(parameter.inputName || "");
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.type === "array") {
    const items = schema.items || {};
    if (Array.isArray(items.enum) && items.enum.length) return [items.enum[0]];
    if (items.type === "string" && !items.pattern) return [namedValue(name) ?? "Morrow sweep"];
    if (items.type === "integer" || items.type === "number") return [1];
    return null;
  }
  if (schema.type === "boolean") return true;
  if (schema.type === "integer" || schema.type === "number") return 1;
  if (schema.type === "string") {
    const named = namedValue(name);
    if (named && (!schema.pattern || new RegExp(schema.pattern).test(named))) return named;
    if (!schema.pattern) return "Morrow sweep";
  }
  return null;
}



/**
 * Ids this sweep learned from a read that answered. A collection route names the
 * kind it returns, so the records it returned are real ids for that kind. This is
 * how an operation that needs a group, a poll or a bank becomes reachable without
 * inventing anything.
 */

/**
 * The context a route acts in. A page in a group is not the course's page, and a
 * content migration under a person is not the course's migration, so an id is
 * only ever offered back to the context it was read from.
 */
const CONTEXTS = { courses: "course", groups: "group", users: "user", accounts: "account", sections: "section", global: "global" };
const CONTEXT_FREE = new Set(["course_id", "account_id", "user_id", "learner_token", "student_id", "course_user_id", "morrow_max_pages"]);

export function operationContext(operation) {
  // New Quizzes is its own Canvas service under /quiz/. Its `assignment_id` is a
  // New Quiz, never the course's classic assignment, so it keeps its own scope.
  const path = String(operation.path || "");
  if (path.startsWith("/quiz/")) return "quiz";
  for (const segment of path.split("/")) {
    if (CONTEXTS[segment]) return CONTEXTS[segment];
  }
  return "global";
}

function poolValue(pool, context, name) {
  // The id read from this route's own context wins, so a group page is not
  // addressed with a course page. What the sweep holds for the course is still
  // offered when the context has none: Canvas answering "no such object" is a
  // recorded result, and never attempting the route is not.
  const scoped = pool[`${context}:${name}`];
  return scoped !== undefined ? scoped : pool[name];
}

export function harvestSeeds(operation, value, pool, mark) {
  const segments = String(operation.path || "").split("/").filter(Boolean);
  const last = segments.at(-1);
  if (!last || last.startsWith("{")) return [];
  const resource = routeResourceName(last);
  if (!resource) return [];
  const learned = [];
  const context = operationContext(operation);
  // Canvas names some things by a word rather than a number: a feature flag is
  // its feature, a report is its report type. The row itself carries that name.
  const names = [`${resource}_id`, resource, ...(RESOURCE_SEEDS[resource] || [])];
  for (const row of rows(value)) {
    if (!row || typeof row !== "object") continue;
    // A sweep that changes things may only ever learn the ids of objects it made
    // itself. Without this it would read a course's own first assignment and
    // then address it, which is the one thing this sweep must never do.
    if (mark && !JSON.stringify(row).includes(mark)) continue;
    const id = idOf(row, "id", "url", `${resource}_id`, resource);
    if (!id) continue;
    for (const name of names) {
      const key = `${context}:${name}`;
      if (pool[key] === undefined) { pool[key] = id; learned.push(`${key}=${id}`); }
      if (context === "course" && pool[name] === undefined) { pool[name] = id; learned.push(`${name}=${id}`); }
    }
    break;
  }
  return learned;
}

/** The resource a bare `{id}` belongs to, taken from the route itself. */
function routeResourceName(segment) {
  if (segment.endsWith("ies")) return `${segment.slice(0, -3)}y`;
  if (segment.endsWith("zzes")) return segment.slice(0, -3);
  if (segment.endsWith("sses")) return segment.slice(0, -2);
  if (segment.endsWith("s")) return segment.slice(0, -1);
  return segment;
}

function routeResource(operation) {
  const match = String(operation.path || "").match(/\/([A-Za-z0-9_]+)\/\{id\}/);
  return match ? routeResourceName(match[1]) : null;
}

const RESOURCE_SEEDS = {
  calendar_event: ["event_id"],
  page: ["url_or_id", "page_id"],
  poll_choice: ["poll_choice_id"],
  item: ["item_id"],
  migration: ["content_migration_id", "migration_id"],
  app: ["external_tool_id"],
  outcome_group: ["outcome_group_id"],
};

function ownIdValue(operation, pool) {
  const resource = routeResource(operation);
  const context = operationContext(operation);
  const names = [];
  if (resource) names.push(`${resource}_id`, ...(RESOURCE_SEEDS[resource] || []));
  names.push(`${operation.family}_id`);
  for (const name of names) {
    const value = poolValue(pool, context, name);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function fillArguments(operation, pool, extra = {}) {
  const args = {};
  const missing = [];
  const synthesized = [];
  const wanted = operation.parameters.filter((parameter) => parameter.location === "path" || parameter.required);
  for (const parameter of wanted) {
    const name = parameter.inputName;
    if (Object.hasOwn(extra, name)) { args[name] = extra[name]; continue; }
    const scoped = poolValue(pool, operationContext(operation), name);
    if (scoped !== undefined) { args[name] = scoped; continue; }
    // A bare `{id}` is the id of the resource named just before it in the route,
    // never a course id borrowed from the pool.
    if (name === "id" && parameter.location === "path") {
      const own = ownIdValue(operation, pool);
      if (own !== undefined) { args[name] = own; continue; }
      missing.push(routeResource(operation) ? `${routeResource(operation)}_id` : name);
      continue;
    }
    // A required input that names no object can come from its own schema.
    if (parameter.location !== "path" && !/(?:^|_)ids?$/.test(name)) {
      const value = schemaValue(parameter);
      if (value !== null) { args[name] = value; synthesized.push(name); continue; }
    }
    missing.push(name);
  }
  if (missing.length) return { missing };
  // A named value the caller supplied for an input this operation accepts, even
  // when Canvas does not mark it required. Canvas refuses a change that names no
  // field to change, and a scheme entry without its name is not a scheme entry.
  for (const parameter of operation.parameters) {
    const name = parameter.inputName;
    if (!Object.hasOwn(extra, name)) continue;
    // An explicit `undefined` says this input must not be sent at all: Canvas
    // documents some of them as a shape its own specification does not state.
    if (extra[name] === undefined) { delete args[name]; continue; }
    if (args[name] === undefined) args[name] = extra[name];
  }
  return { args, ...(synthesized.length ? { synthesized } : {}) };
}
