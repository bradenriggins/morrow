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
  fan_out: z.record(z.string(), z.unknown()).describe("The complete record from morrow_read_item_bank_fan_out for this bank and course."),
  acknowledged_course_ids: z.array(courseIdSchema).max(200).describe("Exactly the courses in fan_out.external_course_ids, confirmed by the person. Send the empty list when the bank reaches no other course."),
}).superRefine((value, context) => {
  if (value.alt_text.trim().length === 0) {
    context.addIssue({ code: "custom", message: "An item bank question image needs alternative text a person can read." });
  }
  if (new Set(value.acknowledged_course_ids).size !== value.acknowledged_course_ids.length) {
    context.addIssue({ code: "custom", message: "Name each acknowledged course once." });
  }
});

type ItemBankRepairInput = z.infer<typeof inputSchema>;
type ItemBankRepairRuntime = Pick<GatewayRuntime, "catalog" | "searchCatalog" | "capabilityGet" | "callSourceOwned" | "resultPage" | "planOperationWithCurrentEditPermission">;

const WRITE_TOOL = "canvas_item_bank_update_item";

class ItemBankRepairError extends Error {}

/*
 * The rules below are the Morrow Bridge rules, mirrored in TypeScript:
 * `connector/extension/src/item-bank-guard.js` (the guard the Item Banks frame
 * enforces) and `connector/extension/src/item-bank-fan-out.js` (the record that
 * authorises a change to a shared bank). Those modules are plain JavaScript
 * with no declaration file, and a declaration file cannot live beside them
 * because the Bridge release ships an exact file set (`BRIDGE_SOURCE_FILES` in
 * `scripts/package-mcp-bundle.mjs`), so they cannot be imported here.
 *
 * `test/item-bank-repair.test.ts` runs the Bridge modules over the same
 * questions and the same records this planner reads, and requires the same
 * digests, the same image decision, and the same fan-out reason, so the two
 * copies cannot drift apart unnoticed. A planner that accepted what the frame
 * refuses would spend a person's approval on a change that can never be sent.
 */
const GUARD_KIND = "item_bank_entry_image_alt";
const FAN_OUT_SCHEMA = "morrow.canvas.item-bank.fan-out.v1";
const FAN_OUT_SOURCES = ["bank_entries", "shared_banks", "quiz_uses"] as const;
const FAN_OUT_MAX_AGE_MS = 60 * 60 * 1_000;
const MAX_ITEM_BODY = 200_000;
const INTERACTION_ID_GROUPS = ["choices", "questions", "blanks", "entries"] as const;

const COURSE_ID = /^[1-9][0-9]*$/;
const ENTITY_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
const ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const INTERACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TIMEZONE = /(?:Z|[+-][0-9]{2}:?[0-9]{2})$/i;
const TAG = /<!--[\s\S]*?-->|<(?:"[^"]*"|'[^']*'|[^'">])*>/g;
const TAG_NAME = /^<\s*(\/?)\s*([a-zA-Z][^\s/>]*)/;
const ATTRIBUTE = /^\s+([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/;
const RAW_TEXT = ["script", "style", "iframe", "object", "embed", "textarea", "title"];
const IMAGELESS_SUBTREE = ["svg", "math"];

const asText = (value: unknown): string => typeof value === "string" ? value
  : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
// Course ids are decimal with no leading zero, so length before text is their
// numeric order. It keeps course 10 after course 9 in every list a person reads.
const compareCourseIds = (a: string, b: string): number => a.length === b.length ? compareText(a, b) : a.length - b.length;
const sameList = (value: unknown, expected: readonly string[]): boolean => Array.isArray(value)
  && value.length === expected.length && expected.every((entry, index) => value[index] === entry);

type FanOutConsumer = { readonly course_id: string; readonly entity_type: string; readonly entity_id: string };

const compareConsumers = (a: FanOutConsumer, b: FanOutConsumer): number =>
  compareCourseIds(a.course_id, b.course_id) || compareText(a.entity_type, b.entity_type) || compareText(a.entity_id, b.entity_id);

const externalCourseIds = (consumers: readonly FanOutConsumer[], courseId: string): string[] =>
  [...new Set(consumers.map((consumer) => consumer.course_id))].filter((id) => id !== courseId).sort(compareCourseIds);

/** Mirrors `normalizeFanOutConsumers`. A repeated triple is refused, never collapsed. */
function normalizeConsumers(values: unknown): FanOutConsumer[] | null {
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

/** Mirrors `unreadSources`. A record with no readable source list counts as nothing read. */
function unreadSources(record: JsonObject): string[] {
  const exhausted = new Map<string, boolean>();
  for (const row of Array.isArray(record.sources) ? record.sources : []) {
    const name = asText(isJsonObject(row) ? row.name : undefined);
    exhausted.set(name, exhausted.has(name) ? false : isJsonObject(row) && row.exhausted === true);
  }
  const declared = Array.isArray(record.unreachable) ? record.unreachable.map(asText) : [...FAN_OUT_SOURCES];
  return [...new Set([...declared, ...FAN_OUT_SOURCES.filter((name) => exhausted.get(name) !== true)])].sort(compareText);
}

/** Mirrors `validFanOut`. Returns null when the record authorises the change, or its one reason. */
function fanOutRefusal(record: unknown, options: {
  readonly bankId: string;
  readonly courseId: string;
  readonly acknowledgedCourseIds: readonly string[];
  readonly now: number;
}): string | null {
  if (!isJsonObject(record)) return "missing_record";
  if (record.schema !== FAN_OUT_SCHEMA) return "wrong_schema";
  if (record.bank_id !== options.bankId) return "bank_mismatch";
  if (record.course_id !== options.courseId) return "course_mismatch";
  // A source that was not read is not an empty fan-out, so an incomplete record
  // never authorises a change however few consumers it lists.
  if (record.complete !== true || unreadSources(record).length > 0) return "incomplete_unread_source_is_not_an_empty_fan_out";
  const consumers = normalizeConsumers(record.consumers);
  if (consumers === null) return "consumers_invalid";
  if (record.consumer_count !== consumers.length) return "consumer_count_mismatch";
  if (!SHA256.test(asText(record.consumers_sha256)) || record.consumers_sha256 !== sha256Json(consumers)) return "consumers_digest_mismatch";
  if (typeof record.established_at !== "string" || !TIMEZONE.test(record.established_at) || !Number.isFinite(Date.parse(record.established_at))) return "established_at_unreadable";
  if (!Number.isFinite(options.now)) return "record_age_unknown";
  if (options.now - Date.parse(record.established_at) > FAN_OUT_MAX_AGE_MS) return "record_too_old";
  const external = externalCourseIds(consumers, options.courseId);
  if (!sameList(record.external_course_ids, external)) return "external_course_ids_mismatch";
  // The acknowledgement is an exact list, never an omission: a bank that
  // reaches no other course still needs the empty list to be sent.
  if (!sameList([...options.acknowledgedCourseIds].map(asText).sort(compareCourseIds), external)) return "acknowledgement_mismatch";
  return null;
}

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
   * The connector publishes the Item Bank question write only as the guarded
   * repair, and Morrow keeps it out of every client tool list
   * (`PRIVATE_SOURCE_TOOL_NAMES` in runtime.ts), so it is not in the searchable
   * catalog and `capabilityGet` does not answer for it. This planner is the one
   * caller, so it resolves the tool from the merged catalog directly, the same
   * way the Canvas file transfer resolves its own private tool.
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
  const [courseResult, entryResult, itemResult] = await Promise.all([
    read("canvas_get_single_course_courses", { id: input.course_id }),
    read("canvas_item_bank_get_entry", { bank_id: input.bank_id, bank_entry_id: input.bank_entry_id }),
    read("canvas_item_bank_get_item", { bank_id: input.bank_id, item_id: input.item_id }),
  ]);
  const course = courseResult.data;
  const bankEntry = entryResult.data;
  const item = itemResult.data;
  if (!isJsonObject(course) || asText(course.id) !== input.course_id || typeof course.name !== "string" || course.name.trim() === "") {
    throw new ItemBankRepairError("Morrow could not confirm the selected course from a fresh Canvas read.");
  }
  if (!isJsonObject(item) || asText(item.id) !== input.item_id || item.entry_type !== "Item"
    || !isJsonObject(item.entry) || typeof item.entry.item_body !== "string") {
    throw new ItemBankRepairError("Canvas did not return this exact item bank question in a shape Morrow can repair.");
  }
  if (!isJsonObject(bankEntry)) {
    throw new ItemBankRepairError("Canvas did not return the bank entry for this question.");
  }
  if (bankEntry.entry_type !== "Item") {
    throw new ItemBankRepairError(`This bank entry is a ${asText(bankEntry.entry_type) || "different"} entry, not a question. Morrow repairs only a question entry in an item bank.`);
  }
  if (!entryLinksItem(bankEntry, input.item_id)) {
    throw new ItemBankRepairError("This bank entry does not name this question, so Morrow cannot show that the entry and the question are the same target.");
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

export async function planItemBankQuestionImageAltRepair(
  runtime: ItemBankRepairRuntime,
  value: z.infer<typeof inputSchema>,
  callerSignal?: AbortSignal,
): Promise<CallToolResult> {
  const input = inputSchema.parse(value);
  const timeout = AbortSignal.timeout(60_000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  try {
    const current = await currentItemBankQuestion(runtime, input, signal);
    if (input.item_sha256 !== current.itemSha256) {
      throw new ItemBankRepairError("This item bank question changed since this accessibility signal. Run the audit again before planning a repair.");
    }
    const refusal = fanOutRefusal(input.fan_out, {
      bankId: input.bank_id,
      courseId: input.course_id,
      acknowledgedCourseIds: input.acknowledged_course_ids,
      now: Date.now(),
    });
    if (refusal === "incomplete_unread_source_is_not_an_empty_fan_out") {
      throw new ItemBankRepairError("Morrow could not read every course this item bank reaches. A source it could not read is not an empty list of courses, so it will not plan a change to a bank whose reach is unknown. Read the fan-out again with morrow_read_item_bank_fan_out.");
    }
    if (refusal === "acknowledgement_mismatch") {
      // Every other field of the record was already checked, so its list of
      // affected courses can be named here. A person who is told only that the
      // lists differ has to compare them by hand; naming the courses is the
      // difference between a refusal and a next step.
      const external = Array.isArray((input.fan_out as JsonObject).external_course_ids)
        ? ((input.fan_out as JsonObject).external_course_ids as unknown[]).map(asText)
        : [];
      const confirmed = new Set(input.acknowledged_course_ids);
      const missing = external.filter((id) => !confirmed.has(id));
      const extra = input.acknowledged_course_ids.filter((id) => !external.includes(id));
      throw new ItemBankRepairError([
        "The confirmed courses are not exactly the courses this item bank reaches.",
        ...(missing.length > 0 ? [`You did not confirm ${courseList(missing)}.`] : []),
        ...(extra.length > 0 ? [`You confirmed ${courseList(extra)}, which this bank does not reach.`] : []),
        "Confirm every course in the fan-out record, and only those.",
      ].join(" "));
    }
    if (refusal === "record_too_old") {
      throw new ItemBankRepairError("The list of courses this item bank reaches is more than one hour old. Read it again with morrow_read_item_bank_fan_out.");
    }
    if (refusal !== null) {
      throw new ItemBankRepairError("The list of courses this item bank reaches does not match this bank, this course, and its own record. Read it again with morrow_read_item_bank_fan_out.");
    }
    const record = input.fan_out as unknown as JsonObject;
    const affected = (record.external_course_ids as readonly string[]);
    if (current.body.length === 0 || current.body.length > MAX_ITEM_BODY) {
      throw new ItemBankRepairError("Morrow could not read this question body as one bounded source.");
    }
    const scan = contentImages(current.body);
    if (scan.open) {
      throw new ItemBankRepairError("Morrow could not read this question body to its end, so it cannot say which image is which.");
    }
    const selected = scan.images[input.image_index - 1];
    const attributes = selected ? imageAttributes(selected.tag) : null;
    if (!selected || !attributes) {
      throw new ItemBankRepairError("The selected image is no longer at this position in the question. Run the audit again before planning a repair.");
    }
    const source = attributes.get("src");
    if (typeof source !== "string" || source.length === 0 || sha256Text(source) !== input.image_src_sha256) {
      throw new ItemBankRepairError("The image at this position is not the image this signal named. Run the audit again before planning a repair.");
    }
    if (attributes.has("alt")) {
      throw new ItemBankRepairError("This image already carries an alternative-text attribute. Morrow does not replace alternative text a person wrote.");
    }
    const matching = scan.images.filter((image) => {
      const other = imageAttributes(image.tag);
      const otherSource = other?.get("src");
      return typeof otherSource === "string" && sha256Text(otherSource) === input.image_src_sha256;
    });
    if (matching.length !== 1) {
      throw new ItemBankRepairError("This question uses the same image more than once, so Morrow cannot name one of them exactly.");
    }
    signal.throwIfAborted();
    const guard: JsonObject = {
      kind: GUARD_KIND,
      course_id: input.course_id,
      bank_id: input.bank_id,
      bank_entry_id: input.bank_entry_id,
      item_id: input.item_id,
      entry_type: "Item",
      item_sha256: current.itemSha256,
      protected_state_sha256: current.protectedStateSha256,
      image_index: input.image_index,
      image_src_sha256: input.image_src_sha256,
      alt_text: input.alt_text,
      fan_out: record,
      acknowledged_course_ids: [...input.acknowledged_course_ids].sort(compareCourseIds),
    };
    // The guard travels as an ordinary argument, not as a `_morrow` control:
    // `splitBridgeCallArguments` in packages/bridge-protocol accepts no item
    // bank control, and the Item Banks frame accepts exactly bank_id, item_id
    // and morrow_item_bank_guard.
    const planned = await runtime.planOperationWithCurrentEditPermission(current.writeTool, {
      bank_id: input.bank_id,
      item_id: input.item_id,
      morrow_item_bank_guard: guard,
      _morrow: { source_binding_id: input.source_binding_id },
    });
    if (planned.isError === true) return planned as unknown as CallToolResult;
    const editAuthorized = isJsonObject(planned.structuredContent) && planned.structuredContent.effectState === "approved";
    // The courses this bank reaches come before the change itself. A person
    // approving an item bank repair is approving it for every one of them.
    const reach = affected.length === 0
      ? `This item bank reaches no course other than ${current.courseName}. Morrow read every source of that answer.`
      : `This item bank is shared. Changing this question changes it in ${affected.length === 1 ? "1 other course" : `${affected.length} other courses`} as well: ${courseList(affected)}. You confirmed ${affected.length === 1 ? "that course" : "those courses"}.`;
    return {
      ...planned,
      content: [{ type: "text", text: `${reach}\n\n${editAuthorized ? "Morrow prepared" : "Review"} an alternative-text repair for image ${input.image_index} in ${current.title} (item bank ${input.bank_id}, ${current.courseName}).\n\nAlternative text: ${input.alt_text}\n\nNo change has been sent. ${editAuthorized ? "Your current extension Edit permission covers this item bank image repair only." : "The review covers this item bank image repair only."} The bridge will read this question again inside the signed-in Item Banks browser frame, change only the selected image alternative-text attribute, keep the question text, answers, answer identifiers, scoring, and settings, send exactly one change, and then read the question again and compare it. Canvas does not lock the question during these checks. Morrow refuses the change if the list of affected courses is more than one hour old when it is sent.` }],
    } as CallToolResult;
  } catch (error) {
    return noPlan(error);
  }
}

export function registerItemBankRepairTool(server: McpServer, runtime: GatewayRuntime): void {
  server.registerTool("morrow_plan_item_bank_question_image_alt_repair", {
    title: "Review a New Quizzes item bank question image alternative-text repair",
    description: "Plan one alternative-text repair for one missing-alt image in one New Quizzes item bank question. An item bank is shared machinery, so this needs a complete fan-out record from morrow_read_item_bank_fan_out and confirmation of every other course the bank reaches. Requires fresh audit evidence for the exact question and image. Keeps the question, answers, answer identifiers, scoring, and settings; changes one image alt attribute. No Canvas write occurs during planning. Morrow has not yet confirmed the Item Banks browser frame against a live Canvas tenant, so this path is unproven end to end, and it does not prove accessibility conformance.",
    inputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (input, context) => planItemBankQuestionImageAltRepair(runtime, input, context.mcpReq.signal));
}
