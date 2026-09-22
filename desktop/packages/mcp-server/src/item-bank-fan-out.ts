import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { normalizeBridgeBindings, type BridgeBinding } from "@morrow/bridge-protocol";
import { isJsonObject, sha256Json, type JsonObject } from "@morrow/contracts";
import * as z from "zod/v4";
import { canvasReadResult } from "./canvas-read.js";
import { resolveResultArtifact, type ResultArtifactPage } from "./result-artifacts.js";
import type { GatewayRuntime } from "./runtime.js";

const canvasId = z.string().regex(/^[1-9][0-9]{0,18}$/);
const inputSchema = z.object({
  source_binding_id: z.string().min(1).max(160),
  course_id: canvasId,
  bank_id: canvasId,
  quiz_use_course_ids: z.array(canvasId).max(200).default([]).describe(
    "Other connected courses whose New Quizzes Morrow must read for this bank. Each course needs one verified connection on the selected Canvas site and account. Naming a course is not evidence that it was read.",
  ),
});

type FanOutInput = z.infer<typeof inputSchema>;
type FanOutRuntime = Pick<GatewayRuntime, "searchCatalog" | "capabilityGet" | "callSourceOwned" | "resultPage">;

/** Mirrors ITEM_BANK_FAN_OUT_SCHEMA in connector/extension/src/item-bank-fan-out.js. */
const FAN_OUT_SCHEMA = "morrow.canvas.item-bank.fan-out.v1";
const FAN_OUT_RECEIPT_SECRET = randomBytes(32);
/** Mirrors ITEM_BANK_FAN_OUT_SOURCES. The order is the order the record lists them in. */
const FAN_OUT_SOURCES = ["bank_entries", "shared_banks", "quiz_uses"] as const;
type SourceName = (typeof FAN_OUT_SOURCES)[number];

function fanOutReceipt(record: JsonObject, sourceBindingId: string): string {
  return createHmac("sha256", FAN_OUT_RECEIPT_SECRET)
    .update(sourceBindingId).update("\0").update(sha256Json(record)).digest("hex");
}

/** A process-local proof that this exact record came from the fresh-read tool. */
export function validItemBankFanOutReceipt(
  record: unknown,
  receipt: unknown,
  sourceBindingId: unknown,
): boolean {
  if (!isJsonObject(record) || typeof receipt !== "string" || !/^[0-9a-f]{64}$/.test(receipt)
    || typeof sourceBindingId !== "string" || !sourceBindingId) return false;
  const expected = fanOutReceipt(record, sourceBindingId);
  return timingSafeEqual(Buffer.from(receipt, "hex"), Buffer.from(expected, "hex"));
}

/** Bank-entry pages one call may walk. Exceeding the budget is an unread source, not a truncation. */
const ENTRY_PAGE_BUDGET = 25;
/** New Quiz list pages one call may walk. */
const QUIZ_PAGE_BUDGET = 25;
/** Quizzes whose items one call reads across all selected courses. */
const MAX_QUIZ_ITEM_READS = 200;
/** Distinct reasons one unread source reports before it says only that there are more. */
const MAX_UNREAD_REASONS = 8;
const MORE_UNREAD_REASONS = "More of this source could not be read than is listed here.";
const QUIZ_USES_UNPROVABLE = "Canvas provides no authoritative route that enumerates every editable course and every New Quiz that uses this item bank. An item bank owned by the current user can be used in an unselected course without a share row.";

/** The New Quiz entry types Canvas documents. `course-inventory.ts` keeps the same list. */
const BANK_DRAW_ENTRY_TYPES = new Set(["BankEntry", "Bank", "BankItem"]);
const OWN_CONTENT_ENTRY_TYPES = new Set(["Item", "Stimulus"]);
const BANK_ID_KEYS = ["bank_id", "item_bank_id", "bankId", "itemBankId"];
const BANK_OBJECT_KEYS = ["bank", "item_bank"];

const limits = Object.freeze([
  "No Canvas route lists every editable course or every New Quiz that draws from an item bank. Morrow can inspect the selected and requested connected courses, but those observations can never prove use outside that set.",
  "An item bank owned by the current user can be used in an unselected course without a share row. An empty share list is therefore not proof that the selected course is the bank's only use.",
  "Each requested course is read through its own verified connection on the same Canvas site and account. Every course named by a bank share must be included. A missing connection, incomplete read, or changed context leaves quiz use unread.",
  "A share row names one course. A bank shared with an account can reach courses that no share row names, so Morrow records that source as unread instead of counting the rows it can see.",
  "Canvas Item Bank share pagination is not established. Morrow records rows from one unpaged response as observations, never as a complete share list.",
  "A bank entry names an item, not a course, so bank entries add no course to this record. They are walked to show that the bank itself was read to its end.",
  "This record is an incomplete observation for the moment it was read. It does not claim complete Canvas authority. A write plan can use only the exact observed record, its process-local receipt, and acknowledgement of every course it names.",
  "Item Bank reads run inside the signed-in New Quizzes Item Banks browser frame. Morrow has no retained live Canvas receipt for this frame contract, so the Morrow route stays live-unverified until attended proof is recorded.",
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
    .filter((name) => name === "quiz_uses" || !input.sources.some((row) => row.name === name && row.exhausted))
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

/** An absent bank is ""; conflicting or invalid claims are null. */
function bankReference(item: JsonObject): string | null {
  const holders = [item, item.entry, item.properties].filter(isJsonObject);
  const ids = new Set<string>();
  for (const holder of holders) {
    for (const key of BANK_ID_KEYS) {
      if (holder[key] === undefined) continue;
      const id = exactId(holder[key]);
      if (!id) return null;
      ids.add(id);
    }
    for (const key of BANK_OBJECT_KEYS) {
      const nested = holder[key];
      if (isJsonObject(nested)) {
        const id = exactId(nested.id);
        if (!id) return null;
        ids.add(id);
      }
    }
  }
  return ids.size > 1 ? null : [...ids][0] ?? "";
}

function verifiedBinding(binding: BridgeBinding): boolean {
  return binding.provider === "canvas" && binding.runtimeVerified === true
    && !!binding.courseId && !!binding.origin && !!binding.principalFingerprint
    && Number.isSafeInteger(binding.sessionGeneration) && Number(binding.sessionGeneration) >= 1
    && !!binding.catalogDigest;
}

function bindingContext(binding: BridgeBinding): JsonObject {
  return {
    sourceBindingId: binding.sourceBindingId, provider: binding.provider,
    courseId: binding.courseId!, origin: binding.origin!, principalFingerprint: binding.principalFingerprint!,
    sessionGeneration: binding.sessionGeneration!, catalogDigest: binding.catalogDigest!,
    runtimeVerified: binding.runtimeVerified,
  };
}

function belongsToCourse(row: JsonObject, courseId: string, quizId?: string): boolean {
  return (row.course_id === undefined || exactId(row.course_id) === courseId)
    && (quizId === undefined || ((row.quiz_id === undefined || exactId(row.quiz_id) === quizId)
      && (row.assignment_id === undefined || exactId(row.assignment_id) === quizId)));
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

  const call = async (toolName: string, args: JsonObject, sourceBindingId = input.source_binding_id): Promise<JsonObject> => {
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
      ...args, _morrow: { source_binding_id: sourceBindingId },
    }, { signal }));
  };
  const readRecord = async (toolName: string, args: JsonObject, sourceBindingId = input.source_binding_id): Promise<JsonObject> => {
    const result = await call(toolName, args, sourceBindingId);
    if (!isJsonObject(result.data)) throw new Error(`Canvas did not return one ${toolName} record.`);
    return result.data;
  };
  // A list read that reached its page budget comes back as an incomplete result,
  // so every collection here is either walked to its end or explicitly unread.
  const readList = async (toolName: string, args: JsonObject, sourceBindingId = input.source_binding_id): Promise<{ rows: JsonObject[]; pages: number }> => {
    const result = await call(toolName, args, sourceBindingId);
    if (!Array.isArray(result.data)) throw new Error(`Canvas did not return a ${toolName} list.`);
    const rows = result.data.filter(isJsonObject);
    if (rows.length !== result.data.length) throw new Error(`Canvas returned a ${toolName} row that was not a structured record.`);
    const pages = typeof result.pageCount === "number" && Number.isSafeInteger(result.pageCount) && result.pageCount > 0 ? result.pageCount : 1;
    return { rows, pages };
  };
  const readObservedShares = async (): Promise<JsonObject[]> => {
    signal.throwIfAborted();
    const toolName = "canvas_item_bank_list_shares";
    const matches = runtime.searchCatalog({ query: toolName, limit: 100 }).tools.filter((tool) => {
      const descriptor = runtime.capabilityGet(tool.publicName).descriptor;
      return tool.upstreamName === toolName && tool.annotations?.readOnlyHint === true
        && (!source || tool.upstreamId === source) && isJsonObject(descriptor)
        && isJsonObject(descriptor.route) && descriptor.route.backend === "canvas-connector";
    });
    if (matches.length !== 1) throw new Error(`The Canvas connection does not provide one ${toolName} read.`);
    source = matches[0]!.upstreamId;
    const response = resolveResultArtifact(await runtime.callSourceOwned(matches[0]!.publicName, {
      course_id: input.course_id, bank_id: input.bank_id,
      _morrow: { source_binding_id: input.source_binding_id },
    }, { signal }), (handle, offset) => runtime.resultPage(handle, offset) as unknown as ResultArtifactPage);
    const content = response.structuredContent;
    const browser = isJsonObject(content) ? content.result : null;
    if (response.isError === true || !isJsonObject(content)
      || content.schema !== "morrow.canvas-connector.result.v1" || content.ok !== true
      || content.commandKind !== "invoke_read" || !isJsonObject(browser)
      || browser.ok !== true || browser.sent !== true || browser.truncated !== true
      || browser.paginationComplete !== false || browser.paginationUnestablished !== true
      || !Array.isArray(browser.data)) {
      throw new Error("Canvas did not return the established one-page Item Bank share observation.");
    }
    const rows = browser.data.filter(isJsonObject);
    if (rows.length !== browser.data.length) throw new Error("Canvas returned a share row that was not a structured record.");
    return rows;
  };
  const failure = (error: unknown): string => error instanceof Error && error.message ? error.message : "Canvas did not return a complete list.";
  const readBindings = async (): Promise<readonly BridgeBinding[]> => {
    signal.throwIfAborted();
    const matches = runtime.searchCatalog({ query: "morrow_browser_bindings", limit: 100 }).tools.filter((tool) => (
      tool.upstreamName === "morrow_browser_bindings" && tool.upstreamId === source && tool.annotations?.readOnlyHint === true
    ));
    if (matches.length !== 1) throw new Error("The Canvas course connections are unavailable or ambiguous.");
    const response = resolveResultArtifact(await runtime.callSourceOwned(matches[0]!.publicName, {}, { signal }),
      (handle, offset) => runtime.resultPage(handle, offset) as unknown as ResultArtifactPage);
    const content = response.structuredContent;
    if (response.isError === true || !isJsonObject(content) || content.schema !== "morrow.browser-bindings.v1"
      || content.ok !== true || !Array.isArray(content.bindings) || content.count !== content.bindings.length) {
      throw new Error("Canvas did not return its complete course connection list.");
    }
    return normalizeBridgeBindings(content.bindings);
  };

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
  let bindings: readonly BridgeBinding[];
  let selectedBinding: BridgeBinding;
  let bank: JsonObject;
  try {
    bindings = await readBindings();
    const selected = bindings.filter((binding) => binding.sourceBindingId === input.source_binding_id
      && binding.courseId === input.course_id && verifiedBinding(binding));
    if (selected.length !== 1) throw new Error("The selected course connection is unavailable or changed.");
    selectedBinding = selected[0]!;
    const courseBanks = await readList("canvas_item_bank_list_banks", { course_id: input.course_id, morrow_max_pages: ENTRY_PAGE_BUDGET });
    if (!courseBanks.rows.some((row) => exactId(row.id) === input.bank_id)) {
      throw new Error("The item bank is not in the selected course's current Item Banks list.");
    }
    bank = await readRecord("canvas_item_bank_get_bank", { course_id: input.course_id, bank_id: input.bank_id });
    if (exactId(bank.id) !== input.bank_id) throw new Error("The Item Bank read returned a different or missing bank identifier.");
  } catch (error) {
    return notEstablished(failure(error));
  }

  // 1. Bank entries. An entry names an item, not a course, so it adds no
  // consumer. Walking it to an empty page is what shows the bank was read.
  const entries: SourceState = { name: "bank_entries", pages: 0, exhausted: false };
  let entryCount = 0;
  let entryDigest: string | undefined;
  try {
    const listed = await readList("canvas_item_bank_list_entries", { course_id: input.course_id, bank_id: input.bank_id, morrow_max_pages: ENTRY_PAGE_BUDGET });
    entries.pages = listed.pages;
    if (listed.rows.some((row) => row.bank_id !== undefined && exactId(row.bank_id) !== input.bank_id)) {
      throw new Error("Canvas returned an entry from a different or unknown bank.");
    }
    entries.exhausted = true;
    entryCount = listed.rows.length;
    entryDigest = sha256Json(listed.rows);
  } catch (error) {
    unreadSource("bank_entries", `${failure(error)} Morrow walks at most ${ENTRY_PAGE_BUDGET} pages of bank entries in one read.`);
  }

  // 2. Shares. Each row whose entity is a course is one consumer. A row that
  // names any other kind of entity reaches courses this route cannot list.
  const shares: SourceState = { name: "shared_banks", pages: 0, exhausted: false };
  let shareRowCount = 0;
  let shareDigest: string | undefined;
  try {
    const listed = { rows: await readObservedShares() };
    shares.pages = 1;
    shareRowCount = listed.rows.length;
    for (const row of listed.rows) {
      if (row.bank_id !== undefined && exactId(row.bank_id) !== input.bank_id) {
        unreadSource("shared_banks", "Canvas returned a share from a different or unknown bank.");
        continue;
      }
      const entityType = typeof row.entity_type === "string" ? row.entity_type
        : typeof row.entityType === "string" ? row.entityType : "";
      const rawEntityId = row.entity_id ?? row.entityId;
      const entityId = exactId(rawEntityId);
      if (entityType.toLowerCase() !== "course") {
        unreadSource("shared_banks", entityType
          ? `One share names an entity of type ${entityType}, not a course. No Item Bank route lists the courses inside it.`
          : "One share row named no entity type, so Morrow cannot say which course it reaches.");
        continue;
      }
      if (!entityId) {
        unreadSource("shared_banks", typeof rawEntityId === "string" && rawEntityId.trim()
          ? "One course share row carried a private context identifier. Morrow has no proved mapping from that value to a numeric Canvas course id."
          : "One course share row carried no exact course id.");
        continue;
      }
      addConsumer({ course_id: entityId, entity_type: "shared_bank", entity_id: entityId });
    }
    // No attended provider proof establishes paging or an end signal for this
    // route. These rows remain useful observations, but even an empty response
    // cannot establish complete share reach.
    unreadSource("shared_banks", "Canvas Item Bank share pagination is not established. Morrow read one unpaged response, which may omit more shares.");
    shares.exhausted = false;
    shareDigest = sha256Json(listed.rows);
  } catch (error) {
    unreadSource("shared_banks", failure(error));
  }

  // A course id selects work; only complete reads under its own binding prove it.
  const quizUses: SourceState = { name: "quiz_uses", pages: 0, exhausted: false };
  const requestedCourseIds = [...new Set(input.quiz_use_course_ids)].sort(compareCourseIds);
  const coursesToRead = [...new Set([input.course_id, ...requestedCourseIds])].sort(compareCourseIds);
  const readCourseIds = new Set<string>();
  const usedBindings = new Map<string, BridgeBinding>([[input.course_id, selectedBinding]]);
  let quizzesRead = 0;
  let quizReadAttempts = 0;
  for (const currentCourseId of coursesToRead) {
    const candidates = currentCourseId === input.course_id ? [selectedBinding] : bindings.filter((binding) => (
      binding.courseId === currentCourseId && verifiedBinding(binding)
      && binding.origin === selectedBinding.origin && binding.principalFingerprint === selectedBinding.principalFingerprint
      && binding.catalogDigest === selectedBinding.catalogDigest
    ));
    if (candidates.length !== 1) {
      unreadSource("quiz_uses", `The connection for ${courseLabel(currentCourseId)} is missing, ambiguous, or belongs to a different Canvas site or account.`);
      continue;
    }
    const binding = candidates[0]!;
    usedBindings.set(currentCourseId, binding);
    let enumerated = true;
    try {
      const currentCourse = await readRecord("canvas_get_single_course_courses", { id: currentCourseId }, binding.sourceBindingId);
      if (exactId(currentCourse.id) !== currentCourseId || typeof currentCourse.name !== "string" || !currentCourse.name.trim()
        || (currentCourseId === input.course_id && sha256Json(currentCourse) !== sha256Json(course))) {
        throw new Error("The course changed or its current identity could not be confirmed.");
      }
      const listed = await readList("canvas_list_new_quizzes", { course_id: currentCourseId, morrow_max_pages: QUIZ_PAGE_BUDGET }, binding.sourceBindingId);
      quizUses.pages += listed.pages;
      const quizIds = new Set<string>();
      for (const quiz of listed.rows) {
        const quizId = exactId(quiz.id);
        if (!quizId || quizIds.has(quizId) || !belongsToCourse(quiz, currentCourseId, quizId)) {
          enumerated = false;
          unreadSource("quiz_uses", `Canvas listed a New Quiz in ${courseLabel(currentCourseId)} with missing, repeated, or mismatched context.`);
          continue;
        }
        quizIds.add(quizId);
        if (quizReadAttempts >= MAX_QUIZ_ITEM_READS) {
          enumerated = false;
          unreadSource("quiz_uses", `Morrow reads the items of at most ${MAX_QUIZ_ITEM_READS} New Quizzes across all requested courses in one call. ${courseLabel(currentCourseId)} still has unread quizzes.`);
          break;
        }
        quizReadAttempts += 1;
        try {
          const quizArgs = { course_id: currentCourseId, assignment_id: quizId };
          const currentQuiz = await readRecord("canvas_get_new_quiz", quizArgs, binding.sourceBindingId);
          if (exactId(currentQuiz.id) !== quizId || !belongsToCourse(currentQuiz, currentCourseId, quizId)) {
            throw new Error("The fresh quiz read returned different or missing context.");
          }
          const quizItems = await readList("canvas_list_quiz_items", { ...quizArgs, morrow_max_pages: QUIZ_PAGE_BUDGET }, binding.sourceBindingId);
          quizUses.pages += quizItems.pages;
          quizzesRead += 1;
          const itemIds = new Set<string>();
          for (const item of quizItems.rows) {
            const itemId = exactId(item.id);
            const entryType = typeof item.entry_type === "string" ? item.entry_type : "";
            const namedBank = bankReference(item);
            if (!itemId || itemIds.has(itemId) || !belongsToCourse(item, currentCourseId, quizId) || namedBank === null) {
              enumerated = false;
              unreadSource("quiz_uses", `Quiz ${quizId} in ${courseLabel(currentCourseId)} carries an item with missing, repeated, or conflicting context.`);
              continue;
            }
            itemIds.add(itemId);
            if (namedBank === input.bank_id) {
              addConsumer({ course_id: currentCourseId, entity_type: "quiz_use", entity_id: quizId });
            } else if (namedBank === "" && !OWN_CONTENT_ENTRY_TYPES.has(entryType)) {
              enumerated = false;
              unreadSource("quiz_uses", BANK_DRAW_ENTRY_TYPES.has(entryType)
                ? `Quiz ${quizId} in ${courseLabel(currentCourseId)} draws from an item bank that its item does not name, so Morrow cannot say whether it is this bank.`
                : `Quiz ${quizId} in ${courseLabel(currentCourseId)} carries an item whose entry type Canvas does not document, so Morrow cannot say whether it draws from this bank.`);
            }
          }
          const checkedQuiz = await readRecord("canvas_get_new_quiz", quizArgs, binding.sourceBindingId);
          if (sha256Json(checkedQuiz) !== sha256Json(currentQuiz)) throw new Error("The quiz changed while its items were read.");
        } catch (error) {
          enumerated = false;
          unreadSource("quiz_uses", `Quiz ${quizId} in ${courseLabel(currentCourseId)} could not be confirmed. ${failure(error)}`);
        }
      }
      const checkedList = await readList("canvas_list_new_quizzes", { course_id: currentCourseId, morrow_max_pages: QUIZ_PAGE_BUDGET }, binding.sourceBindingId);
      quizUses.pages += checkedList.pages;
      if (sha256Json(checkedList.rows) !== sha256Json(listed.rows)) throw new Error("The course quiz list changed during enumeration.");
      const checkedCourse = await readRecord("canvas_get_single_course_courses", { id: currentCourseId }, binding.sourceBindingId);
      if (sha256Json(checkedCourse) !== sha256Json(currentCourse)) throw new Error("The course changed during enumeration.");
      if (enumerated) readCourseIds.add(currentCourseId);
    } catch (error) {
      unreadSource("quiz_uses", `${courseLabel(currentCourseId)} could not be enumerated. ${failure(error)}`);
    }
  }

  // A long enumeration must not certify sources or bindings that changed while it ran.
  try {
    const checkedCourseBanks = await readList("canvas_item_bank_list_banks", { course_id: input.course_id, morrow_max_pages: ENTRY_PAGE_BUDGET });
    if (!checkedCourseBanks.rows.some((row) => exactId(row.id) === input.bank_id)) throw new Error("The item bank left the selected course during enumeration.");
    const checkedBank = await readRecord("canvas_item_bank_get_bank", { course_id: input.course_id, bank_id: input.bank_id });
    if (sha256Json(checkedBank) !== sha256Json(bank)) throw new Error("The bank changed during enumeration.");
    if (entries.exhausted) {
      const checkedEntries = await readList("canvas_item_bank_list_entries", { course_id: input.course_id, bank_id: input.bank_id, morrow_max_pages: ENTRY_PAGE_BUDGET });
      entries.pages += checkedEntries.pages;
      if (sha256Json(checkedEntries.rows) !== entryDigest) throw new Error("The bank entries changed during enumeration.");
    }
    if (shareDigest !== undefined) {
      const checkedShares = await readObservedShares();
      shares.pages += 1;
      if (sha256Json(checkedShares) !== shareDigest) throw new Error("The observed bank shares changed during enumeration.");
    }
    const currentBindings = await readBindings();
    for (const [currentCourseId, binding] of usedBindings) {
      const current = currentBindings.find((entry) => entry.sourceBindingId === binding.sourceBindingId);
      if (!current || !verifiedBinding(current) || sha256Json(bindingContext(current)) !== sha256Json(bindingContext(binding))) {
        readCourseIds.delete(currentCourseId);
        unreadSource("quiz_uses", `The connection for ${courseLabel(currentCourseId)} changed during enumeration.`);
        if (currentCourseId === input.course_id) throw new Error("The selected bank connection changed during enumeration.");
      }
    }
  } catch (error) {
    entries.exhausted = false;
    shares.exhausted = false;
    readCourseIds.clear();
    unreadSource("bank_entries", failure(error));
    unreadSource("shared_banks", failure(error));
    unreadSource("quiz_uses", "Morrow could not confirm that the bank and course connections stayed current during enumeration.");
  }
  const externalShareCourseIds = [...new Set([...consumers.values()]
    .filter((consumer) => consumer.entity_type === "shared_bank" && consumer.course_id !== input.course_id)
    .map((consumer) => consumer.course_id))].sort(compareCourseIds);
  const unreadCourseIds = externalShareCourseIds.filter((id) => !readCourseIds.has(id));
  if (!shares.exhausted) {
    unreadSource("quiz_uses", "Morrow could not read every course this bank reaches, so it cannot say which courses still need their quizzes enumerated.");
  }
  if (shares.exhausted && unreadCourseIds.length > 0) {
    unreadSource("quiz_uses", `This bank reaches ${courseList(unreadCourseIds)}, whose quiz use remains unread. Include these courses in quiz_use_course_ids and keep their verified course connections available.`);
  }
  // These reads describe only the courses named by the caller or by share rows.
  // Canvas exposes no authoritative enumeration of every editable course, and
  // an owner bank can be used in another course without a share row. Therefore
  // quiz use remains incomplete and cannot establish complete Canvas authority.
  unreadSource("quiz_uses", QUIZ_USES_UNPROVABLE);
  quizUses.exhausted = false;

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
    fan_out_receipt: fanOutReceipt(record, input.source_binding_id),
    external_course_ids: externalCourseIds,
    observed: {
      bank_entry_count: entryCount,
      share_row_count: shareRowCount,
      quizzes_read: quizzesRead,
      quiz_uses_found: quizUseCount,
      quiz_use_courses_read_by_morrow: [...readCourseIds].sort(compareCourseIds),
      quiz_use_courses_requested: requestedCourseIds,
    },
    unread: unreadDetail,
    limits,
  };
  const lines = [
    summary,
    `Course: ${courseName} (${courseLabel(input.course_id)}). Item bank ${input.bank_id}.`,
    `Morrow read ${entryCount} bank ${entryCount === 1 ? "entry" : "entries"}, ${shareRowCount} share ${shareRowCount === 1 ? "row" : "rows"}, and the items of ${quizzesRead} New ${quizzesRead === 1 ? "Quiz" : "Quizzes"} across the requested courses, where it found ${quizUseCount} ${quizUseCount === 1 ? "quiz" : "quizzes"} drawing from this bank.`,
    readCourseIds.size
      ? `Morrow completed quiz reads for ${courseList([...readCourseIds].sort(compareCourseIds))}.`
      : "Morrow could not complete quiz reads for any requested course.",
    ...(unreadDetail.length
      ? [`Morrow could not read: ${unreadDetail.map((entry) => `${entry.source}: ${entry.reasons.join(" ")}`).join(" ")}`]
      : []),
    "This record is not complete Canvas authority. A write can use only this exact observed record, its process-local receipt, and acknowledgement of every course it names. An unread source is not an empty result.",
    ...limits,
  ];
  return { content: [{ type: "text", text: lines.join("\n\n") }], structuredContent: report };
}

export function registerItemBankFanOutTool(server: McpServer, runtime: GatewayRuntime): void {
  server.registerTool("morrow_read_item_bank_fan_out", {
    title: "Read the courses one item bank reaches",
    description: "Read observed uses of one New Quizzes item bank in the selected course and requested connected courses. Does not change Canvas. Canvas provides no authoritative route that enumerates every editable course and every consuming New Quiz. An owner bank can be used in an unselected course without a share row. The result therefore always reports quiz_uses as unread. A write plan must bind the exact observed record, its process-local receipt, and acknowledgement of every course the record names.",
    inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input, context) => await readItemBankFanOut(runtime, input, context.mcpReq.signal));
}
