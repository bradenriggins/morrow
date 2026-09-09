import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { isJsonObject, sha256Json, sha256Text, type JsonObject } from "@morrow/contracts";
import * as z from "zod/v4";
import { canvasReadResult } from "./canvas-read.js";
import type { GatewayRuntime } from "./runtime.js";

const courseIdSchema = z.string().regex(/^[1-9][0-9]{0,18}$/);
const entityIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);

const inputSchema = z.object({
  source_binding_id: z.string().min(1).max(160),
  course_id: courseIdSchema,
  bank_id: entityIdSchema,
  bank_entry_id: entityIdSchema,
  item_id: entityIdSchema,
  item_sha256: digestSchema.describe("Digest of the exact item bank question this repair was planned against."),
  image_index: z.number().int().min(1).max(2 * 1024 * 1024).describe("Position of the image in the question body, counting every image from 1."),
  image_src_sha256: digestSchema,
  alt_text: z.string().min(1).max(500).describe("Alternative text a person can read. An item bank question image cannot be marked decorative here."),
  fan_out: z.record(z.string(), z.unknown()).describe("The exact fan_out record from morrow_read_item_bank_fan_out."),
  fan_out_receipt: digestSchema.describe("The process-local receipt returned with that exact fan_out record."),
  acknowledged_course_ids: z.array(courseIdSchema).max(200).describe("The exact observed external course ids the reviewer acknowledges."),
}).superRefine((value, context) => {
  if (value.alt_text.trim().length === 0) {
    context.addIssue({ code: "custom", message: "An item bank question image needs alternative text a person can read." });
  }
});

type ItemBankRepairInput = z.infer<typeof inputSchema>;
type ItemBankRepairRuntime = Pick<GatewayRuntime, "catalog" | "searchCatalog" | "capabilityGet" | "callSourceOwned" | "resultPage" | "planOperationWithCurrentEditPermission">;

const WRITE_TOOL = "canvas_item_bank_update_item";

class ItemBankRepairError extends Error {}

const MAX_ITEM_BODY = 200_000;
const INTERACTION_ID_GROUPS = ["choices", "questions", "blanks", "entries"] as const;
const INTERACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const TAG = /<!--[\s\S]*?-->|<(?:"[^"]*"|'[^']*'|[^'">])*>/g;
const TAG_NAME = /^<\s*(\/?)\s*([a-zA-Z][^\s/>]*)/;
const ATTRIBUTE = /^\s+([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/;
const RAW_TEXT = ["script", "style", "iframe", "object", "embed", "textarea", "title"];
const IMAGELESS_SUBTREE = ["svg", "math"];
const asText = (value: unknown): string => typeof value === "string" ? value
  : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const sameList = (value: unknown, expected: readonly string[]): boolean => Array.isArray(value)
  && value.length === expected.length && expected.every((entry, index) => value[index] === entry);

/** Mirrors `itemBankProtectedState`: the question without the one field this repair may change. */
function protectedItemState(item: JsonObject): JsonObject | null {
  if (!isJsonObject(item.entry) || typeof item.entry.item_body !== "string") return null;
  const state = structuredClone(item);
  const entry = state.entry as JsonObject;
  delete entry.item_body;
  delete entry.updated_at;
  delete state.updated_at;
  return state;
}

/** Mirrors `itemBankInteractionIds`. null means a collection this rule cannot read. */
function interactionIds(item: JsonObject): string[] | null {
  if (!isJsonObject(item.entry)) return null;
  const interaction = item.entry.interaction_data;
  if (interaction === undefined || interaction === null) return [];
  if (!isJsonObject(interaction)) return null;
  const ids: string[] = [];
  for (const group of INTERACTION_ID_GROUPS) {
    const rows = interaction[group];
    if (rows === undefined || rows === null) continue;
    if (!Array.isArray(rows)) return null;
    for (const row of rows) {
      if (!isJsonObject(row) || typeof row.id !== "string" || !INTERACTION_ID.test(row.id)) return null;
      ids.push(`${group}:${row.id}`);
    }
  }
  return new Set(ids).size === ids.length ? ids.sort(compareText) : null;
}

/** Mirrors `itemBankEntryLinksItem`: section 3.3 of the contract. A list row is not an item. */
function entryLinksItem(entry: JsonObject, itemId: string): boolean {
  if (entry.entry_type !== "Item") return false;
  if (typeof entry.entry_id === "string" && entry.entry_id === itemId) return true;
  for (const key of ["item", "entry", "current_version", "data"]) {
    const value = entry[key];
    if (!isJsonObject(value)) continue;
    if (typeof value.id === "string" && value.id === itemId) return true;
    for (const nested of ["item", "data"]) {
      const inner = value[nested];
      if (isJsonObject(inner) && typeof inner.id === "string" && inner.id === itemId) return true;
    }
  }
  return false;
}

export function itemBankEntryMatchesTarget(entry: unknown, bankEntryId: string, bankId: string, itemId: string): boolean {
  return isJsonObject(entry)
    && asText(entry.id) === bankEntryId
    && (entry.bank_id === undefined || asText(entry.bank_id) === bankId)
    && entryLinksItem(entry, itemId);
}

type ContentImage = { readonly start: number; readonly end: number; readonly tag: string };

/** Mirrors `itemBankContentImages`. `open` reports markup this scan did not finish reading. */
function contentImages(body: string): { readonly images: readonly ContentImage[]; readonly open: boolean } {
  const images: ContentImage[] = [];
  let rawText = "";
  let imagelessDepth = 0;
  for (const match of body.matchAll(TAG)) {
    const tag = match[0];
    if (tag.startsWith("<!--")) continue;
    const parsed = TAG_NAME.exec(tag);
    if (!parsed) continue;
    const closing = parsed[1] === "/";
    const element = parsed[2]!.toLowerCase();
    if (rawText) {
      if (closing && element === rawText) rawText = "";
      continue;
    }
    if (RAW_TEXT.includes(element)) {
      if (!closing && !tag.endsWith("/>")) rawText = element;
      continue;
    }
    if (IMAGELESS_SUBTREE.includes(element)) {
      if (closing) imagelessDepth = Math.max(0, imagelessDepth - 1);
      else if (!tag.endsWith("/>")) imagelessDepth += 1;
      continue;
    }
    if (element !== "img" || closing || imagelessDepth > 0) continue;
    images.push({ start: match.index, end: match.index + tag.length - 1, tag });
  }
  return { images, open: rawText !== "" || imagelessDepth > 0 };
}

/** Mirrors `itemBankImageAttributes`. Values are not entity-decoded. */
function imageAttributes(tag: string): Map<string, string> | null {
  const open = /^<\s*img/i.exec(tag);
  if (!open || !tag.endsWith(">")) return null;
  const suffix = tag.endsWith("/>") ? 2 : 1;
  let rest = tag.slice(open[0].length, tag.length - suffix);
  const attributes = new Map<string, string>();
  while (rest.trim().length > 0) {
    const match = ATTRIBUTE.exec(rest);
    if (!match) return null;
    const name = match[1]!.toLowerCase();
    if (attributes.has(name)) return null;
    attributes.set(name, match[2] ?? match[3] ?? "");
    rest = rest.slice(match[0].length);
  }
  return attributes;
}

type CurrentItemBankQuestion = {
  readonly writeTool: string;
  readonly courseName: string;
  readonly item: JsonObject;
  readonly body: string;
  readonly title: string;
  readonly itemSha256: string;
  readonly bankSha256: string;
  readonly protectedStateSha256: string;
};

async function currentItemBankQuestion(
  runtime: ItemBankRepairRuntime,
  input: ItemBankRepairInput,
  signal: AbortSignal,
): Promise<CurrentItemBankQuestion> {
  let source: string | undefined;
  const tool = (name: string): string => {
    const matches = runtime.searchCatalog({ query: name, limit: 100 }).tools.filter((candidate) => {
      const descriptor = runtime.capabilityGet(candidate.publicName).descriptor;
      return candidate.upstreamName === name && candidate.annotations?.readOnlyHint === true
        && (!source || candidate.upstreamId === source) && isJsonObject(descriptor)
        && isJsonObject(descriptor.route) && descriptor.route.backend === "canvas-connector";
    });
    if (matches.length !== 1) throw new ItemBankRepairError("The Canvas connection needed for this item bank question is unavailable.");
    source = matches[0]!.upstreamId;
    return matches[0]!.publicName;
  };
  /*
   * The Item Bank question write is resolved from the merged catalog rather
   * than through `searchCatalog`, because this planner needs the one write tool
   * on the same Canvas connection as the reads above, chosen by its upstream
   * name and its write annotation rather than by a search rank.
   */
  const writeTool = (): string => {
    const matches = runtime.catalog.tools.filter((candidate) => candidate.upstreamName === WRITE_TOOL
      && candidate.annotations?.readOnlyHint === false
      && candidate.capability?.route?.backend === "canvas-connector");
    if (matches.length !== 1) throw new ItemBankRepairError("The Canvas connection needed for this item bank question is unavailable.");
    source = matches[0]!.upstreamId;
    return matches[0]!.publicName;
  };
  const read = async (name: string, args: JsonObject): Promise<JsonObject> => {
    try {
      return canvasReadResult(runtime, await runtime.callSourceOwned(tool(name), {
        ...args, _morrow: { source_binding_id: input.source_binding_id },
      }, { signal }));
    } catch {
      throw new ItemBankRepairError("Morrow could not read the current item bank question.");
    }
  };
  // The write is resolved first, so every read below comes from the same Canvas
  // connection as the change this planner freezes.
  const write = writeTool();
  const [courseResult, bankResult, entryResult, itemResult] = await Promise.all([
    read("canvas_get_single_course_courses", { id: input.course_id }),
    read("canvas_item_bank_get_bank", { course_id: input.course_id, bank_id: input.bank_id }),
    read("canvas_item_bank_get_entry", { course_id: input.course_id, bank_id: input.bank_id, bank_entry_id: input.bank_entry_id }),
    read("canvas_item_bank_get_item", { course_id: input.course_id, bank_id: input.bank_id, item_id: input.item_id }),
  ]);
  const course = courseResult.data;
  const bank = bankResult.data;
  const bankEntry = entryResult.data;
  const item = itemResult.data;
  if (!isJsonObject(course) || asText(course.id) !== input.course_id || typeof course.name !== "string" || course.name.trim() === "") {
    throw new ItemBankRepairError("Morrow could not confirm the selected course from a fresh Canvas read.");
  }
  if (!isJsonObject(bank) || asText(bank.id) !== input.bank_id) {
    throw new ItemBankRepairError("Morrow could not confirm the current item bank from a fresh owner-session read.");
  }
  if (!isJsonObject(item) || asText(item.id) !== input.item_id || item.entry_type !== "Item"
    || !isJsonObject(item.entry) || typeof item.entry.item_body !== "string") {
    throw new ItemBankRepairError("Canvas did not return this exact item bank question in a shape Morrow can repair.");
  }
  if (!isJsonObject(bankEntry)) {
    throw new ItemBankRepairError("Canvas did not return the bank entry for this question.");
  }
  if (!itemBankEntryMatchesTarget(bankEntry, input.bank_entry_id, input.bank_id, input.item_id)) {
    throw new ItemBankRepairError("Canvas did not return this exact bank entry in this exact item bank.");
  }
  if (bankEntry.entry_type !== "Item") {
    throw new ItemBankRepairError(`This bank entry is a ${asText(bankEntry.entry_type) || "different"} entry, not a question. Morrow repairs only a question entry in an item bank.`);
  }
  const protectedState = protectedItemState(item);
  if (protectedState === null || interactionIds(item) === null) {
    throw new ItemBankRepairError("Morrow could not read every answer identifier in this question, so it will not propose a change to it.");
  }
  const entry = item.entry;
  const rawTitle = typeof entry.title === "string" ? entry.title.trim() : "";
  return {
    writeTool: write,
    courseName: course.name.trim(),
    item,
    body: entry.item_body as string,
    // The question title is provider text. It names the target here, so it is
    // used only when it is short and carries no markup of its own.
    title: rawTitle && rawTitle.length <= 200 && !rawTitle.includes("<") ? rawTitle : "one item bank question",
    itemSha256: sha256Json(item),
    bankSha256: sha256Json(bank),
    protectedStateSha256: sha256Json(protectedState),
  };
}

function courseLabel(id: string): string {
  return `course ${id}`;
}

function courseList(ids: readonly string[]): string {
  return ids.map(courseLabel).join(", ");
}

function noPlan(error: unknown): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `No change was planned. ${error instanceof ItemBankRepairError ? error.message : "Morrow could not finish the item bank question check. Check the Canvas connection and try again."}` }],
    structuredContent: { schema: "morrow.problem.v1", code: "item_bank_repair_not_planned" },
  };
}

const FAN_OUT_SCHEMA = "morrow.canvas.item-bank.fan-out.v1";
const FAN_OUT_SOURCES = ["bank_entries", "shared_banks", "quiz_uses"] as const;
const FAN_OUT_MAX_AGE_MS = 60 * 60 * 1_000;
const COURSE_ID = /^[1-9][0-9]*$/;
const ENTITY_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
const ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TIMEZONE = /(?:Z|[+-][0-9]{2}:?[0-9]{2})$/i;

// Course ids are decimal with no leading zero, so length before text is their
// numeric order. It keeps course 10 after course 9 in every list a person reads.
const compareCourseIds = (a: string, b: string): number => a.length === b.length ? compareText(a, b) : a.length - b.length;

type FanOutConsumer = { readonly course_id: string; readonly entity_type: string; readonly entity_id: string };

const compareConsumers = (a: FanOutConsumer, b: FanOutConsumer): number =>
  compareCourseIds(a.course_id, b.course_id) || compareText(a.entity_type, b.entity_type) || compareText(a.entity_id, b.entity_id);

const externalCourseIdsOf = (consumers: readonly FanOutConsumer[], courseId: string): string[] =>
  [...new Set(consumers.map((consumer) => consumer.course_id))].filter((id) => id !== courseId).sort(compareCourseIds);

/** Mirrors `normalizeFanOutConsumers` in the Bridge. A repeated triple is refused, never collapsed. */
function normalizeFanOutConsumers(values: unknown): FanOutConsumer[] | null {
  if (!Array.isArray(values)) return null;
  const rows: FanOutConsumer[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!isJsonObject(value)) return null;
    const consumer = { course_id: asText(value.course_id), entity_type: asText(value.entity_type), entity_id: asText(value.entity_id) };
    if (!COURSE_ID.test(consumer.course_id) || !ENTITY_TYPE.test(consumer.entity_type) || !ENTITY_ID.test(consumer.entity_id)) return null;
    const key = `${consumer.course_id} ${consumer.entity_type} ${consumer.entity_id}`;
    if (seen.has(key)) return null;
    seen.add(key);
    rows.push(consumer);
  }
  return rows.sort(compareConsumers);
}

/** Mirrors the Bridge's unread-source rule. A record with no readable source list counts as nothing read. */
function fanOutUnreadSources(record: JsonObject): string[] {
  const exhausted = new Map<string, boolean>();
  for (const row of Array.isArray(record.sources) ? record.sources : []) {
    const name = asText(isJsonObject(row) ? row.name : undefined);
    exhausted.set(name, exhausted.has(name) ? false : isJsonObject(row) && row.exhausted === true);
  }
  const declared = Array.isArray(record.unreachable) ? record.unreachable.map(asText) : [...FAN_OUT_SOURCES];
  return [...new Set([...declared, ...FAN_OUT_SOURCES.filter((name) => exhausted.get(name) !== true)])].sort(compareText);
}

/**
 * The Bridge's fan-out rule, mirrored at plan time so a plan is never presented
 * for approval that dispatch would refuse: `validObservedFanOut` in
 * connector/extension/src/item-bank-executor.js and `validFanOut` in
 * connector/extension/src/item-bank-fan-out.js. Same rule, same reason tokens.
 * Returns null when the record authorises the change, or its one reason.
 */
export function fanOutPlanRefusal(record: unknown, options: {
  readonly bankId: string;
  readonly courseId: string;
  readonly acknowledgedCourseIds: readonly string[];
  readonly now: number;
}): string | null {
  if (!isJsonObject(record)) return "missing_record";
  if (record.schema !== FAN_OUT_SCHEMA) return "wrong_schema";
  if (asText(record.bank_id) !== options.bankId) return "bank_mismatch";
  if (asText(record.course_id) !== options.courseId) return "course_mismatch";
  // A source that was not read is not an empty fan-out, and no record may claim
  // complete reach: Canvas provides no authoritative way to prove it.
  const unread = fanOutUnreadSources(record);
  if (record.complete !== false || unread.length === 0) return "authoritative_reach_claim_refused";
  const consumers = normalizeFanOutConsumers(record.consumers);
  if (consumers === null) return "consumers_invalid";
  if (record.consumer_count !== consumers.length) return "consumer_count_mismatch";
  if (!SHA256.test(asText(record.consumers_sha256)) || record.consumers_sha256 !== sha256Json(consumers)) return "consumers_digest_mismatch";
  if (typeof record.established_at !== "string" || !TIMEZONE.test(record.established_at) || !Number.isFinite(Date.parse(record.established_at))) return "established_at_unreadable";
  if (!Number.isFinite(options.now)) return "record_age_unknown";
  if (Date.parse(record.established_at) > options.now) return "record_from_future";
  if (options.now - Date.parse(record.established_at) > FAN_OUT_MAX_AGE_MS) return "record_too_old";
  const external = externalCourseIdsOf(consumers, options.courseId);
  if (JSON.stringify(record.external_course_ids) !== JSON.stringify(external)) return "external_course_ids_mismatch";
  // The acknowledgement is an exact list, never an omission: a bank that
  // reaches no other course still needs the empty list to be sent.
  if (!sameList([...options.acknowledgedCourseIds].sort(compareCourseIds), external)) return "acknowledgement_mismatch";
  return null;
}

/**
 * One plan refusal for a fan-out record that dispatch would refuse, with the
 * fixed code the dispatch refusal carries and the words a person acts on.
 */
export function itemBankFanOutPlanRefusal(record: unknown, options: {
  readonly bankId: string;
  readonly courseId: string;
  readonly acknowledgedCourseIds: readonly string[];
  readonly now: number;
}): { readonly code: string; readonly message: string } | null {
  const reason = fanOutPlanRefusal(record, options);
  if (reason === null) return null;
  let message = "The list of courses this item bank reaches does not match this bank, this course, and its own record. Read it again with morrow_read_item_bank_fan_out.";
  if (reason === "acknowledgement_mismatch") {
    // Every other field of the record was already checked, so its list of
    // affected courses can be named here. A person who is told only that the
    // lists differ has to compare them by hand; naming the courses is the
    // difference between a refusal and a next step.
    const external = isJsonObject(record) && Array.isArray(record.external_course_ids)
      ? record.external_course_ids.map(asText) : [];
    const confirmed = new Set(options.acknowledgedCourseIds);
    const missing = external.filter((id) => !confirmed.has(id));
    const extra = options.acknowledgedCourseIds.filter((id) => !external.includes(id));
    message = [
      "The confirmed courses are not exactly the courses this item bank reaches.",
      ...(missing.length > 0 ? [`You did not confirm ${courseList(missing)}.`] : []),
      ...(extra.length > 0 ? [`You confirmed ${courseList(extra)}, which this bank does not reach.`] : []),
      "Confirm every course in the fan-out record, and only those.",
    ].join(" ");
  } else if (reason === "record_too_old") {
    message = "The list of courses this item bank reaches is more than one hour old. Read it again with morrow_read_item_bank_fan_out.";
  } else if (reason === "authoritative_reach_claim_refused") {
    message = "A fan-out record that claims complete reach cannot authorise a change, because Canvas provides no authoritative way to prove reach. Read the fan-out again with morrow_read_item_bank_fan_out.";
  } else if (reason === "bank_mismatch" || reason === "course_mismatch") {
    message = "The fan-out record does not describe this bank and course. Read the fan-out again with morrow_read_item_bank_fan_out.";
  }
  return { code: `item_bank_fan_out_${reason}`, message };
}

const escapeAlt = (value: string): string => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export async function planItemBankQuestionImageAltRepair(
  runtime: ItemBankRepairRuntime,
  value: z.infer<typeof inputSchema>,
  callerSignal?: AbortSignal,
): Promise<CallToolResult> {
  const input = inputSchema.parse(value);
  const timeout = AbortSignal.timeout(60_000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  try {
    const fanOutRefusal = itemBankFanOutPlanRefusal(input.fan_out, {
      bankId: input.bank_id, courseId: input.course_id, acknowledgedCourseIds: input.acknowledged_course_ids, now: Date.now(),
    });
    if (fanOutRefusal !== null) {
      return {
        isError: true,
        content: [{ type: "text", text: `No change was planned. ${fanOutRefusal.message}` }],
        structuredContent: { schema: "morrow.problem.v1", code: fanOutRefusal.code },
      };
    }
    const current = await currentItemBankQuestion(runtime, input, signal);
    if (input.item_sha256 !== current.itemSha256) {
      throw new ItemBankRepairError("This item bank question changed since this accessibility signal. Run the audit again before planning a repair.");
    }
    if (current.body.length === 0 || current.body.length > MAX_ITEM_BODY) {
      throw new ItemBankRepairError("Morrow could not read this question body as one bounded source.");
    }
    const scan = contentImages(current.body);
    if (scan.open) throw new ItemBankRepairError("Morrow could not read this question body to its end, so it cannot say which image is which.");
    const selected = scan.images[input.image_index - 1];
    const attributes = selected ? imageAttributes(selected.tag) : null;
    if (!selected || !attributes) throw new ItemBankRepairError("The selected image is no longer at this position in the question. Run the audit again before planning a repair.");
    const source = attributes.get("src");
    if (typeof source !== "string" || source.length === 0 || sha256Text(source) !== input.image_src_sha256) {
      throw new ItemBankRepairError("The image at this position is not the image this signal named. Run the audit again before planning a repair.");
    }
    if (attributes.has("alt")) throw new ItemBankRepairError("This image already carries an alternative-text attribute. Morrow does not replace alternative text a person wrote.");
    const matching = scan.images.filter((image) => {
      const otherSource = imageAttributes(image.tag)?.get("src");
      return typeof otherSource === "string" && sha256Text(otherSource) === input.image_src_sha256;
    });
    if (matching.length !== 1) throw new ItemBankRepairError("This question uses the same image more than once, so Morrow cannot name one of them exactly.");

    const suffix = selected.tag.endsWith("/>") ? "/>" : ">";
    const replacement = `${selected.tag.slice(0, selected.tag.length - suffix.length)} alt="${escapeAlt(input.alt_text)}"${suffix}`;
    const nextBody = `${current.body.slice(0, selected.start)}${replacement}${current.body.slice(selected.end + 1)}`;
    const proposed = structuredClone(current.item);
    (proposed.entry as JsonObject).item_body = nextBody;
    if (sha256Json(protectedItemState(proposed)) !== current.protectedStateSha256
      || !sameList(interactionIds(proposed), interactionIds(current.item) || [])) {
      throw new ItemBankRepairError("Morrow could not preserve every answer identifier and protected question field.");
    }
    signal.throwIfAborted();
    const planned = await runtime.planOperationWithCurrentEditPermission(current.writeTool, {
      course_id: input.course_id,
      bank_id: input.bank_id,
      item_id: input.item_id,
      item: proposed,
      expected_snapshot: { bank_sha256: current.bankSha256, item_sha256: current.itemSha256 },
      fan_out: input.fan_out,
      fan_out_receipt: input.fan_out_receipt,
      acknowledged_course_ids: input.acknowledged_course_ids,
      _morrow: { source_binding_id: input.source_binding_id },
    });
    if (planned.isError === true) return planned as unknown as CallToolResult;
    const editAuthorized = isJsonObject(planned.structuredContent) && planned.structuredContent.effectState === "approved";
    return {
      ...planned,
      content: [{ type: "text", text: `${editAuthorized ? "Morrow prepared" : "Review"} an alternative-text repair for image ${input.image_index} in ${current.title} (item bank ${input.bank_id}, ${current.courseName}).\n\nAlternative text: ${input.alt_text}\n\nNo change has been sent. ${editAuthorized ? "Your current extension Edit permission covers this exact Item Bank item update." : "The review covers this exact Item Bank item update."} The bridge will reopen the selected course's Item Banks tool, bind a fresh credential, confirm the bank and complete item snapshots, send one update, and reread the exact item.` }],
    } as CallToolResult;
  } catch (error) {
    return noPlan(error);
  }
}

export function registerItemBankRepairTool(server: McpServer, runtime: GatewayRuntime): void {
  server.registerTool("morrow_plan_item_bank_question_image_alt_repair", {
    title: "Review a New Quizzes item bank question image alternative-text repair",
    description: "Plan one alternative-text repair for one exact image in one New Quizzes Item Bank question. Morrow fresh-reads the course, bank, entry, and item, preserves all question fields and answer identifiers, and binds the reviewed update to the exact bank and item snapshots. No Canvas write occurs during planning.",
    inputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (input, context) => planItemBankQuestionImageAltRepair(runtime, input, context.mcpReq.signal));
}
