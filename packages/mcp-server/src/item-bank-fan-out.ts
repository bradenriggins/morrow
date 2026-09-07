import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { isJsonObject, sha256Json, type JsonObject } from "@morrow/contracts";
import * as z from "zod/v4";
import { canvasReadResult } from "./canvas-read.js";
import type { GatewayRuntime } from "./runtime.js";

const canvasId = z.string().regex(/^[1-9][0-9]{0,18}$/);
const inputSchema = z.object({
  source_binding_id: z.string().min(1).max(160),
  course_id: canvasId,
  bank_id: canvasId,
  quiz_use_course_ids: z.array(canvasId).max(200).default([]).describe(
    "Other courses whose New Quizzes have already been enumerated for this bank. Morrow reads one course through one connection, so these are recorded as a caller declaration, never as a Morrow read.",
  ),
});

type FanOutInput = z.infer<typeof inputSchema>;
type FanOutRuntime = Pick<GatewayRuntime, "searchCatalog" | "capabilityGet" | "callSourceOwned" | "resultPage">;

/** Mirrors ITEM_BANK_FAN_OUT_SCHEMA in connector/extension/src/item-bank-fan-out.js. */
const FAN_OUT_SCHEMA = "morrow.canvas.item-bank.fan-out.v1";
/** Mirrors ITEM_BANK_FAN_OUT_SOURCES. The order is the order the record lists them in. */
const FAN_OUT_SOURCES = ["bank_entries", "shared_banks", "quiz_uses"] as const;
type SourceName = (typeof FAN_OUT_SOURCES)[number];

/** Bank-entry pages one call may walk. Exceeding the budget is an unread source, not a truncation. */
const ENTRY_PAGE_BUDGET = 25;
/** New Quiz list pages one call may walk. */
const QUIZ_PAGE_BUDGET = 25;
/** Share rows one response may carry. A response this long may be one page of more. */
const SHARE_PER_PAGE = 100;
/** Quizzes whose items one call reads. A course with more leaves quiz_uses unread. */
const MAX_QUIZ_ITEM_READS = 200;
/** Distinct reasons one unread source reports before it says only that there are more. */
const MAX_UNREAD_REASONS = 8;
const MORE_UNREAD_REASONS = "More of this source could not be read than is listed here.";

/** The New Quiz entry types Canvas documents. `course-inventory.ts` keeps the same list. */
const BANK_DRAW_ENTRY_TYPES = new Set(["BankEntry", "Bank", "BankItem"]);
const OWN_CONTENT_ENTRY_TYPES = new Set(["Item", "Stimulus"]);
const BANK_ID_KEYS = ["bank_id", "item_bank_id", "bankId", "itemBankId"];
const BANK_OBJECT_KEYS = ["bank", "item_bank"];

const limits = Object.freeze([
  "No Canvas route lists the quizzes that draw from an item bank. Morrow enumerates the New Quizzes in the selected course only, so quiz use in any other course is only ever as complete as the courses you enumerated yourself. This limit is permanent.",
  "Morrow reads one course through one connection, so it cannot read another course's quizzes here. Course ids supplied in quiz_use_course_ids are recorded as your declaration, not as a Morrow read.",
  "A share row names one course. A bank shared with an account can reach courses that no share row names, so Morrow records that source as unread instead of counting the rows it can see.",
  "A bank entry names an item, not a course, so bank entries add no course to this record. They are walked to show that the bank itself was read to its end.",
  "This record is exact for the moment it was read. The guarded Item Bank repair refuses a record more than one hour old, and refuses any record that is not complete.",
  "Item Bank reads run inside the signed-in New Quizzes Item Banks browser frame. That frame contract is not yet verified against a live Canvas tenant, so every Item Bank result here stays live-unverified.",
]);

function exactId(value: unknown): string {
  if (typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return "";
}

function courseLabel(id: string): string {
  return `course ${id}`;
}

function courseList(ids: readonly string[]): string {
  return ids.map(courseLabel).join(", ");
}

type Consumer = { readonly course_id: string; readonly entity_type: string; readonly entity_id: string };
type SourceState = { name: SourceName; pages: number; exhausted: boolean };

const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
// Course ids are decimal with no leading zero, so length before text is their
// numeric order. It keeps course 10 after course 9 in every list a person reads.
const compareCourseIds = (a: string, b: string): number => a.length === b.length ? compareText(a, b) : a.length - b.length;
const compareConsumers = (a: Consumer, b: Consumer): number =>
  compareCourseIds(a.course_id, b.course_id) || compareText(a.entity_type, b.entity_type) || compareText(a.entity_id, b.entity_id);

/**
 * Builds the same record as `establishFanOut` in
 * `connector/extension/src/item-bank-fan-out.js`, which is the module the
 * in-frame guard validates the record with. The extension module cannot be
 * imported here: it is plain JavaScript with no declaration file, and a
 * declaration file cannot live beside it because the Morrow Bridge release ships
 * an exact file set (`BRIDGE_SOURCE_FILES` in `scripts/package-mcp-bundle.mjs`).
 * `test/item-bank-fan-out.test.ts` runs both implementations over the same input
 * and requires identical records and identical digests, so the two cannot drift
 * apart unnoticed.
 */
function fanOutRecord(input: {
  readonly bankId: string;
  readonly courseId: string;
  readonly sources: readonly SourceState[];
  readonly consumers: readonly Consumer[];
  readonly observedAt: Date;
}): JsonObject {
  const consumers = [...input.consumers].sort(compareConsumers);
  const unreachable = FAN_OUT_SOURCES
    .filter((name) => !input.sources.some((row) => row.name === name && row.exhausted))
    .sort(compareText);
  const externalCourseIds = [...new Set(consumers.map((consumer) => consumer.course_id))]
    .filter((id) => id !== input.courseId)
    .sort(compareCourseIds);
  return {
    schema: FAN_OUT_SCHEMA,
    bank_id: input.bankId,
    course_id: input.courseId,
    established_at: input.observedAt.toISOString(),
    sources: FAN_OUT_SOURCES.flatMap((name) => {
      const row = input.sources.find((candidate) => candidate.name === name);
      return row ? [{ name: row.name, pages: row.pages, exhausted: row.exhausted }] : [];
    }),
    unreachable,
    complete: unreachable.length === 0,
    consumers: consumers.map((consumer) => ({ ...consumer })),
    consumer_count: consumers.length,
    external_course_ids: externalCourseIds,
    consumers_sha256: sha256Json(consumers),
  };
}

/** A bank id named by one New Quiz item, or "" when the item names none. */
function bankReference(item: JsonObject): string {
  const holders = [item, item.entry, item.properties].filter(isJsonObject);
  for (const holder of holders) {
    for (const key of BANK_ID_KEYS) {
      const id = exactId(holder[key]);
      if (id) return id;
    }
    for (const key of BANK_OBJECT_KEYS) {
      const nested = holder[key];
      if (isJsonObject(nested)) {
        const id = exactId(nested.id);
        if (id) return id;
      }
    }
  }
  return "";
}

function notEstablished(reason: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `Morrow did not build an item bank fan-out record. ${reason}` }],
    structuredContent: { schema: "morrow.problem.v1", code: "item_bank_fan_out_not_established" },
  };
}

export async function readItemBankFanOut(
  runtime: FanOutRuntime,
  value: FanOutInput,
  callerSignal?: AbortSignal,
): Promise<CallToolResult> {
  const input = inputSchema.parse(value);
  const timeout = AbortSignal.timeout(120_000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  const observedAt = new Date();
  const unread = new Map<SourceName, string[]>();
  const consumers = new Map<string, Consumer>();
  let source: string | undefined;

  const unreadSource = (name: SourceName, reason: string): void => {
    const reasons = unread.get(name) ?? [];
    unread.set(name, reasons);
    if (reasons.includes(reason)) return;
    // One unreadable course can produce one reason per quiz. Keep the first few
    // exactly and then say only that there are more, so a long list of repeats
    // never crowds out the answer.
    if (reasons.length < MAX_UNREAD_REASONS) reasons.push(reason);
    else if (reasons[reasons.length - 1] !== MORE_UNREAD_REASONS) reasons.push(MORE_UNREAD_REASONS);
  };
  const addConsumer = (consumer: Consumer): void => {
    // The record refuses a repeated triple, so two quiz items in one quiz, or
    // two share rows for one course, stay one consumer.
    consumers.set(`${consumer.course_id} ${consumer.entity_type} ${consumer.entity_id}`, consumer);
  };

  const call = async (toolName: string, args: JsonObject): Promise<JsonObject> => {
    signal.throwIfAborted();
    const matches = runtime.searchCatalog({ query: toolName, limit: 100 }).tools.filter((tool) => {
      const descriptor = runtime.capabilityGet(tool.publicName).descriptor;
      return tool.upstreamName === toolName && tool.annotations?.readOnlyHint === true
        && (!source || tool.upstreamId === source) && isJsonObject(descriptor)
        && isJsonObject(descriptor.route) && descriptor.route.backend === "canvas-connector";
    });
    if (matches.length !== 1) throw new Error(`The Canvas connection does not provide one ${toolName} read.`);
    source = matches[0]!.upstreamId;
    return canvasReadResult(runtime, await runtime.callSourceOwned(matches[0]!.publicName, {
      ...args, _morrow: { source_binding_id: input.source_binding_id },
    }, { signal }));
  };
  const readRecord = async (toolName: string, args: JsonObject): Promise<JsonObject> => {
    const result = await call(toolName, args);
    if (!isJsonObject(result.data)) throw new Error(`Canvas did not return one ${toolName} record.`);
    return result.data;
  };
  // A list read that reached its page budget comes back as an incomplete result,
  // so every collection here is either walked to its end or explicitly unread.
  const readList = async (toolName: string, args: JsonObject): Promise<{ rows: JsonObject[]; pages: number }> => {
    const result = await call(toolName, args);
    if (!Array.isArray(result.data)) throw new Error(`Canvas did not return a ${toolName} list.`);
    const rows = result.data.filter(isJsonObject);
    if (rows.length !== result.data.length) throw new Error(`Canvas returned a ${toolName} row that was not a structured record.`);
    const pages = typeof result.pageCount === "number" && Number.isSafeInteger(result.pageCount) && result.pageCount > 0 ? result.pageCount : 1;
    return { rows, pages };
  };
  const failure = (error: unknown): string => error instanceof Error && error.message ? error.message : "Canvas did not return a complete list.";

  let course: JsonObject;
  try {
    course = await readRecord("canvas_get_single_course_courses", { id: input.course_id });
  } catch (error) {
    return notEstablished(`${failure(error)} The record binds to one confirmed course, so none was built.`);
  }
  if (exactId(course.id) !== input.course_id || typeof course.name !== "string" || course.name.trim() === "") {
    return notEstablished("The selected course could not be confirmed from a fresh Canvas read.");
  }
  const courseName = course.name.trim();

  // 1. Bank entries. An entry names an item, not a course, so it adds no
  // consumer. Walking it to an empty page is what shows the bank was read.
  const entries: SourceState = { name: "bank_entries", pages: 0, exhausted: false };
  let entryCount = 0;
  try {
    const listed = await readList("canvas_item_bank_list_entries", { bank_id: input.bank_id, morrow_max_pages: ENTRY_PAGE_BUDGET });
    entries.pages = listed.pages;
    entries.exhausted = true;
    entryCount = listed.rows.length;
  } catch (error) {
    unreadSource("bank_entries", `${failure(error)} Morrow walks at most ${ENTRY_PAGE_BUDGET} pages of bank entries in one read.`);
  }

  // 2. Shares. Each row whose entity is a course is one consumer. A row that
  // names any other kind of entity reaches courses this route cannot list.
  const shares: SourceState = { name: "shared_banks", pages: 0, exhausted: false };
  let shareRowCount = 0;
  try {
    const listed = await readList("canvas_item_bank_list_shares", { bank_id: input.bank_id, per_page: SHARE_PER_PAGE });
    shares.pages = 1;
    shareRowCount = listed.rows.length;
    let readable = true;
    for (const row of listed.rows) {
      const entityType = typeof row.entity_type === "string" ? row.entity_type
        : typeof row.entityType === "string" ? row.entityType : "";
      const entityId = exactId(row.entity_id ?? row.entityId);
      if (entityType.toLowerCase() !== "course") {
        readable = false;
        unreadSource("shared_banks", entityType
          ? `One share names an entity of type ${entityType}, not a course. No Item Bank route lists the courses inside it.`
          : "One share row named no entity type, so Morrow cannot say which course it reaches.");
        continue;
      }
      if (!entityId) {
        readable = false;
        unreadSource("shared_banks", "One course share row carried no exact course id.");
        continue;
      }
      addConsumer({ course_id: entityId, entity_type: "shared_bank", entity_id: entityId });
    }
    // The Item Banks share route has no established paging. A response as long
    // as the request may be one page of more, and asking for a second page
    // could repeat the same rows, so a full response is recorded as unread.
    if (listed.rows.length >= SHARE_PER_PAGE) {
      readable = false;
      unreadSource("shared_banks", `Canvas returned ${listed.rows.length} share rows, which is as many as Morrow asked for, so the list may continue. Paging this route is not established.`);
    }
    shares.exhausted = readable;
  } catch (error) {
    unreadSource("shared_banks", failure(error));
  }

  // 3. Quiz uses. No Item Banks route lists the quizzes that draw from a bank,
  // so this source is a Canvas-side enumeration of the selected course only.
  const quizUses: SourceState = { name: "quiz_uses", pages: 0, exhausted: false };
  const declaredCourseIds = [...new Set(input.quiz_use_course_ids)].sort(compareCourseIds);
  let quizzesRead = 0;
  let selectedCourseEnumerated = false;
  try {
    const listed = await readList("canvas_list_new_quizzes", { course_id: input.course_id, morrow_max_pages: QUIZ_PAGE_BUDGET });
    quizUses.pages = listed.pages;
    selectedCourseEnumerated = true;
    if (listed.rows.length > MAX_QUIZ_ITEM_READS) {
      selectedCourseEnumerated = false;
      unreadSource("quiz_uses", `This course has ${listed.rows.length} New Quizzes and Morrow reads the items of at most ${MAX_QUIZ_ITEM_READS} in one call.`);
    }
    for (const quiz of listed.rows.slice(0, MAX_QUIZ_ITEM_READS)) {
      if (signal.aborted) {
        selectedCourseEnumerated = false;
        unreadSource("quiz_uses", "Morrow reached its time limit before it read the items of every New Quiz in this course.");
        break;
      }
      const quizId = exactId(quiz.id);
      if (!quizId) {
        selectedCourseEnumerated = false;
        unreadSource("quiz_uses", "Canvas listed a New Quiz without an exact identifier, so its items were not read.");
        continue;
      }
      let items: JsonObject[];
      try {
        const quizItems = await readList("canvas_list_quiz_items", { course_id: input.course_id, assignment_id: quizId });
        quizUses.pages += quizItems.pages;
        items = quizItems.rows;
        quizzesRead += 1;
      } catch (error) {
        selectedCourseEnumerated = false;
        unreadSource("quiz_uses", `The items of quiz ${quizId} could not be read. ${failure(error)}`);
        continue;
      }
      for (const item of items) {
        const entryType = typeof item.entry_type === "string" ? item.entry_type : "";
        const namedBank = bankReference(item);
        if (namedBank === input.bank_id) {
          addConsumer({ course_id: input.course_id, entity_type: "quiz_use", entity_id: quizId });
        } else if (namedBank === "" && !OWN_CONTENT_ENTRY_TYPES.has(entryType)) {
          // A bank-drawing item that names no bank, or an entry type Canvas has
          // not documented, could be drawing from this bank. Not knowing is not
          // the same answer as not drawing from it.
          selectedCourseEnumerated = false;
          unreadSource("quiz_uses", BANK_DRAW_ENTRY_TYPES.has(entryType)
            ? `Quiz ${quizId} draws from an item bank that its item does not name, so Morrow cannot say whether it is this bank.`
            : `Quiz ${quizId} carries an item whose entry type Canvas does not document, so Morrow cannot say whether it draws from this bank.`);
        }
      }
    }
  } catch (error) {
    unreadSource("quiz_uses", failure(error));
  }
  const externalShareCourseIds = [...new Set([...consumers.values()]
    .filter((consumer) => consumer.entity_type === "shared_bank" && consumer.course_id !== input.course_id)
    .map((consumer) => consumer.course_id))].sort(compareCourseIds);
  const undeclaredCourseIds = externalShareCourseIds.filter((id) => !declaredCourseIds.includes(id));
  if (selectedCourseEnumerated && !shares.exhausted) {
    unreadSource("quiz_uses", "Morrow could not read every course this bank reaches, so it cannot say which courses still need their quizzes enumerated.");
  }
  if (selectedCourseEnumerated && shares.exhausted && undeclaredCourseIds.length > 0) {
    unreadSource("quiz_uses", `This bank reaches ${courseList(undeclaredCourseIds)}. Morrow cannot read another course through this connection, so quiz use there stays unread until those courses are enumerated and supplied in quiz_use_course_ids.`);
  }
  quizUses.exhausted = selectedCourseEnumerated && shares.exhausted && undeclaredCourseIds.length === 0;

  const record = fanOutRecord({
    bankId: input.bank_id,
    courseId: input.course_id,
    sources: [entries, shares, quizUses],
    consumers: [...consumers.values()],
    observedAt,
  });
  const externalCourseIds = record.external_course_ids as string[];
  const complete = record.complete === true;
  const unreadDetail = FAN_OUT_SOURCES.flatMap((name) => {
    const reasons = unread.get(name);
    return reasons?.length ? [{ source: name, reasons }] : [];
  });
  const quizUseCount = [...consumers.values()].filter((consumer) => consumer.entity_type === "quiz_use").length;

  const summary = complete
    ? externalCourseIds.length
      ? `Morrow read every source for this item bank. It reaches ${externalCourseIds.length === 1 ? "1 other course" : `${externalCourseIds.length} other courses`}: ${courseList(externalCourseIds)}.`
      : "Morrow read every source for this item bank. No course other than the selected one draws from it."
    : externalCourseIds.length
      ? `Morrow could not read every source for this item bank, so this is not a complete list of what it reaches. The courses Morrow did find are ${courseList(externalCourseIds)}.`
      : "Morrow could not read every source for this item bank. It found no other course, which is not the same as showing that none exists.";
  const report: JsonObject = {
    schema: "morrow.item-bank-fan-out.v1",
    status: complete ? "complete" : "incomplete",
    summary,
    read_at: observedAt.toISOString(),
    course: { id: input.course_id, name: courseName },
    bank: { id: input.bank_id },
    fan_out: record,
    external_course_ids: externalCourseIds,
    observed: {
      bank_entry_count: entryCount,
      share_row_count: shareRowCount,
      quizzes_read: quizzesRead,
      quiz_uses_found: quizUseCount,
      quiz_use_courses_read_by_morrow: selectedCourseEnumerated ? [input.course_id] : [],
      quiz_use_courses_declared_by_caller: declaredCourseIds,
    },
    unread: unreadDetail,
    limits,
  };
  const lines = [
    summary,
    `Course: ${courseName} (${courseLabel(input.course_id)}). Item bank ${input.bank_id}.`,
    `Morrow read ${entryCount} bank ${entryCount === 1 ? "entry" : "entries"}, ${shareRowCount} share ${shareRowCount === 1 ? "row" : "rows"}, and the items of ${quizzesRead} New ${quizzesRead === 1 ? "Quiz" : "Quizzes"} in this course, where it found ${quizUseCount} ${quizUseCount === 1 ? "quiz" : "quizzes"} drawing from this bank.`,
    declaredCourseIds.length
      ? `You declared that the New Quizzes in ${courseList(declaredCourseIds)} were already enumerated. Morrow did not read those courses and records the declaration as yours.`
      : "You declared no other enumerated course, so this record covers quiz use in the selected course only.",
    ...(unreadDetail.length
      ? [`Morrow could not read: ${unreadDetail.map((entry) => `${entry.source} — ${entry.reasons.join(" ")}`).join(" ")}`]
      : []),
    complete
      ? "This record is complete, so the guarded Item Bank repair can use it for the next hour. That repair still asks you to confirm every course named above."
      : "This record is not complete, so the guarded Item Bank repair will refuse it. An unread source is not an empty result.",
    ...limits,
  ];
  return { content: [{ type: "text", text: lines.join("\n\n") }], structuredContent: report };
}

export function registerItemBankFanOutTool(server: McpServer, runtime: GatewayRuntime): void {
  server.registerTool("morrow_read_item_bank_fan_out", {
    title: "Read the courses one item bank reaches",
    description: "Read, from Canvas, which courses and New Quizzes draw from one New Quizzes item bank, and record what could not be read. Does not change Canvas. No Canvas route lists the quizzes that draw from a bank, so quiz use is enumerated in the selected course only and any other course must be enumerated separately and named in quiz_use_course_ids. A source Morrow could not read is reported as unread, never as an empty result.",
    inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input, context) => await readItemBankFanOut(runtime, input, context.mcpReq.signal));
}
