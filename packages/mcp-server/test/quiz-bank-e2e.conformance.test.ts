import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInThisContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { BridgeCommand } from "@morrow/bridge-protocol";
import {
  canvasOperationAdmission,
  parseCanvasApiCatalog,
  planCanvasRecoveryDescriptor,
  type CanvasApiOperation,
} from "@morrow/canvas-api-catalog";
import { isJsonObject, sha256Text, type JsonObject } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import { parseGatewayConfig } from "../src/config.js";
import { createFullMorrowServer } from "../src/full-server.js";
import { MorrowRuntime } from "../src/morrow-runtime.js";
import { bridgeCatalogDigestForTests } from "./fixtures/bridge-catalog-digest.js";
import { connectBridgeTestClient, type BridgeTestClient } from "./fixtures/bridge-client.js";
import { assertPortListening, reserveLoopbackPort } from "./fixtures/loopback-port.js";

type QuestionFixtures = {
  quizBankE2eQuestionPayloads(): Record<string, JsonObject>;
  QUIZ_BANK_E2E_QUESTION_TYPE_DISPOSITION: Readonly<Record<string, "admitted" | "held_media_chain">>;
};

type ItemBankGuard = {
  itemBankItemDigest(item: unknown): Promise<string>;
  applyItemBankImageAlt(body: string, guard: unknown): Promise<{ body?: string; error?: string }>;
};

type ItemBankCredentialContract = {
  ITEM_BANK_CREDENTIAL_MAX_AGE_MS: number;
  itemBankApiOriginForFrameUrl(value: string): string;
  itemBankLaunchUrl(tabUrl: string, canvasOrigin: string, courseId: string): string;
  itemBankPermissionOrigins(frames: readonly JsonObject[], canvasOrigin: string): string[];
  itemBankCredentialFromRequest(details: JsonObject, launch: JsonObject, now: number): JsonObject | null;
  usableItemBankCredential(credential: JsonObject | null, expected: JsonObject, now: number): JsonObject | null;
};

type ItemBankExecutor = {
  executeItemBankInPage(input: JsonObject): Promise<JsonObject>;
};

type QuizBankDrawExecutor = {
  executeQuizBankDrawInPage(input: JsonObject): Promise<JsonObject>;
};

type ItemBankFrameContract = {
  itemBankApiOriginForFrame(value: string): string;
  itemBankFrameIds(frames: readonly JsonObject[]): number[];
};

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SOURCE_BINDING_ID = "canvas:quiz-bank-e2e";
const COURSE_ID = "42";
const TOKEN = "quiz-bank-e2e-token-".repeat(4);
const EXTENSION_ID = "a".repeat(32);
const CATALOG_PATH = resolve(ROOT, "artifacts/canvas-api/canvas-api-catalog.json");
const catalog = parseCanvasApiCatalog(JSON.parse(readFileSync(CATALOG_PATH, "utf8")));
const relevantOperations = catalog.operations.filter((operation) => (
  operation.service === "item_bank" || operation.path.startsWith("/quiz/v1/")
));

const CURATED_TOOLS = new Set([
  "morrow_check_new_quiz",
  "morrow_read_item_bank_fan_out",
  "morrow_plan_item_bank_question_image_alt_repair",
  "morrow_plan_new_quiz_item_create",
  "morrow_plan_new_quiz_create",
  "morrow_plan_new_quiz_delete",
  "morrow_plan_new_quiz_module_placement",
  "morrow_plan_new_quiz_module_move",
  "morrow_plan_new_quiz_assignment_group_order",
  "morrow_plan_new_quiz_report",
  "morrow_plan_new_quiz_accommodation",
  "morrow_plan_new_quiz_item_replacement",
  "morrow_plan_new_quiz_item_delete",
  "morrow_plan_new_quiz_item_order",
  "morrow_plan_new_quiz_settings",
  "morrow_plan_new_quiz_item_image_alt_repair",
  "morrow_plan_new_quiz_choice_image_alt_repair",
  "morrow_plan_new_quiz_answer_feedback_image_alt_repair",
  "morrow_plan_new_quiz_feedback_image_alt_repair",
]);

function connectorConfig(directory: string, port: number) {
  return parseGatewayConfig({
    schema: "morrow.upstreams.v1",
    profile: "private-full",
    upstreams: [{
      id: "canvas-session",
      label: "Morrow Canvas Connector",
      kind: "mcp-stdio",
      command: process.execPath,
      args: [resolve(ROOT, "packages/canvas-connector-mcp/dist/index.js")],
      cwd: ROOT,
      env: {
        MORROW_CANVAS_CATALOG_PATH: CATALOG_PATH,
        MORROW_CANVAS_CONNECTOR_STATE: join(directory, "connector.json"),
        MORROW_CANVAS_CONNECTOR_PORT: String(port),
        MORROW_CANVAS_CONNECTOR_TOKEN: TOKEN,
        MORROW_CANVAS_CONNECTOR_EXTENSION_IDS: EXTENSION_ID,
      },
      sourceDisposition: "adapted_owned",
      outputPrivacy: {},
      outputPrivacyDefault: {
        allowedFields: [], fieldPolicy: "scrub-sensitive", dataClass: "course", maxRecords: 10_000,
        maxBytes: 2_000_000, freeText: "allow", learnerTokens: true, artifactInspection: "deny", aiClientAdmission: "allow",
      },
    }],
    filters: { excludePrefixes: [], excludeNames: [] },
    operationJournal: { path: join(directory, "gateway.sqlite3") },
    privacy: {
      canvasOrigin: "browser-session", account: "local", principal: "local",
      learnerVaultPath: join(directory, "vault.json"),
    },
    maxCatalogTools: 2_000,
  });
}

function structured(result: unknown): JsonObject {
  const value = isJsonObject(result) ? result.structuredContent : undefined;
  return isJsonObject(value) ? value : {};
}

function operationId(result: unknown): string {
  const id = structured(result).operationId;
  if (typeof id !== "string") throw new Error(`operation id missing: ${JSON.stringify(result)}`);
  return id;
}

function exactId(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "";
}

function stableJson(value: unknown): string {
  return Array.isArray(value)
    ? `[${value.map(stableJson).join(",")}]`
    : isJsonObject(value)
      ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`
      : JSON.stringify(value === undefined ? null : value);
}

async function browserDigest(value: unknown): Promise<string> {
  return sha256Text(stableJson(value));
}

function storage(values: Record<string, string>) {
  return { getItem: (key: string) => Object.hasOwn(values, key) ? values[key]! : null };
}

async function withGlobals<T>(values: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  const descriptors = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    return await run();
  } finally {
    for (const key of Object.keys(values)) {
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

function itemBankWorkerLifecycle(dependencies: {
  readonly chrome: unknown;
  readonly credential: ItemBankCredentialContract;
  readonly executor: ItemBankExecutor;
  readonly frames: ItemBankFrameContract;
  readonly credentials: Map<string, JsonObject>;
  readonly launches: Map<number, JsonObject>;
}) {
  const worker = readFileSync(resolve(ROOT, "connector/extension/src/service-worker.js"), "utf8");
  const begin = worker.indexOf("function clearItemBankCredentialsForTab");
  const end = worker.indexOf("async function executeOperation", begin);
  if (begin < 0 || end < 0) throw new Error("Item Bank worker lifecycle is missing");
  const source = worker.slice(begin, end);
  return Function(
    "chrome", "crypto", "itemBankCredentials", "pendingItemBankLaunches", "itemBankCredentialKey",
    "itemBankLaunchUrl", "itemBankPermissionOrigins", "usableItemBankCredential", "itemBankFrameIds",
    "itemBankApiOriginForFrame", "executeItemBankInPage", "ITEM_BANK_CREDENTIAL_WAIT_MS", "setTimeout",
    `"use strict"; ${source}; return { executeItemBank, freshItemBankContext, clearItemBankCredentialsForTab };`,
  )(
    dependencies.chrome,
    { randomUUID: () => "11111111-1111-4111-8111-111111111111" },
    dependencies.credentials,
    dependencies.launches,
    (tabId: number, frameId: number) => `${tabId}:${frameId}`,
    dependencies.credential.itemBankLaunchUrl,
    dependencies.credential.itemBankPermissionOrigins,
    dependencies.credential.usableItemBankCredential,
    dependencies.frames.itemBankFrameIds,
    dependencies.frames.itemBankApiOriginForFrame,
    dependencies.executor.executeItemBankInPage,
    45_000,
    (resolveDelay: () => void) => resolveDelay(),
  ) as {
    executeItemBank(binding: JsonObject, operation: JsonObject, args: JsonObject): Promise<JsonObject>;
  };
}

function itemBankRecoveryPlanner() {
  const worker = readFileSync(resolve(ROOT, "connector/extension/src/service-worker.js"), "utf8");
  const begin = worker.indexOf("async function itemBankRecoveryDescriptor");
  const end = worker.indexOf("async function canvasRecoveryDescriptor", begin);
  if (begin < 0 || end < 0) throw new Error("Item Bank recovery descriptor is missing");
  return Function("sha256", `"use strict"; ${worker.slice(begin, end)}; return itemBankRecoveryDescriptor;`)(
    async (value: string) => sha256Text(value),
  ) as (operation: JsonObject, args: JsonObject, result: JsonObject) => Promise<JsonObject | null>;
}

function operationFor(name: string): CanvasApiOperation {
  const operation = catalog.operations.find((candidate) => candidate.toolName === name);
  if (!operation) throw new Error(`catalog operation missing: ${name}`);
  return operation;
}

function providerItemFromArguments(args: JsonObject, id: string): JsonObject {
  const entry: JsonObject = {};
  for (const [key, value] of Object.entries(args)) {
    if (!key.startsWith("item_entry_")) continue;
    const leaf = key.slice("item_entry_".length);
    if (leaf.startsWith("feedback_")) {
      const feedback = isJsonObject(entry.feedback) ? entry.feedback : {};
      feedback[leaf.slice("feedback_".length)] = value;
      entry.feedback = feedback;
    } else entry[leaf] = value;
  }
  return {
    id,
    status: "mutable",
    entry_type: args.item_entry_type ?? "Item",
    points_possible: args.item_points_possible ?? 1,
    position: Number(args.item_position ?? 1),
    entry,
  };
}

function questionArguments(payload: JsonObject): JsonObject {
  const entry = payload.entry as JsonObject;
  const args: JsonObject = {
    course_id: COURSE_ID,
    assignment_id: "77",
    item_entry_type: payload.entry_type,
    item_points_possible: payload.points_possible,
  };
  for (const [key, value] of Object.entries(entry)) {
    if (key === "feedback" && isJsonObject(value)) {
      for (const [feedback, text] of Object.entries(value)) args[`item_entry_feedback_${feedback}`] = text;
    } else args[`item_entry_${key}`] = value;
  }
  args._morrow = { source_binding_id: SOURCE_BINDING_ID };
  return args;
}

function applyQuizArguments(current: JsonObject, args: JsonObject): JsonObject {
  const next = { ...current };
  const settings = isJsonObject(current.quiz_settings) ? structuredClone(current.quiz_settings) : {};
  for (const [key, value] of Object.entries(args)) {
    if (!key.startsWith("quiz_")) continue;
    const field = key.slice("quiz_".length);
    if (!field.startsWith("quiz_settings_")) {
      next[field] = value;
      continue;
    }
    const setting = field.slice("quiz_settings_".length);
    const group = ["multiple_attempts", "result_view_settings"].find((candidate) => setting.startsWith(`${candidate}_`));
    if (group) {
      const nested = isJsonObject(settings[group]) ? settings[group] as JsonObject : {};
      nested[setting.slice(group.length + 1)] = value;
      settings[group] = nested;
    } else if (setting === "filters_ips") {
      const nested = isJsonObject(settings.filters) ? settings.filters as JsonObject : {};
      nested.ips = value;
      settings.filters = nested;
    } else settings[setting] = value;
  }
  if (Object.keys(settings).length) next.quiz_settings = settings;
  return next;
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const end = Date.now() + 5_000;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(message);
}

async function approveThroughReviewPage(url: string): Promise<void> {
  const page = await fetch(url);
  const body = await page.text();
  const nonce = /name="nonce" value="([^"]+)"/.exec(body)?.[1];
  const cookie = page.headers.get("set-cookie")?.split(";", 1)[0];
  if (!nonce || !cookie) throw new Error("review page did not provide an approval nonce");
  const response = await fetch(`${url}/approve`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie,
      origin: new URL(url).origin,
      referer: url,
    },
    body: new URLSearchParams({ nonce }),
  });
  expect(response.status).toBe(303);
}

describe("New Quizzes and Item Banks end to end conformance", () => {
  it("binds Item Bank execution to one fresh course launch and private context UUID", async () => {
    const credentialContract = await import(
      new URL("../../../connector/extension/src/item-bank-credential.js", import.meta.url).href
    ) as ItemBankCredentialContract;
    const executor = await import(
      new URL("../../../connector/extension/src/item-bank-executor.js", import.meta.url).href
    ) as ItemBankExecutor;
    const frameContract = await import(
      new URL("../../../connector/extension/src/item-bank-frames.js", import.meta.url).href
    ) as ItemBankFrameContract;
    const drawExecutor = await import(
      new URL("../../../connector/extension/src/quiz-bank-draw-executor.js", import.meta.url).href
    ) as QuizBankDrawExecutor;
    const canvasOrigin = "https://school.instructure.com";
    const launchUrl = `${canvasOrigin}/courses/${COURSE_ID}/external_tools/54065`;
    expect(credentialContract.itemBankLaunchUrl(`${canvasOrigin}/courses/${COURSE_ID}`, canvasOrigin, COURSE_ID)).toBe(launchUrl);
    expect(credentialContract.itemBankLaunchUrl(`${canvasOrigin}/courses/${COURSE_ID}/quizzes`, canvasOrigin, COURSE_ID)).toBe(launchUrl);
    expect(credentialContract.itemBankLaunchUrl(`${canvasOrigin}/courses/43`, canvasOrigin, COURSE_ID)).toBe("");
    expect(credentialContract.itemBankLaunchUrl("https://evil.example/courses/42", canvasOrigin, COURSE_ID)).toBe("");
    expect(credentialContract.itemBankApiOriginForFrameUrl("https://school.quiz-lti.instructure.com/lti/launch"))
      .toBe("https://school.quiz-api.instructure.com");
    expect(credentialContract.itemBankPermissionOrigins([
      { frameId: 7, url: "https://school.quiz-lti.instructure.com/lti/launch" },
    ], canvasOrigin)).toEqual([
      "https://school.quiz-lti.instructure.com/*",
      "https://school.quiz-api.instructure.com/*",
    ]);
    expect(credentialContract.itemBankPermissionOrigins([
      { frameId: 7, url: "https://school.quiz-lti.instructure.com/lti/launch" },
      { frameId: 8, url: "https://school.quiz-lti-iad-prod.instructure.com/lti/launch" },
    ], canvasOrigin)).toEqual([]);

    const launchedAt = 1_000_000;
    const launch = {
      tabId: 5, canvasLocalContextId: COURSE_ID, launchUrl,
      launchNonce: "11111111-1111-4111-8111-111111111111", launchedAt,
    };
    const token = `Signature ${"credential-".repeat(8)}`;
    const captured = credentialContract.itemBankCredentialFromRequest({
      method: "GET", tabId: 5, frameId: 7,
      url: "https://school.quiz-api.instructure.com/api/banks?course_id=course-context-uuid",
      documentUrl: "https://school.quiz-lti.instructure.com/lti/launch",
      requestHeaders: [{ name: "Authorization", value: token }, { name: "AuthType", value: "Signature" }],
    }, launch, launchedAt + 1);
    expect(captured).toMatchObject({
      tabId: 5, frameId: 7, canvasLocalContextId: COURSE_ID, launchUrl,
      launchNonce: launch.launchNonce, launchedAt, capturedAt: launchedAt + 1,
      apiOrigin: "https://school.quiz-api.instructure.com", contextUuid: "course-context-uuid",
    });
    const expectedCredential = {
      tabId: 5, frameId: 7, canvasLocalContextId: COURSE_ID, launchUrl,
      launchNonce: launch.launchNonce, launchedAt, apiOrigin: "https://school.quiz-api.instructure.com",
    };
    expect(credentialContract.usableItemBankCredential(captured, expectedCredential, launchedAt + 2)).toBe(captured);
    expect(credentialContract.usableItemBankCredential(captured, { ...expectedCredential, canvasLocalContextId: "43" }, launchedAt + 2)).toBeNull();
    expect(credentialContract.usableItemBankCredential(
      { ...captured, capturedAt: launchedAt - 1 }, expectedCredential, launchedAt + 2,
    )).toBeNull();
    expect(credentialContract.usableItemBankCredential(
      captured, expectedCredential, launchedAt + 1 + credentialContract.ITEM_BANK_CREDENTIAL_MAX_AGE_MS + 1,
    )).toBeNull();

    const requests: { url: string; options: JsonObject }[] = [];
    const now = Date.now();
    const currentUser = JSON.stringify({ id: "7" });
    const probeInput = {
      operation: operationFor("canvas_item_bank_list_banks"),
      principalId: "7", canvasOrigin, courseId: COURSE_ID, contextOnly: true,
    };
    const boundProbe = await withGlobals({
      location: { hostname: "school.quiz-lti.instructure.com" }, document: { referrer: launchUrl },
      sessionStorage: storage({ current_user: currentUser }), localStorage: storage({}), ENV: {},
    }, async () => await executor.executeItemBankInPage(probeInput));
    expect(boundProbe).toEqual({ matched: true, ok: true, sent: false });

    const result = await withGlobals({
      location: { hostname: "school.quiz-lti.instructure.com" },
      document: { referrer: launchUrl },
      sessionStorage: storage({ current_user: currentUser }),
      localStorage: storage({}),
      ENV: {},
      fetch: async (url: string, options: JsonObject) => {
        requests.push({ url: String(url), options });
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      },
    }, async () => await executor.executeItemBankInPage({
      operation: operationFor("canvas_item_bank_list_banks"),
      arguments: { course_id: COURSE_ID, morrow_max_pages: 1 },
      principalId: "7", canvasOrigin, courseId: COURSE_ID,
      credential: {
        apiOrigin: "https://school.quiz-api.instructure.com", token, authType: "Signature",
        canvasLocalContextId: COURSE_ID, contextUuid: "course-context-uuid", launchUrl,
        launchNonce: launch.launchNonce, launchedAt: now - 1, capturedAt: now,
      },
    }));
    expect(result).toMatchObject({ matched: true, ok: true, sent: true, data: [] });
    expect(requests).toHaveLength(1);
    // The bank list is paged. The exact parameters matter more than their order: the course is
    // named by its private context UUID, never by the numeric Canvas course id, and one page is
    // asked for at a time with an explicit page size.
    const bankListUrl = new URL(requests[0]!.url);
    expect(`${bankListUrl.origin}${bankListUrl.pathname}`).toBe("https://school.quiz-api.instructure.com/api/banks");
    expect([...bankListUrl.searchParams.entries()].sort()).toEqual([["course_id", "course-context-uuid"], ["page", "1"], ["per_page", "100"]]);
    expect(bankListUrl.searchParams.get("course_id")).not.toBe(COURSE_ID);
    expect(requests[0]!.options).toMatchObject({ method: "GET", credentials: "omit" });
    expect(JSON.stringify(result)).not.toContain(token);

    const routeRequests: string[] = [];
    await withGlobals({
      location: { hostname: "school.quiz-lti.instructure.com" }, document: { referrer: launchUrl },
      sessionStorage: storage({ current_user: currentUser }), localStorage: storage({}), ENV: {},
      fetch: async (url: string) => {
        const parsed = new URL(String(url));
        routeRequests.push(`${parsed.pathname}${parsed.search}`);
        if (parsed.pathname === "/api/banks") return new Response(JSON.stringify([{ id: "91", title: "Cell bank" }]), { status: 200 });
        if (parsed.pathname.endsWith("/bank_entries") || parsed.pathname.endsWith("/shared_banks")) return new Response("[]", { status: 200 });
        const id = parsed.pathname.split("/").at(-1);
        return new Response(JSON.stringify({ id, bank_id: "91", entry_id: "501" }), { status: 200 });
      },
    }, async () => {
      const cases: readonly [string, JsonObject][] = [
        ["canvas_item_bank_get_bank", { course_id: COURSE_ID, bank_id: "91" }],
        ["canvas_item_bank_list_entries", { course_id: COURSE_ID, bank_id: "91", morrow_max_pages: 1 }],
        ["canvas_item_bank_get_entry", { course_id: COURSE_ID, bank_id: "91", bank_entry_id: "701" }],
        ["canvas_item_bank_get_item", { course_id: COURSE_ID, bank_id: "91", item_id: "501" }],
        ["canvas_item_bank_list_shares", { course_id: COURSE_ID, bank_id: "91", morrow_max_pages: 1 }],
      ];
      for (const [toolName, argumentsValue] of cases) {
        const read = await executor.executeItemBankInPage({
          operation: operationFor(toolName), arguments: argumentsValue,
          principalId: "7", canvasOrigin, courseId: COURSE_ID,
          credential: {
            apiOrigin: "https://school.quiz-api.instructure.com", token, authType: "Signature",
            canvasLocalContextId: COURSE_ID, contextUuid: "course-context-uuid", launchUrl,
            launchNonce: launch.launchNonce, launchedAt: now - 1, capturedAt: now,
          },
        });
        expect(read, toolName).toMatchObject({ matched: true, ok: true, sent: true });
      }
    });
    // Path plus parameters, with the parameters sorted: which parameters are sent is the contract,
    // the order they are written in is not. Every bank-specific read walks the course bank list
    // first, so the exact bank id is always proved against the selected course before it is read.
    const routeShape = (value: string) => {
      const parsed = new URL(value, "https://school.quiz-api.instructure.com");
      const parameters = [...parsed.searchParams.entries()].sort().map(([key, entry]) => `${key}=${entry}`).join("&");
      return parameters ? `${parsed.pathname}?${parameters}` : parsed.pathname;
    };
    const bankList = "/api/banks?course_id=course-context-uuid&page=1&per_page=100";
    expect(routeRequests.map(routeShape)).toEqual([
      bankList, "/api/banks/91",
      bankList, "/api/banks/91/bank_entries?page=1&per_page=100",
      bankList, "/api/banks/91/bank_entries/701",
      bankList, "/api/banks/91/items/501",
      bankList, "/api/banks/91/shared_banks",
    ]);

    const stable = (value: unknown): string => Array.isArray(value)
      ? `[${value.map(stable).join(",")}]`
      : isJsonObject(value)
        ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
        : JSON.stringify(value === undefined ? null : value);
    const browserDigest = async (value: unknown): Promise<string> => Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value))),
    ).toString("hex");
    const itemBankCredential = () => {
      const capturedAt = Date.now();
      return {
        apiOrigin: "https://school.quiz-api.instructure.com", token, authType: "Signature",
        contextUuid: "course-context-uuid", canvasLocalContextId: COURSE_ID, launchUrl,
        launchNonce: launch.launchNonce, launchedAt: capturedAt - 1_000, capturedAt,
      };
    };
    const bankInput = (name: string, argumentsValue: JsonObject): JsonObject => ({
      operation: operationFor(name), arguments: argumentsValue, principalId: "7",
      canvasOrigin, courseId: COURSE_ID, credential: itemBankCredential(),
    }) as unknown as JsonObject;
    const pageContext = (fetchValue: typeof fetch): Record<string, unknown> => ({
      location: { hostname: "school.quiz-lti.instructure.com" }, document: { referrer: launchUrl },
      sessionStorage: storage({ current_user: currentUser }), localStorage: storage({}), ENV: {}, fetch: fetchValue,
    });
    const bankProvider = () => {
      const state = {
        banks: [{ id: "91", title: "Bank A", language: "en" }] as JsonObject[],
        items: new Map<string, JsonObject>([["501", { id: "501", entry_type: "Item", entry: { title: "Question A", item_body: "<p>A</p>" } }]]),
        entries: new Map<string, JsonObject>([["401", { id: "401", bank_id: "91", entry_type: "Item", entry_id: "500" }]]),
        shares: [] as JsonObject[], nextBank: 92, nextItem: 502, nextEntry: 402,
      };
      const requests: { method: string; path: string; body?: JsonObject; options: JsonObject }[] = [];
      const json = (data: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(data), {
        status, headers: { "content-type": "application/json" },
      });
      const providerFetch = async (url: string | URL | Request, options: JsonObject = {}) => {
        const parsed = new URL(String(url));
        const method = String(options.method ?? "GET");
        const path = parsed.pathname;
        const body = typeof options.body === "string" ? JSON.parse(options.body) as JsonObject : undefined;
        requests.push({ method, path, ...(body ? { body } : {}), options });
        const listPage = (rows: JsonObject[]) => parsed.searchParams.get("page") && parsed.searchParams.get("page") !== "1" ? [] : rows;
        if (path === "/api/banks" && method === "GET") return json(listPage(state.banks));
        if (path === "/api/banks" && method === "POST") {
          const bank = { id: String(state.nextBank++), ...(body!.bank as JsonObject) };
          state.banks.push(bank);
          return json(bank, 201);
        }
        const bankMatch = path.match(/^\/api\/banks\/(\d+)$/);
        if (bankMatch) {
          const index = state.banks.findIndex((bank) => bank.id === bankMatch[1]);
          if (method === "GET") return index < 0 ? json({ error: "missing" }, 404) : json(state.banks[index]);
          if (method === "PATCH") {
            state.banks[index] = { ...state.banks[index], ...(body!.bank as JsonObject) };
            return json(state.banks[index]);
          }
          if (method === "DELETE") {
            state.banks.splice(index, 1);
            return json(null, 204);
          }
        }
        const itemMatch = path.match(/^\/api\/banks\/(\d+)\/items\/(\d+)$/);
        if (itemMatch) {
          if (method === "GET") return state.items.has(itemMatch[2]!) ? json(state.items.get(itemMatch[2]!)) : json({ error: "missing" }, 404);
          if (method === "PATCH") {
            state.items.set(itemMatch[2]!, structuredClone(body!.item as JsonObject));
            return json(state.items.get(itemMatch[2]!));
          }
        }
        if (/^\/api\/banks\/\d+\/items$/.test(path) && method === "POST") {
          const item = { id: String(state.nextItem++), ...structuredClone(body!.item as JsonObject) };
          state.items.set(String(item.id), item);
          return json(item, 201);
        }
        const entryMatch = path.match(/^\/api\/banks\/(\d+)\/bank_entries\/(\d+)$/);
        if (entryMatch) {
          if (method === "GET") return state.entries.has(entryMatch[2]!) ? json(state.entries.get(entryMatch[2]!)) : json({ error: "missing" }, 404);
          if (method === "DELETE") {
            state.entries.delete(entryMatch[2]!);
            return json(null, 204);
          }
        }
        if (/^\/api\/banks\/\d+\/bank_entries$/.test(path)) {
          if (method === "GET") return json(listPage([...state.entries.values()]));
          if (method === "POST") {
            const entry = { id: String(state.nextEntry++), ...(body!.bank_entry as JsonObject) };
            state.entries.set(String(entry.id), entry);
            return json(entry, 201);
          }
        }
        if (/^\/api\/banks\/\d+\/shared_banks$/.test(path)) {
          if (method === "GET") return json(listPage(state.shares));
          if (method === "POST") {
            const share = { id: String(state.shares.length + 1), ...(body!.shared_bank as JsonObject) };
            state.shares.push(share);
            return json(share, 201);
          }
        }
        throw new Error(`unhandled ${method} ${path}`);
      };
      return { state, requests, fetch: providerFetch };
    };
    const bankSnapshots = async (state: ReturnType<typeof bankProvider>["state"]) => ({
      banks_sha256: await browserDigest(state.banks),
      bank_sha256: await browserDigest(state.banks.find((bank) => bank.id === "91")),
      item_sha256: await browserDigest(state.items.get("501")),
      entries_sha256: await browserDigest([...state.entries.values()]),
      entry_sha256: await browserDigest(state.entries.get("401")),
      shares_sha256: await browserDigest(state.shares),
    });
    const bankWriteCases = [
      {
        name: "canvas_item_bank_create_bank",
        args: (snapshots: JsonObject) => ({
          course_id: COURSE_ID,
          title: "Bank B",
          language: "fr",
          expected_snapshot: { banks_sha256: snapshots.banks_sha256 },
        }),
      },
      { name: "canvas_item_bank_rename_bank", args: (s: JsonObject) => ({ course_id: COURSE_ID, bank_id: "91", title: "Renamed", expected_snapshot: { bank_sha256: s.bank_sha256 } }) },
      { name: "canvas_item_bank_archive_bank", args: (s: JsonObject) => ({ course_id: COURSE_ID, bank_id: "91", expected_snapshot: { bank_sha256: s.bank_sha256, entries_sha256: s.entries_sha256, shares_sha256: s.shares_sha256 } }) },
      { name: "canvas_item_bank_create_item", args: (s: JsonObject) => ({
        course_id: COURSE_ID, bank_id: "91",
        item: {
          entry_type: "Item", points_possible: 1,
          entry: {
            title: "Question B", item_body: "<p>B</p>", interaction_type_slug: "choice",
            interaction_data: { choices: [{ id: "a", item_body: "A" }, { id: "b", item_body: "B" }] },
            scoring_data: { value: "a" }, scoring_algorithm: "Equivalence",
          },
        },
        expected_snapshot: { bank_sha256: s.bank_sha256 },
      }) },
      { name: "canvas_item_bank_update_item", args: (s: JsonObject) => ({
        course_id: COURSE_ID, bank_id: "91", item_id: "501",
        item: {
          id: "501", entry_type: "Item", points_possible: 1,
          entry: {
            title: "Question A2", item_body: "<p>A2</p>", interaction_type_slug: "choice",
            interaction_data: { choices: [{ id: "a", item_body: "A" }, { id: "b", item_body: "B" }] },
            scoring_data: { value: "a" }, scoring_algorithm: "Equivalence",
          },
        },
        expected_snapshot: { bank_sha256: s.bank_sha256, item_sha256: s.item_sha256 },
      }) },
      { name: "canvas_item_bank_attach_item", args: (s: JsonObject) => ({ course_id: COURSE_ID, bank_id: "91", item_id: "501", expected_snapshot: { bank_sha256: s.bank_sha256, item_sha256: s.item_sha256, entries_sha256: s.entries_sha256 } }) },
      { name: "canvas_item_bank_delete_entry", args: (s: JsonObject) => ({ course_id: COURSE_ID, bank_id: "91", bank_entry_id: "401", expected_snapshot: { bank_sha256: s.bank_sha256, entry_sha256: s.entry_sha256, entries_sha256: s.entries_sha256 } }) },
      {
        name: "canvas_item_bank_share_bank",
        args: (snapshots: JsonObject) => ({
          course_id: COURSE_ID,
          bank_id: "91",
          entity_type: "course",
          entity_id: COURSE_ID,
          permission: "read",
          expected_snapshot: { bank_sha256: snapshots.bank_sha256, shares_sha256: snapshots.shares_sha256 },
        }),
      },
    ] as const;
    for (const writeCase of bankWriteCases) {
      const provider = bankProvider();
      const snapshots = await bankSnapshots(provider.state) as unknown as JsonObject;
      const argumentsValue: JsonObject = {
        ...writeCase.args(snapshots),
        ...(writeCase.name === "canvas_item_bank_create_bank" ? {} : {
          fan_out: {
            schema: "morrow.canvas.item-bank.fan-out.v1", bank_id: "91", course_id: COURSE_ID,
            complete: false, unreachable: ["quiz_uses"], consumers: [], consumer_count: 0,
            consumers_sha256: await browserDigest([]), external_course_ids: [], established_at: new Date().toISOString(),
          },
          fan_out_receipt: "fixture-process-local-receipt",
          acknowledged_course_ids: [],
        }),
      };
      const input = bankInput(writeCase.name, argumentsValue);
      if (["canvas_item_bank_create_item", "canvas_item_bank_update_item"].includes(writeCase.name)) {
        input.payloadContractSha256 = await browserDigest(argumentsValue.item);
      }
      const result = await withGlobals(pageContext(provider.fetch as typeof fetch), async () => (
        await executor.executeItemBankInPage(input)
      ));
      expect(result, `${writeCase.name}: ${JSON.stringify(result)}`).toMatchObject({
        matched: true, ok: true, sent: true, outcomeUnknown: false,
        verification: { schema: "morrow.browser-verification.v1", status: "verified" },
      });
      expect(provider.requests.filter((request) => request.method !== "GET"), writeCase.name).toHaveLength(1);
    }

    const builderToken = `Signature ${"builder-credential-".repeat(8)}`;
    const builderReferrer = `${canvasOrigin}/courses/${COURSE_ID}/assignments/188?display=borderless`;
    const builderInput = (name: string, argumentsValue: JsonObject, extra: JsonObject = {}): JsonObject => ({
      operation: operationFor(name), arguments: argumentsValue, canvasOrigin, courseId: COURSE_ID,
      assignmentId: "188", ...extra,
    }) as unknown as JsonObject;
    const builderProvider = () => {
      const entries: JsonObject[] = [{ id: "10", entry_type: "Item", entry_id: "501", position: 1, points_possible: 1, properties: {} }];
      const requests: { method: string; path: string; body?: JsonObject }[] = [];
      const builderFetch = async (url: string | URL | Request, options: JsonObject = {}) => {
        const parsed = new URL(String(url));
        const method = String(options.method ?? "GET");
        const body = typeof options.body === "string" ? JSON.parse(options.body) as JsonObject : undefined;
        requests.push({ method, path: parsed.pathname, ...(body ? { body } : {}) });
        if (parsed.pathname === "/api/quizzes/77" && method === "GET") return new Response(JSON.stringify({ id: "77", title: "Quiz" }));
        if (parsed.pathname === "/api/quizzes/77/quiz_entries" && method === "GET") {
          const page = Number(parsed.searchParams.get("page"));
          return new Response(JSON.stringify({ quiz_entries: page === 1 ? entries : [] }));
        }
        if (parsed.pathname === "/api/quizzes/77/quiz_entries" && method === "POST") {
          const row = { id: "11", ...(body!.quiz_entry as JsonObject) };
          entries.push(row);
          return new Response(JSON.stringify({ quiz_entry: row }), { status: 201 });
        }
        return new Response(JSON.stringify({ error: "missing" }), { status: 404 });
      };
      return { entries, requests, fetch: builderFetch };
    };
    const builderGlobals = (fetchValue: typeof fetch, includeCredential = true): Record<string, unknown> => ({
      location: { hostname: "school.quiz-lti.instructure.com" }, document: { referrer: builderReferrer },
      localStorage: storage({ backend_url: "https://school.quiz-lti.instructure.com", ...(includeCredential ? { "quiz.build_token": builderToken } : {}) }),
      sessionStorage: storage({}), performance: { getEntriesByType: () => [{ name: "https://school.quiz-api.instructure.com/api/quizzes/77" }] },
      fetch: fetchValue,
    });
    const builder = builderProvider();
    const drawRead = await withGlobals(builderGlobals(builder.fetch as typeof fetch), async () => (
      await drawExecutor.executeQuizBankDrawInPage(builderInput("canvas_item_bank_list_quiz_draws", { course_id: COURSE_ID, assignment_id: "188" }))
    ));
    expect(drawRead).toMatchObject({ ok: true, sent: true, outcomeUnknown: false, quizId: "77", data: builder.entries, paginationComplete: true, pagesRead: 2 });
    expect(drawRead.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(drawRead)).not.toContain(builderToken);
    const beforeDraw = builder.requests.length;
    const drawWrite = await withGlobals(builderGlobals(builder.fetch as typeof fetch), async () => (
      await drawExecutor.executeQuizBankDrawInPage(builderInput("canvas_item_bank_attach_bank_to_quiz", {
        course_id: COURSE_ID, assignment_id: "188", bank_id: "91", pick_count: 5, points_per_item: 2, position: 2,
        expected_snapshot: { bank_sha256: "a".repeat(64), quiz_entries_sha256: drawRead.snapshotSha256 },
        fan_out: {
          schema: "morrow.canvas.item-bank.fan-out.v1", bank_id: "91", course_id: COURSE_ID,
          complete: false, unreachable: ["quiz_uses"], consumers: [], consumer_count: 0,
          consumers_sha256: await browserDigest([]), external_course_ids: [], established_at: new Date().toISOString(),
        },
        fan_out_receipt: "fixture-process-local-receipt",
        acknowledged_course_ids: [],
      }, { verifiedBankSha256: "a".repeat(64) }))
    ));
    expect(drawWrite).toMatchObject({ matched: true, ok: true, sent: true, outcomeUnknown: false, verification: { status: "verified" } });
    const builderPosts = builder.requests.filter((request) => request.method === "POST");
    expect(builderPosts).toHaveLength(1);
    expect(builder.requests.length).toBeGreaterThan(beforeDraw);
    expect(JSON.stringify(drawWrite)).not.toContain(builderToken);

    const noBuilderCredential = builderProvider();
    const missingBuilderCredential = await withGlobals(builderGlobals(noBuilderCredential.fetch as typeof fetch, false), async () => (
      await drawExecutor.executeQuizBankDrawInPage(builderInput("canvas_item_bank_list_quiz_draws", { course_id: COURSE_ID, assignment_id: "188" }))
    ));
    expect(missingBuilderCredential).toEqual({ matched: true, ok: false, sent: false, error: "quiz_bank_builder_credential_unavailable" });
    expect(noBuilderCredential.requests).toEqual([]);

    let wrongContextFetches = 0;
    const wrongContext = await withGlobals({
      location: { hostname: "school.quiz-lti.instructure.com" }, document: { referrer: launchUrl },
      sessionStorage: storage({ current_user: currentUser }), localStorage: storage({}), ENV: {},
      fetch: async () => { wrongContextFetches += 1; return new Response("[]"); },
    }, async () => await executor.executeItemBankInPage({
      operation: operationFor("canvas_item_bank_list_banks"), arguments: { course_id: COURSE_ID },
      principalId: "7", canvasOrigin, courseId: COURSE_ID,
      credential: {
        apiOrigin: "https://school.quiz-api.instructure.com", token, authType: "Signature",
        canvasLocalContextId: "43", contextUuid: "course-context-uuid", launchUrl,
        launchNonce: launch.launchNonce, launchedAt: now - 1, capturedAt: now,
      },
    }));
    expect(wrongContext).toMatchObject({ matched: true, ok: false, sent: false, error: "item_bank_credential_unavailable" });
    expect(wrongContextFetches).toBe(0);

    let staleFetches = 0;
    const stale = await withGlobals({
      location: { hostname: "school.quiz-lti.instructure.com" }, document: { referrer: launchUrl },
      sessionStorage: storage({ current_user: currentUser }), localStorage: storage({}), ENV: {},
      fetch: async () => { staleFetches += 1; return new Response("[]"); },
    }, async () => await executor.executeItemBankInPage({
      operation: operationFor("canvas_item_bank_list_banks"), arguments: { course_id: COURSE_ID },
      principalId: "7", canvasOrigin, courseId: COURSE_ID,
      credential: {
        apiOrigin: "https://school.quiz-api.instructure.com", token, authType: "Signature",
        canvasLocalContextId: COURSE_ID, contextUuid: "course-context-uuid", launchUrl,
        launchNonce: launch.launchNonce,
        launchedAt: now - credentialContract.ITEM_BANK_CREDENTIAL_MAX_AGE_MS - 2,
        capturedAt: now - credentialContract.ITEM_BANK_CREDENTIAL_MAX_AGE_MS - 1,
      },
    }));
    expect(stale).toMatchObject({ matched: true, ok: false, sent: false, error: "item_bank_credential_unavailable" });
    expect(staleFetches).toBe(0);

    const exerciseWorker = async (updateFails: boolean) => {
      const credentials = new Map<string, JsonObject>();
      const launches = new Map<number, JsonObject>();
      const records = { gets: [] as number[], creates: [] as JsonObject[], updates: [] as JsonObject[], removes: [] as number[], scripts: [] as JsonObject[] };
      const tempTabId = updateFails ? 100 : 99;
      const chrome = {
        tabs: {
          get: async (tabId: number) => {
            records.gets.push(tabId);
            return { id: tabId, windowId: 3, url: `${canvasOrigin}/courses/${COURSE_ID}/quizzes` };
          },
          create: async (options: JsonObject) => {
            records.creates.push(structuredClone(options));
            return { id: tempTabId };
          },
          update: async (tabId: number, options: JsonObject) => {
            records.updates.push({ tabId, ...structuredClone(options) });
            if (updateFails) throw new Error("fixture launch refused");
            const pending = launches.get(tabId)!;
            credentials.set(`${tabId}:7`, {
              tabId, frameId: 7, apiOrigin: "https://school.quiz-api.instructure.com",
              token, authType: "Signature", canvasLocalContextId: COURSE_ID,
              contextUuid: "course-context-uuid", launchUrl: pending.launchUrl,
              launchNonce: pending.launchNonce, launchedAt: pending.launchedAt, capturedAt: Date.now(),
            });
            return { id: tabId, url: options.url };
          },
          remove: async (tabId: number) => { records.removes.push(tabId); },
        },
        webNavigation: {
          getAllFrames: async ({ tabId }: { tabId: number }) => [
            { tabId, frameId: 0, url: launchUrl },
            { tabId, frameId: 7, url: "https://school.quiz-lti.instructure.com/lti/launch" },
          ],
        },
        permissions: { contains: async () => true },
        scripting: {
          executeScript: async (injection: JsonObject) => {
            records.scripts.push(injection);
            const input = (injection.args as JsonObject[])[0]!;
            return [{ result: input.contextOnly === true
              ? { matched: true, ok: true, sent: false }
              : { matched: true, ok: true, sent: true, data: [] } }];
          },
        },
      };
      const lifecycle = itemBankWorkerLifecycle({ chrome, credential: credentialContract, executor, frames: frameContract, credentials, launches });
      const result = await lifecycle.executeItemBank({
        tabId: 5, windowId: 3, origin: canvasOrigin, courseId: COURSE_ID, principalId: "7",
      }, operationFor("canvas_item_bank_list_banks") as unknown as JsonObject, { course_id: COURSE_ID });
      return { result, records, credentials, launches, tempTabId };
    };

    const workerSuccess = await exerciseWorker(false);
    expect(workerSuccess.result).toMatchObject({ matched: true, ok: true, sent: true, data: [] });
    expect(workerSuccess.records.gets).toEqual([5]);
    expect(workerSuccess.records.creates).toEqual([{ active: false, windowId: 3 }]);
    expect(workerSuccess.records.updates).toEqual([{ tabId: 99, url: launchUrl }]);
    expect(workerSuccess.records.removes).toEqual([99]);
    expect(workerSuccess.records.scripts).toHaveLength(2);
    expect(workerSuccess.credentials.size).toBe(0);
    expect(workerSuccess.launches.size).toBe(0);

    const workerFailure = await exerciseWorker(true);
    expect(workerFailure.result).toEqual({ ok: false, sent: false, error: "item_bank_launch_failed" });
    expect(workerFailure.records.gets).toEqual([5]);
    expect(workerFailure.records.creates).toEqual([{ active: false, windowId: 3 }]);
    expect(workerFailure.records.updates).toEqual([{ tabId: 100, url: launchUrl }]);
    expect(workerFailure.records.removes).toEqual([100]);
    expect(workerFailure.records.scripts).toEqual([]);
    expect(workerFailure.credentials.size).toBe(0);
    expect(workerFailure.launches.size).toBe(0);
  });

  it("covers every final catalog operation and every curated MCP workflow", async () => {
    const fixtures = await import(
      new URL("../../../scripts/test/lib/quiz-bank-e2e-fixtures.mjs", import.meta.url).href
    ) as QuestionFixtures;
    const guard = await import(
      new URL("../../../connector/extension/src/item-bank-guard.js", import.meta.url).href
    ) as ItemBankGuard;
    const itemBankExecutor = await import(
      new URL("../../../connector/extension/src/item-bank-executor.js", import.meta.url).href
    ) as ItemBankExecutor;
    const quizBankDrawExecutor = await import(
      new URL("../../../connector/extension/src/quiz-bank-draw-executor.js", import.meta.url).href
    ) as QuizBankDrawExecutor;
    const itemBankRecovery = itemBankRecoveryPlanner();
    const questionPayloads = fixtures.quizBankE2eQuestionPayloads();
    const browserCatalogDigest = bridgeCatalogDigestForTests(ROOT);
    const directory = mkdtempSync(join(tmpdir(), "morrow-quiz-bank-e2e-"));
    const port = await reserveLoopbackPort();
    const config = connectorConfig(directory, port);
    const quizzes = new Map<string, JsonObject>([
      ["77", { id: "77", course_id: COURSE_ID, title: "Cell structure", points_possible: 20, quiz_settings: { shuffle_answers: false } }],
      ["78", { id: "78", course_id: COURSE_ID, title: "All question types", points_possible: 11, quiz_settings: { shuffle_answers: false } }],
      ["79", { id: "79", course_id: COURSE_ID, title: "Disposable quiz", points_possible: 1, quiz_settings: { shuffle_answers: false } }],
      ["80", { id: "80", course_id: COURSE_ID, title: "Replacement positions", points_possible: 3, quiz_settings: { shuffle_answers: false } }],
      ["81", { id: "81", course_id: COURSE_ID, title: "Delete guard target", points_possible: 1, quiz_settings: { shuffle_answers: false } }],
      ["9007199254740992", { id: "9007199254740992", course_id: COURSE_ID, title: "Large id lower" }],
      ["9007199254740993", { id: "9007199254740993", course_id: COURSE_ID, title: "Large id higher" }],
    ]);
    const quizAssignments = new Map<string, JsonObject>([...quizzes].map(([id, quiz]) => [id, {
      id, course_id: COURSE_ID, name: quiz.title, has_submitted_submissions: false, graded_submissions_exist: false,
    }]));
    /**
     * The linked Canvas Assignment of a New Quiz, in one shape for every reader. The MCP planner
     * freezes a digest of this record and the in-page guard reads it again immediately before
     * dispatch, so the two must see exactly the same bytes.
     */
    const assignmentRecord = (id: string): JsonObject | null => {
      const saved = quizAssignments.get(id);
      return saved ? { assignment_group_id: "5", position: 1, ...saved, is_quiz_lti_assignment: true } : null;
    };
    const quizItems = new Map<string, JsonObject[]>();
    const auditItems = Object.values(questionPayloads)
      .filter((payload) => (payload.entry as JsonObject).interaction_type_slug !== "hot-spot")
      .map((payload, index) => ({ ...structuredClone(payload), id: String(200 + index), status: "mutable", position: index + 1 }));
    quizItems.set("78", auditItems);
    quizItems.set("79", []);
    quizItems.set("77", [
      { ...structuredClone(questionPayloads.choice), id: "11", status: "mutable", position: 1 },
      { ...structuredClone(questionPayloads.essay), id: "12", status: "mutable", position: 2 },
      { id: "13", position: 3, entry_type: "BankEntry", bank_id: "91", entry_id: "501" },
      {
        id: "14", status: "mutable", position: 4, entry_type: "Item", points_possible: 2,
        entry: {
          title: "Four image repair targets",
          item_body: '<p>Question image.</p><img src="/courses/42/files/12">',
          interaction_type_slug: "choice",
          interaction_data: { choices: [
            { id: "11111111-1111-4111-8111-111111111111", position: 1, item_body: '<p>Choice image.</p><img src="/courses/42/files/13" alt="fixture">' },
            { id: "22222222-2222-4222-8222-222222222222", position: 2, item_body: "No image" },
          ] },
          answer_feedback: { "11111111-1111-4111-8111-111111111111": '<p>Answer feedback.</p><img src="/courses/42/files/14" alt="fixture">' },
          feedback: { correct: '<p>Correct feedback.</p><img src="/courses/42/files/15" alt="fixture">', incorrect: "Try again." },
          scoring_algorithm: "Equivalence",
          scoring_data: { value: "11111111-1111-4111-8111-111111111111" },
        },
      },
    ]);
    quizItems.set("80", [
      { ...structuredClone(questionPayloads.choice), id: "801", status: "mutable", position: 1 },
      { ...structuredClone(questionPayloads.essay), id: "802", status: "mutable", position: 2 },
      { ...structuredClone(questionPayloads.numeric), id: "803", status: "mutable", position: 3 },
    ]);
    quizItems.set("81", [{ ...structuredClone(questionPayloads.essay), id: "811", status: "mutable", position: 1 }]);
    quizItems.set("9007199254740992", []);
    quizItems.set("9007199254740993", []);
    const bankItem: JsonObject = {
      ...structuredClone(questionPayloads.choice), id: "501",
      entry: { ...(questionPayloads.choice.entry as JsonObject), item_body: '<p>Identify the cell.</p><img src="/courses/42/files/9">' },
    };
    const banks: JsonObject[] = [
      { id: "91", title: "Cell bank", language: "en" },
      { id: "93", title: "Disposable bank", language: "en" },
    ];
    const bankItems = new Map<string, JsonObject>([
      ["501", bankItem],
      ["503", { ...structuredClone(questionPayloads.essay), id: "503" }],
    ]);
    const bankEntries: JsonObject[] = [
      { id: "701", bank_id: "91", entry_type: "Item", entry_id: "501" },
      { id: "704", bank_id: "91", entry_type: "Item", entry_id: "504" },
    ];
    const bankShares: JsonObject[] = [{ id: "share-77", bank_id: "91", entity_type: "course", entity_id: "77", permission: "read" }];
    const quizBankDraws: JsonObject[] = [];
    const courseModules: JsonObject[] = [{ id: "7", name: "Week one" }, { id: "9", name: "Week two" }];
    const courseModuleItems: JsonObject[] = [{ id: "554", module_id: "7", position: 1, type: "Page", page_url: "cells" }];
    let nextModuleItemId = 560;
    let nextQuizId = 90;
    let nextItemId = 300;
    let nextBankId = 100;
    let nextBankItemId = 600;
    let nextBankEntryId = 800;
    let nextQuizBankDrawId = 900;
    let nextUnknownTool = "";
    let loseNextCanvasResponseTool = "";
    const bridgeCommands: BridgeCommand[] = [];
    const writeCommands: BridgeCommand[] = [];
    const provedCatalog = new Map<string, string>();
    const provedCurated = new Set<string>();
    const provedQuestionTypes = new Map<string, string>();
    let morrow: MorrowRuntime | undefined;
    let bridge: BridgeTestClient | undefined;
    let client: Client | undefined;
    let server: ReturnType<typeof serveStdio> | undefined;
    let browserExecutionFailure: Error | undefined;

    const binding = {
      sourceBindingId: SOURCE_BINDING_ID,
      provider: "canvas" as const,
      origin: "https://school.instructure.com",
      courseId: COURSE_ID,
      courseName: "Biology",
      principalFingerprint: "c".repeat(64),
      sessionGeneration: 1,
      catalogDigest: browserCatalogDigest,
      editPolicyRevision: 0,
      editOptionsAvailable: true,
      runtimeVerified: true,
    };

    function readData(command: BridgeCommand): unknown {
      const args = command.arguments ?? {};
      switch (command.toolName) {
        case "canvas_get_single_course_courses": return { id: exactId(args.id), name: "Biology" };
        case "canvas_list_users_in_course_users": return [{
          id: "17", name: "Ada Learner", sortable_name: "Learner, Ada", email: "ada@example.invalid",
          enrollments: [{ type: "StudentEnrollment", course_id: Number(COURSE_ID), enrollment_state: "active" }],
        }];
        case "canvas_list_enrollments_courses": return [];
        case "canvas_list_new_quizzes": return [...quizzes.values()];
        case "canvas_get_new_quiz": return quizzes.get(exactId(args.assignment_id)) ?? null;
        case "canvas_list_quiz_items": return [...(quizItems.get(exactId(args.assignment_id)) ?? [])].sort((left, right) => Number(left.position) - Number(right.position));
        case "canvas_get_quiz_item": return (quizItems.get(exactId(args.assignment_id)) ?? []).find((item) => exactId(item.id) === exactId(args.item_id)) ?? null;
        case "canvas_get_items_media_upload_url": return { url: "https://uploads.example.invalid/quiz-media" };
        case "canvas_item_bank_list_banks": return banks;
        case "canvas_item_bank_get_bank": return banks.find((bank) => exactId(bank.id) === exactId(args.bank_id)) ?? null;
        case "canvas_item_bank_list_entries": return bankEntries.filter((entry) => exactId(entry.bank_id) === exactId(args.bank_id));
        case "canvas_item_bank_get_entry": return bankEntries.find((entry) => exactId(entry.id) === exactId(args.bank_entry_id)) ?? null;
        case "canvas_item_bank_get_item": return bankItems.get(exactId(args.item_id)) ?? null;
        case "canvas_item_bank_list_shares": return bankShares.filter((share) => exactId(share.bank_id) === exactId(args.bank_id));
        case "canvas_item_bank_list_quiz_draws": return quizBankDraws;
        // A New Quiz's linked Assignment. Canvas marks it with is_quiz_lti_assignment.
        case "canvas_get_single_assignment": return assignmentRecord(exactId(args.id));
        case "canvas_list_assignments_assignment_groups": return [...quizAssignments.keys()]
          .map((id, index) => ({ position: index + 1, ...assignmentRecord(id) }));
        case "canvas_show_module": return courseModules.find((module) => exactId(module.id) === exactId(args.id)) ?? null;
        case "canvas_list_module_items": return courseModuleItems
          .filter((item) => exactId(item.module_id) === exactId(args.module_id))
          .sort((left, right) => Number(left.position) - Number(right.position));
        case "canvas_show_module_item": return courseModuleItems.find((item) => exactId(item.id) === exactId(args.id)) ?? null;
        default: throw new Error(`unexpected read ${command.toolName}`);
      }
    }

    const canvasContentSource = readFileSync(resolve(ROOT, "connector/extension/src/canvas-content.js"), "utf8");

    const itemBankToken = `Signature ${"integrated-item-bank-credential-".repeat(4)}`;
    const itemBankLaunchUrl = `${binding.origin}/courses/${COURSE_ID}/external_tools/54065`;
    const quizBuilderReferrer = `${binding.origin}/courses/${COURSE_ID}/assignments/77`;
    const itemBankRequests: { tool: string; method: string; path: string }[] = [];
    let loseNextItemBankResponseTool = "";

    async function executeRealItemBankCommand(command: BridgeCommand): Promise<{ result: JsonObject; writes: number }> {
      const operation = operationFor(command.toolName);
      const args = command.arguments ?? {};
      let writes = 0;
      const json = (value: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(value), {
        status, headers: status === 204 ? {} : { "content-type": "application/json" },
      });
      const afterMutation = (value: unknown, status = 200): Response => {
        if (loseNextItemBankResponseTool === command.toolName) {
          loseNextItemBankResponseTool = "";
          throw new TypeError("provider response lost after Item Bank write");
        }
        return json(value, status);
      };
      const fetchValue = async (input: string | URL | Request, options: RequestInit = {}) => {
        const url = new URL(String((input as { href?: string }).href ?? input));
        const method = String(options.method ?? "GET");
        const body = typeof options.body === "string" && options.body ? JSON.parse(options.body) as JsonObject : {};
        itemBankRequests.push({ tool: command.toolName, method, path: `${url.pathname}${url.search}` });
        const listPage = (rows: JsonObject[]) => url.searchParams.get("page") && url.searchParams.get("page") !== "1" ? [] : rows;
        if (url.pathname === "/api/banks" && method === "GET") return json(listPage(banks));
        if (url.pathname === "/api/banks" && method === "POST") {
          writes += 1;
          const saved = { id: String(nextBankId++), ...(isJsonObject(body.bank) ? structuredClone(body.bank) : {}) };
          banks.push(saved);
          return afterMutation({ bank: saved }, 201);
        }
        const bankMatch = url.pathname.match(/^\/api\/banks\/([1-9][0-9]{0,18})$/);
        if (bankMatch) {
          const bankId = bankMatch[1]!;
          const index = banks.findIndex((bank) => exactId(bank.id) === bankId);
          if (method === "GET") return index >= 0 ? json(banks[index]) : json({ error: "missing" }, 404);
          if (method === "PATCH") {
            writes += 1;
            if (index < 0) return json({ error: "missing" }, 404);
            banks[index] = { ...banks[index], ...(isJsonObject(body.bank) ? structuredClone(body.bank) : {}) };
            return afterMutation({ bank: banks[index] });
          }
          if (method === "DELETE") {
            writes += 1;
            if (index < 0) return json({ error: "missing" }, 404);
            banks.splice(index, 1);
            return afterMutation(null, 204);
          }
        }
        const itemMatch = url.pathname.match(/^\/api\/banks\/([1-9][0-9]{0,18})\/items\/([1-9][0-9]{0,18})$/);
        if (itemMatch) {
          const itemId = itemMatch[2]!;
          if (method === "GET") return bankItems.has(itemId) ? json(bankItems.get(itemId)) : json({ error: "missing" }, 404);
          if (method === "PATCH") {
            writes += 1;
            if (!bankItems.has(itemId)) return json({ error: "missing" }, 404);
            const saved = isJsonObject(body.item) ? { ...structuredClone(body.item), id: itemId } : { id: itemId };
            bankItems.set(itemId, saved);
            return afterMutation({ item: saved });
          }
        }
        const itemListMatch = url.pathname.match(/^\/api\/banks\/([1-9][0-9]{0,18})\/items$/);
        if (itemListMatch && method === "POST") {
          writes += 1;
          const id = String(nextBankItemId++);
          const saved = { ...(isJsonObject(body.item) ? structuredClone(body.item) : {}), id };
          bankItems.set(id, saved);
          return afterMutation({ item: saved }, 201);
        }
        const entryMatch = url.pathname.match(/^\/api\/banks\/([1-9][0-9]{0,18})\/bank_entries\/([1-9][0-9]{0,18})$/);
        if (entryMatch) {
          const [bankId, entryId] = entryMatch.slice(1);
          const index = bankEntries.findIndex((entry) => exactId(entry.bank_id) === bankId && exactId(entry.id) === entryId);
          if (method === "GET") return index >= 0 ? json(bankEntries[index]) : json({ error: "missing" }, 404);
          if (method === "DELETE") {
            writes += 1;
            if (index < 0) return json({ error: "missing" }, 404);
            bankEntries.splice(index, 1);
            return afterMutation(null, 204);
          }
        }
        const entryListMatch = url.pathname.match(/^\/api\/banks\/([1-9][0-9]{0,18})\/bank_entries$/);
        if (entryListMatch) {
          const rows = bankEntries.filter((entry) => exactId(entry.bank_id) === entryListMatch[1]);
          if (method === "GET") return json(listPage(rows));
          if (method === "POST") {
            writes += 1;
            const saved = { id: String(nextBankEntryId++), ...(isJsonObject(body.bank_entry) ? structuredClone(body.bank_entry) : {}) };
            bankEntries.push(saved);
            return afterMutation({ bank_entry: saved }, 201);
          }
        }
        const sharesMatch = url.pathname.match(/^\/api\/banks\/([1-9][0-9]{0,18})\/shared_banks$/);
        if (sharesMatch) {
          const rows = bankShares.filter((share) => exactId(share.bank_id) === sharesMatch[1]);
          if (method === "GET") return json(rows);
          if (method === "POST") {
            writes += 1;
            const saved = { id: `share-${bankShares.length + 1}`, ...(isJsonObject(body.shared_bank) ? structuredClone(body.shared_bank) : {}) };
            bankShares.push(saved);
            return afterMutation({ shared_bank: saved }, 201);
          }
        }
        return json({ error: `unhandled ${method} ${url.pathname}` }, 404);
      };

      let result: JsonObject;
      if (["list_quiz_draws", "attach_bank_to_quiz", "attach_bank_entry_to_quiz", "delete_quiz_bank_entry"].includes(operation.nickname)) {
        const drawFetch = async (input: string | URL | Request, options: RequestInit = {}) => {
          const url = new URL(String((input as { href?: string }).href ?? input));
          const method = String(options.method ?? "GET");
          const body = typeof options.body === "string" && options.body ? JSON.parse(options.body) as JsonObject : {};
          itemBankRequests.push({ tool: command.toolName, method, path: `${url.pathname}${url.search}` });
          if (url.pathname === "/api/quizzes/77" && method === "GET") return json({ id: "77", title: "Cell structure" });
          if (url.pathname === "/api/quizzes/77/quiz_entries" && method === "GET") {
            return json({ quiz_entries: url.searchParams.get("page") === "1" ? quizBankDraws : [] });
          }
          if (url.pathname === "/api/quizzes/77/quiz_entries" && method === "POST") {
            writes += 1;
            const saved = { id: String(nextQuizBankDrawId++), ...(isJsonObject(body.quiz_entry) ? structuredClone(body.quiz_entry) : {}) };
            quizBankDraws.push(saved);
            return afterMutation({ quiz_entry: saved }, 201);
          }
          const drawMatch = url.pathname.match(/^\/api\/quizzes\/77\/quiz_entries\/([1-9][0-9]{0,18})$/);
          if (drawMatch && method === "DELETE") {
            writes += 1;
            const index = quizBankDraws.findIndex((row) => exactId(row.id) === drawMatch[1]);
            if (index < 0) return json({ error: "missing" }, 404);
            quizBankDraws.splice(index, 1);
            return afterMutation(null, 204);
          }
          return json({ error: `unhandled ${method} ${url.pathname}` }, 404);
        };
        const bank = banks.find((candidate) => exactId(candidate.id) === exactId(args.bank_id));
        const entry = bankEntries.find((candidate) => exactId(candidate.id) === exactId(args.bank_entry_id));
        result = await withGlobals({
          location: { hostname: "school.quiz-lti.instructure.com" }, document: { referrer: quizBuilderReferrer },
          localStorage: storage({ backend_url: "https://school.quiz-lti.instructure.com", "quiz.build_token": itemBankToken }),
          sessionStorage: storage({}), performance: { getEntriesByType: () => [{ name: "https://school.quiz-api.instructure.com/api/quizzes/77" }] },
          fetch: drawFetch,
        }, async () => await quizBankDrawExecutor.executeQuizBankDrawInPage({
          operation, arguments: args, canvasOrigin: binding.origin, courseId: COURSE_ID, assignmentId: "77",
          ...(bank ? { verifiedBankSha256: await browserDigest(bank) } : {}),
          ...(entry ? { verifiedEntrySha256: await browserDigest(entry) } : {}),
        } as unknown as JsonObject));
      } else {
        const capturedAt = Date.now();
        const input: JsonObject = {
          operation, arguments: args, principalId: "7", canvasOrigin: binding.origin, courseId: COURSE_ID,
          credential: {
            apiOrigin: "https://school.quiz-api.instructure.com", token: itemBankToken, authType: "Signature",
            canvasLocalContextId: COURSE_ID, contextUuid: "course-context-uuid", launchUrl: itemBankLaunchUrl,
            launchNonce: "11111111-1111-4111-8111-111111111111", launchedAt: capturedAt - 1_000, capturedAt,
          },
        };
        if (["create_item", "update_item"].includes(operation.nickname)) input.payloadContractSha256 = await browserDigest(args.item);
        result = await withGlobals({
          location: { hostname: "school.quiz-lti.instructure.com" }, document: { referrer: itemBankLaunchUrl },
          sessionStorage: storage({ current_user: JSON.stringify({ id: "7" }) }), localStorage: storage({}), ENV: {}, fetch: fetchValue,
        }, async () => await itemBankExecutor.executeItemBankInPage(input));
      }
      const readDescriptor = await itemBankRecovery(operation as unknown as JsonObject, args as JsonObject, result);
      return { result: { schema: "morrow.canvas-browser-result.v1", ...result, ...(readDescriptor ? { readDescriptor } : {}) }, writes };
    }

    async function executeRealCanvasCommand(command: BridgeCommand): Promise<{ result: JsonObject; writes: number }> {
      const args = command.arguments ?? {};
      const quizId = exactId(args.assignment_id);
      const quizListPath = `/api/quiz/v1/courses/${COURSE_ID}/quizzes`;
      const quizPath = `${quizListPath}/${quizId}`;
      const itemPath = `/api/quiz/v1/courses/${COURSE_ID}/quizzes/${quizId}/items`;
      const listeners: ((message: JsonObject, sender: unknown, respond: (result: JsonObject) => void) => boolean)[] = [];
      let writes = 0;
      const descriptors = new Map([
        "location", "document", "fetch", "chrome", "HTMLImageElement", "__morrowCanvasConnectorInstalled",
      ].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
      const json = (value: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(value), {
        status, headers: status === 204 ? {} : { "content-type": "application/json" },
      });
      const afterWrite = (value: unknown, status = 200): Response => {
        if (loseNextCanvasResponseTool === command.toolName) {
          loseNextCanvasResponseTool = "";
          throw new TypeError("provider response lost after write");
        }
        return json(value, status);
      };
      const normalizePositions = (items: JsonObject[]) => {
        items.forEach((item, index) => { item.position = index + 1; });
      };
      class FixtureImage {
        outerHTML: string;
        private readonly attributes = new Map<string, string>();
        constructor(tag: string) {
          this.outerHTML = tag;
          for (const match of tag.matchAll(/\s+([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
            this.attributes.set(match[1]!.toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
          }
        }
        getAttribute(name: string) { return this.attributes.get(name.toLowerCase()) ?? null; }
        hasAttribute(name: string) { return this.attributes.has(name.toLowerCase()); }
        removeAttribute(name: string) {
          this.attributes.delete(name.toLowerCase());
          this.outerHTML = this.outerHTML.replace(new RegExp(`\\s+${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, "i"), "");
        }
        closest() { return null; }
      }
      const createContent = (value: string) => {
        const images = [...String(value).matchAll(/<img\s+(?:(?:"[^"]*"|'[^']*'|[^'">])*)>/gi)].map((match) => new FixtureImage(match[0]));
        const elements = [...String(value).matchAll(/<(?!\/|!)[A-Za-z][^>]*>/g)];
        const markupWithoutImages = String(value).replace(/<img\s+(?:(?:"[^"]*"|'[^']*'|[^'">])*)>/gi, "<img>");
        const content: Record<string, unknown> = {
          firstElementChild: /^\s*<img\b/i.test(String(value)) ? images[0] ?? null : null,
          childElementCount: elements.length,
          querySelectorAll: (selector: string) => selector === "img" ? images : [],
          cloneNode: () => {
            let index = 0;
            return createContent(String(value).replace(/<img\s+(?:(?:"[^"]*"|'[^']*'|[^'">])*)>/gi, () => images[index++]?.outerHTML ?? "<img>"));
          },
          isEqualNode: (other: { querySelectorAll?: (selector: string) => FixtureImage[]; markupWithoutImages?: string }) => (
            other?.markupWithoutImages === markupWithoutImages
            && JSON.stringify(other.querySelectorAll?.("img").map((image) => image.outerHTML) ?? []) === JSON.stringify(images.map((image) => image.outerHTML))
          ),
          markupWithoutImages,
        };
        return content;
      };
      const createTemplate = () => ({
        content: createContent(""),
        set innerHTML(value: string) {
          this.content = createContent(String(value));
        },
      });
      try {
        Object.defineProperties(globalThis, {
          location: { configurable: true, value: { origin: binding.origin, protocol: "https:", pathname: `/courses/${COURSE_ID}/quizzes` } },
          document: { configurable: true, value: { cookie: "_csrf_token=quiz-bank-e2e", createElement: (name: string) => name === "template" ? createTemplate() : {} } },
          HTMLImageElement: { configurable: true, value: FixtureImage },
          chrome: { configurable: true, value: { runtime: { onMessage: { addListener: (listener: typeof listeners[number]) => listeners.push(listener) } } } },
          fetch: { configurable: true, value: async (input: string | URL | Request, options: RequestInit = {}) => {
            const url = new URL(String((input as { href?: string }).href ?? input), binding.origin);
            const method = String(options.method ?? "GET");
            const requestValue = typeof options.body === "string" && /^[\[{]/.test(options.body.trim())
              ? JSON.parse(options.body) as unknown : {};
            const requestBody = isJsonObject(requestValue) ? requestValue : {};
            if (url.pathname === "/api/v1/users/self/profile") return json({ id: "7", name: "Teacher" });
            if (url.pathname === `/api/v1/courses/${COURSE_ID}`) return json({ id: COURSE_ID, name: "Biology" });
            const assignmentMatch = url.pathname.match(new RegExp(`^/api/v1/courses/${COURSE_ID}/assignments/([1-9][0-9]{0,18})$`));
            if (method === "GET" && assignmentMatch) {
              const assignment = assignmentRecord(assignmentMatch[1]!);
              return assignment ? json(assignment) : json({ error: "missing" }, 404);
            }
            if (method === "GET" && url.pathname === quizListPath) return json([...quizzes.values()]);
            if (method === "POST" && url.pathname === quizListPath) {
              writes += 1;
              const id = String(nextQuizId++);
              const saved = { id, course_id: COURSE_ID, ...(isJsonObject(requestBody.quiz) ? structuredClone(requestBody.quiz) : {}) };
              quizzes.set(id, saved);
              quizAssignments.set(id, { id, course_id: COURSE_ID, name: saved.title, has_submitted_submissions: false, graded_submissions_exist: false });
              quizItems.set(id, []);
              return afterWrite(saved, 201);
            }
            const quizByIdMatch = url.pathname.match(new RegExp(`^${quizListPath}/([1-9][0-9]{0,18})$`));
            if (method === "GET" && quizByIdMatch) {
              // A create is verified by rereading the quiz Canvas just assigned an id to, so this
              // answers any New Quiz in the course, not only the one this launch is bound to.
              const quiz = quizzes.get(quizByIdMatch[1]!);
              return quiz ? json(quiz) : json({ error: "missing" }, 404);
            }
            if (method === "PATCH" && url.pathname === quizPath) {
              writes += 1;
              const current = quizzes.get(quizId);
              if (!current) return json({ error: "missing" }, 404);
              const saved = { ...current, ...(isJsonObject(requestBody.quiz) ? structuredClone(requestBody.quiz) : {}) };
              quizzes.set(quizId, saved);
              return afterWrite(saved);
            }
            if (method === "DELETE" && quizByIdMatch) {
              // A delete is bound to the exact quiz the plan named, which is not always the quiz
              // this launch is bound to, so any New Quiz in the course can be the target.
              const target = quizByIdMatch[1]!;
              writes += 1;
              if (!quizzes.has(target)) return json({ error: "missing" }, 404);
              quizzes.delete(target);
              quizAssignments.delete(target);
              quizItems.delete(target);
              return afterWrite(null, 204);
            }
            const courseAccommodationPath = `/api/quiz/v1/courses/${COURSE_ID}/accommodations`;
            const quizAccommodationPath = `${quizPath}/accommodations`;
            if (method === "POST" && [courseAccommodationPath, quizAccommodationPath].includes(url.pathname)) {
              writes += 1;
              const payload = Array.isArray(requestValue) && isJsonObject(requestValue[0]) ? structuredClone(requestValue[0]) : structuredClone(requestBody);
              return afterWrite({ successful: [payload], failed: [] });
            }
            if (method === "POST" && url.pathname === `${quizPath}/reports`) {
              writes += 1;
              return afterWrite({
                id: "7001", context_id: quizId, context_type: "Assignment", workflow_state: "completed",
                url: "/api/v1/progress/7001", results: { url: "/api/quiz_reports/7001.csv" },
              }, 201);
            }
            if (method === "GET" && url.pathname === `${itemPath}/media_upload_url`) {
              return json({ url: "https://uploads.example.invalid/quiz-media" });
            }
            const items = quizItems.get(quizId) ?? [];
            if (method === "GET" && url.pathname === itemPath) {
              return json([...items].sort((left, right) => Number(left.position) - Number(right.position)));
            }
            const itemMatch = url.pathname.match(new RegExp(`^${itemPath}/([1-9][0-9]{0,18})$`));
            if (method === "GET" && itemMatch) {
              const item = items.find((candidate) => exactId(candidate.id) === itemMatch[1]);
              return item ? json(item) : json({ error: "missing" }, 404);
            }
            if (method === "POST" && url.pathname === itemPath) {
              writes += 1;
              const id = String(nextItemId++);
              const payload = isJsonObject(requestBody.item) ? structuredClone(requestBody.item) : {};
              const saved = { ...payload, id, status: "mutable" };
              const requested = Number(payload.position ?? items.length + 1);
              const position = Math.max(1, Math.min(Number.isSafeInteger(requested) ? requested : items.length + 1, items.length + 1));
              items.splice(position - 1, 0, saved);
              normalizePositions(items);
              quizItems.set(quizId, items);
              return afterWrite({ id }, 201);
            }
            if (method === "DELETE" && itemMatch) {
              writes += 1;
              const index = items.findIndex((candidate) => exactId(candidate.id) === itemMatch[1]);
              if (index < 0) return json({ error: "missing" }, 404);
              items.splice(index, 1);
              normalizePositions(items);
              return afterWrite(null, 204);
            }
            if (method === "PATCH" && itemMatch) {
              writes += 1;
              const index = items.findIndex((candidate) => exactId(candidate.id) === itemMatch[1]);
              if (index < 0) return json({ error: "missing" }, 404);
              const patch = isJsonObject(requestBody.item) ? structuredClone(requestBody.item) : {};
              if (patch.position !== undefined) {
                const [moved] = items.splice(index, 1);
                items.splice(Math.max(0, Math.min(Number(patch.position) - 1, items.length)), 0, moved!);
                normalizePositions(items);
                if (Object.keys(patch).length === 1) return afterWrite(moved);
              }
              const currentIndex = items.findIndex((candidate) => exactId(candidate.id) === itemMatch[1]);
              const current = items[currentIndex]!;
              const currentEntry = isJsonObject(current.entry) ? current.entry : {};
              const patchEntry = isJsonObject(patch.entry) ? patch.entry : {};
              const saved = {
                ...current,
                ...patch,
                ...(isJsonObject(patch.entry) ? { entry: {
                  ...currentEntry, ...patchEntry,
                  ...(isJsonObject(patchEntry.feedback) ? { feedback: { ...(isJsonObject(currentEntry.feedback) ? currentEntry.feedback : {}), ...patchEntry.feedback } } : {}),
                  ...(isJsonObject(patchEntry.answer_feedback) ? { answer_feedback: { ...(isJsonObject(currentEntry.answer_feedback) ? currentEntry.answer_feedback : {}), ...patchEntry.answer_feedback } } : {}),
                  ...(isJsonObject(patchEntry.interaction_data) ? { interaction_data: { ...(isJsonObject(currentEntry.interaction_data) ? currentEntry.interaction_data : {}), ...patchEntry.interaction_data } } : {}),
                } } : {}),
              };
              items[currentIndex] = saved;
              return afterWrite(saved);
            }
            return json({ error: `unhandled ${method} ${url.pathname}` }, 404);
          } },
          __morrowCanvasConnectorInstalled: { configurable: true, writable: true, value: undefined },
        });
        runInThisContext(canvasContentSource, { filename: "canvas-content.js" });
        expect(listeners).toHaveLength(1);
        const operation = operationFor(command.toolName);
        const result = await new Promise<JsonObject>((resolveResult, reject) => {
          const handled = listeners[0]!({
            type: "morrow_canvas_execute",
            operation: { ...operation, morrowCourseTarget: canvasOperationAdmission(operation).courseTarget },
            arguments: args as JsonObject,
            principalId: "7",
            expiresAt: Date.now() + 60_000,
            courseId: COURSE_ID,
          }, null, resolveResult);
          if (handled !== true) reject(new Error("Canvas content script did not accept the lifecycle command"));
        });
        return { result: { schema: "morrow.canvas-browser-result.v1", ...result }, writes };
      } finally {
        for (const [key, descriptor] of descriptors) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else delete (globalThis as Record<string, unknown>)[key];
        }
      }
    }

    async function applyWrite(command: BridgeCommand): Promise<JsonObject | null> {
      const args = command.arguments ?? {};
      switch (command.toolName) {
        case "canvas_create_new_quiz": {
          const id = String(nextQuizId++);
          const saved = applyQuizArguments({ id, course_id: COURSE_ID, created_at: new Date().toISOString() }, args);
          quizzes.set(id, saved);
          quizItems.set(id, []);
          return saved;
        }
        case "canvas_update_single_quiz": {
          const id = exactId(args.assignment_id);
          const saved = applyQuizArguments(quizzes.get(id) ?? { id, course_id: COURSE_ID }, args);
          quizzes.set(id, saved);
          return saved;
        }
        case "canvas_delete_new_quiz": {
          const id = exactId(args.assignment_id);
          quizzes.delete(id);
          quizItems.delete(id);
          return null;
        }
        case "canvas_create_quiz_item": {
          const quizId = exactId(args.assignment_id);
          const id = String(nextItemId++);
          const items = quizItems.get(quizId) ?? [];
          const item = providerItemFromArguments(args, id);
          item.position = Number(args.item_position ?? items.length + 1);
          items.push(item);
          items.sort((left, right) => Number(left.position) - Number(right.position));
          items.forEach((entry, index) => { entry.position = index + 1; });
          quizItems.set(quizId, items);
          return item;
        }
        case "canvas_update_quiz_item": {
          const quizId = exactId(args.assignment_id);
          const itemId = exactId(args.item_id);
          const items = quizItems.get(quizId) ?? [];
          const index = items.findIndex((item) => exactId(item.id) === itemId);
          if (index < 0) throw new Error(`fixture item missing: ${itemId}`);
          if (isJsonObject(args.morrow_canvas_content_guard)) {
            const contentGuard = args.morrow_canvas_content_guard;
            const current = items[index]!;
            const entry = current.entry as JsonObject;
            const addAlt = (body: unknown): string => String(body).replace(/<img\s+([^>]*?)>/i, (_tag, attributes: string) => (
              `<img ${attributes} alt="${String(contentGuard.alt_text ?? "")}">`
            ));
            if (contentGuard.kind === "new_quiz_item_image_alt") entry.item_body = addAlt(entry.item_body);
            if (contentGuard.kind === "new_quiz_choice_image_alt") {
              const interaction = entry.interaction_data as JsonObject;
              const choicesValue = interaction.choices as JsonObject[];
              const choice = choicesValue.find((candidate) => candidate.id === contentGuard.choice_id)!;
              choice.item_body = addAlt(choice.item_body);
            }
            if (contentGuard.kind === "new_quiz_answer_feedback_image_alt") {
              const answerFeedback = entry.answer_feedback as JsonObject;
              answerFeedback[String(contentGuard.choice_id)] = addAlt(answerFeedback[String(contentGuard.choice_id)]);
            }
            if (contentGuard.kind === "new_quiz_feedback_image_alt") {
              const feedback = entry.feedback as JsonObject;
              feedback[String(contentGuard.feedback_type)] = addAlt(feedback[String(contentGuard.feedback_type)]);
            }
            return current;
          }
          if (args.item_position !== undefined) {
            const [moved] = items.splice(index, 1);
            items.splice(Math.max(0, Number(args.item_position) - 1), 0, moved!);
            items.forEach((entry, offset) => { entry.position = offset + 1; });
            return moved!;
          }
          const patch = providerItemFromArguments(args, itemId);
          const current = items[index]!;
          const entry = { ...(current.entry as JsonObject), ...(patch.entry as JsonObject) };
          const saved = { ...current, ...(args.item_points_possible === undefined ? {} : { points_possible: args.item_points_possible }), entry };
          items[index] = saved;
          return saved;
        }
        case "canvas_delete_quiz_item": {
          const quizId = exactId(args.assignment_id);
          const items = quizItems.get(quizId) ?? [];
          const index = items.findIndex((item) => exactId(item.id) === exactId(args.item_id));
          if (index >= 0) items.splice(index, 1);
          items.forEach((entry, offset) => { entry.position = offset + 1; });
          return null;
        }
        case "canvas_item_bank_update_item": {
          if (isJsonObject(args.item)) {
            Object.assign(bankItem, structuredClone(args.item));
            return bankItem;
          }
          const currentBody = String((bankItem.entry as JsonObject).item_body);
          const applied = await guard.applyItemBankImageAlt(currentBody, args.morrow_item_bank_guard);
          if (!applied.body || applied.error) throw new Error(applied.error || "item bank guard did not produce a body");
          bankItem.entry = { ...(bankItem.entry as JsonObject), item_body: applied.body };
          return bankItem;
        }
        case "canvas_create_module_item": {
          const saved: JsonObject = {
            id: String(nextModuleItemId++), module_id: exactId(args.module_id), type: String(args.module_item_type),
            content_id: Number(args.module_item_content_id),
            position: Number(args.module_item_position ?? courseModuleItems.filter((item) => exactId(item.module_id) === exactId(args.module_id)).length + 1),
          };
          courseModuleItems.push(saved);
          return saved;
        }
        case "canvas_update_module_item": {
          const saved = courseModuleItems.find((item) => exactId(item.id) === exactId(args.id));
          if (!saved) throw new Error("unknown module item");
          if (args.module_item_module_id !== undefined) saved.module_id = exactId(args.module_item_module_id);
          if (args.module_item_position !== undefined) saved.position = Number(args.module_item_position);
          return saved;
        }
        case "canvas_edit_assignment": {
          const saved = quizAssignments.get(exactId(args.id));
          if (!saved) throw new Error("unknown assignment");
          if (args.assignment_position !== undefined) saved.position = Number(args.assignment_position);
          return assignmentRecord(exactId(args.id))!;
        }
        case "canvas_item_bank_create_bank": return { id: "92", title: args.title, language: args.language ?? "en" };
        case "canvas_item_bank_rename_bank": return { id: exactId(args.bank_id), title: args.title };
        case "canvas_item_bank_archive_bank": return null;
        case "canvas_item_bank_create_item": return { ...(args.item as JsonObject), id: "502" };
        case "canvas_item_bank_attach_item": return { id: "702", bank_id: exactId(args.bank_id), entry_type: "Item", entry_id: exactId(args.item_id) };
        case "canvas_item_bank_delete_entry": return null;
        case "canvas_item_bank_share_bank": return { id: "share-1", entity_type: args.entity_type, entity_id: args.entity_id, permission: args.permission };
        case "canvas_item_bank_attach_bank_to_quiz": {
          const row = {
            id: "draw-1", entry_type: "Bank", entry_id: exactId(args.bank_id),
            position: args.position, points_possible: args.points_per_item,
            properties: { sample_num: args.pick_count },
          };
          quizBankDraws.push(row);
          return row;
        }
        default: throw new Error(`unexpected write ${command.toolName}`);
      }
    }

    async function answer(command: BridgeCommand): Promise<void> {
      bridgeCommands.push(command);
      if (command.kind === "edit_policy_options_get") {
        bridge?.respond(command, {
          schema: "morrow.bridge.edit-options.v1", sourceBindingId: SOURCE_BINDING_ID, provider: "canvas",
          catalogDigest: browserCatalogDigest, policyRevision: 0, runtimeVerified: true, options: [],
        });
        return;
      }
      if (command.kind === "invoke_read") {
        const operation = operationFor(command.toolName);
        if (operation.service === "item_bank") {
          const { result, writes } = await executeRealItemBankCommand(command);
          expect(result, `${command.toolName}: ${JSON.stringify(result)}`).toMatchObject({ ok: true, sent: true });
          expect(writes, command.toolName).toBe(0);
          bridge?.respond(command, result);
          return;
        }
        if (operation.path.startsWith("/quiz/v1/")) {
          const { result, writes } = await executeRealCanvasCommand(command);
          expect(result, `${command.toolName}: ${JSON.stringify(result)}`).toMatchObject({ ok: true, sent: true });
          expect(writes, command.toolName).toBe(0);
          bridge?.respond(command, result);
          return;
        }
        bridge?.respond(command, {
          schema: "morrow.canvas-browser-result.v1", ok: true, sent: true, status: 200,
          truncated: false, pageCount: 1, data: readData(command) as JsonObject,
        });
        return;
      }
      if (command.kind !== "invoke_write") return;
      writeCommands.push(command);
      const operation = operationFor(command.toolName);
      if (operation.service === "item_bank") {
        const { result, writes } = await executeRealItemBankCommand(command);
        expect(result, `${command.toolName}: ${JSON.stringify(result)}`).toMatchObject({ ok: true, sent: true, verification: { status: "verified" } });
        expect(writes, `${command.toolName} did not send exactly one provider write`).toBe(1);
        if (nextUnknownTool === command.toolName) {
          nextUnknownTool = "";
          bridge?.respondProblem(command, {
            schema: "morrow.bridge.problem.v1", code: "write_outcome_unknown",
            message: "The fixture dropped the Bridge response after verified Item Bank readback.", recoverable: false,
          }, result);
          return;
        }
        bridge?.respond(command, result);
        return;
      }
      if (operation.path.startsWith("/quiz/v1/")) {
        const { result, writes } = await executeRealCanvasCommand(command);
        expect(result, `${command.toolName}: ${JSON.stringify(result)}`).toMatchObject({ ok: true, sent: true });
        expect(writes, `${command.toolName} did not send exactly one provider write`).toBe(1);
        const descriptor = planCanvasRecoveryDescriptor(catalog.operations, operation, command.arguments, result.data);
        const browserResult: JsonObject = {
          ...result,
          ...(result.verification ? {} : {
            verification: {
              schema: "morrow.browser-verification.v1",
              status: "verified",
              strategy: descriptor?.strategy ?? "updated-resource",
              readTool: descriptor?.read?.readTool ?? "canvas_get_new_quiz",
              evidence: "fresh_readback_matches_requested_postcondition",
            },
          }),
          ...(descriptor ? { readDescriptor: descriptor as unknown as JsonObject } : {}),
        };
        if (nextUnknownTool === command.toolName) {
          nextUnknownTool = "";
          bridge?.respondProblem(command, {
            schema: "morrow.bridge.problem.v1", code: "write_outcome_unknown",
            message: "The fixture dropped the provider response after the saved state changed.", recoverable: false,
          }, browserResult);
          return;
        }
        bridge?.respond(command, browserResult);
        return;
      }
      const saved = await applyWrite(command);
      const descriptor = planCanvasRecoveryDescriptor(catalog.operations, operation, command.arguments, saved);
      const browserResult: JsonObject = {
        schema: "morrow.canvas-browser-result.v1", ok: true, sent: true, status: 200,
        truncated: false, data: saved,
        verification: {
          schema: "morrow.browser-verification.v1", status: "verified",
          strategy: descriptor?.strategy ?? "updated-resource",
          readTool: descriptor?.read?.readTool ?? (command.toolName === "canvas_item_bank_update_item" ? "canvas_item_bank_get_item" : "canvas_get_new_quiz"),
          evidence: "fresh_readback_matches_requested_postcondition",
        },
        ...(descriptor ? { readDescriptor: descriptor as unknown as JsonObject } : {}),
      };
      if (nextUnknownTool === command.toolName) {
        nextUnknownTool = "";
        bridge?.respondProblem(command, {
          schema: "morrow.bridge.problem.v1", code: "write_outcome_unknown",
          message: "The fixture dropped the provider response after the saved state changed.", recoverable: false,
        }, browserResult);
        return;
      }
      bridge?.respond(command, browserResult);
    }

    async function start(): Promise<void> {
      morrow = await MorrowRuntime.connect(config, { statePath: join(directory, "batch.sqlite3") });
      await assertPortListening(port);
      bridge = await connectBridgeTestClient({
        port, token: TOKEN, extensionId: EXTENSION_ID, catalogDigest: browserCatalogDigest,
        bindings: [binding],
      });
      bridge.onCommand((command) => {
        void answer(command).catch((error: unknown) => {
          browserExecutionFailure = new Error(`${command.toolName}: ${error instanceof Error ? error.message : String(error)}`);
          bridge?.respond(command, {
            schema: "morrow.canvas-browser-result.v1",
            ok: false,
            sent: false,
            error: browserExecutionFailure.message,
          });
        });
      });
      const [left, right] = InMemoryTransport.createLinkedPair();
      server = serveStdio(() => createFullMorrowServer(morrow!), { transport: right });
      client = new Client({ name: "quiz-bank-e2e", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
      await client.connect(left);
    }

    async function stop(): Promise<void> {
      await client?.close();
      client = undefined;
      await server?.close();
      server = undefined;
      await bridge?.close();
      bridge = undefined;
      await morrow?.close();
      morrow = undefined;
    }

    async function callRead(name: string, args: JsonObject): Promise<CallToolResult> {
      const result = await client!.callTool({
        name: "morrow_capability_read",
        arguments: { name, arguments: { ...args, _morrow: { source_binding_id: SOURCE_BINDING_ID } } },
      }) as CallToolResult;
      expect(result.isError, `${name}: ${JSON.stringify(result)}`).not.toBe(true);
      return result;
    }

    async function planAndDispatch(name: string, args: JsonObject, webApproval = false): Promise<CallToolResult> {
      const before = writeCommands.length;
      const planned = await client!.callTool({
        name: "morrow_capability_change",
        arguments: { name, arguments: args },
      }) as CallToolResult;
      expect(planned.isError, `${name}: ${JSON.stringify({ args, planned })}`).not.toBe(true);
      const id = operationId(planned);
      expect(writeCommands, `${name} wrote during planning`).toHaveLength(before);
      if (webApproval) {
        const url = morrow!.gateway.approvalUrl(id);
        expect(typeof url).toBe("string");
        await approveThroughReviewPage(String(url));
        await waitFor(() => morrow!.gateway.effects.get(id).state === "verified", `${name} did not settle after review approval`);
        const result = await client!.callTool({ name: "morrow_operation_get", arguments: { operation_id: id } }) as CallToolResult;
        expect(writeCommands, `${name} dispatched more or less than once`).toHaveLength(before + 1);
        return result;
      }
      morrow!.gateway.approveOperation(id);
      const result = await client!.callTool({ name: "morrow_operation_dispatch", arguments: { operation_id: id } }) as CallToolResult;
      expect(result.isError, `${name}: ${JSON.stringify(result)}`).not.toBe(true);
      expect(structured(result), name).toMatchObject({ effectState: "verified", verification: { status: "verified" } });
      expect(writeCommands, `${name} dispatched more or less than once`).toHaveLength(before + 1);
      return result;
    }

    try {
      await start();

      const listed = (await client!.listTools()).tools;
      const listedNames = new Set(listed.map((tool) => tool.name));
      for (const name of ["morrow_capability_get", "morrow_capability_read", "morrow_capability_change", "morrow_operation_dispatch", "morrow_operation_reconcile", ...CURATED_TOOLS]) {
        expect(listedNames, `public MCP tool missing: ${name}`).toContain(name);
      }
      expect(new Set(listed.filter((tool) => /new_quiz|item_bank/.test(tool.name)).map((tool) => tool.name))).toEqual(CURATED_TOOLS);
      for (const tool of listed.filter((candidate) => CURATED_TOOLS.has(candidate.name))) {
        expect(tool.inputSchema, `${tool.name} schema`).toMatchObject({ type: "object" });
        expect(tool.annotations, `${tool.name} annotations`).toBeTruthy();
      }

      const admitted = relevantOperations.filter((operation) => operation.readOnly || canvasOperationAdmission(operation).write.state === "admitted");
      const held = relevantOperations.filter((operation) => !operation.readOnly && canvasOperationAdmission(operation).write.state === "held");
      expect(relevantOperations).toHaveLength(32);
      expect(admitted).toHaveLength(32);
      expect(held).toHaveLength(0);
      expect(relevantOperations.filter((operation) => operation.service === "item_bank" && !operation.readOnly
        && canvasOperationAdmission(operation).write.state === "admitted").map((operation) => operation.toolName))
        .toHaveLength(11);
      for (const operation of admitted) {
        const capability = await client!.callTool({ name: "morrow_capability_get", arguments: { name: operation.toolName } });
        expect(capability.isError, operation.toolName).not.toBe(true);
        expect(structured(capability), operation.toolName).toMatchObject({ descriptor: { canonicalName: operation.toolName, behavior: { readOnly: operation.readOnly } } });
        expect(JSON.stringify(structured(capability)), `${operation.toolName} schema missing`).toContain("inputSchema");
      }

      const readArguments: Record<string, JsonObject> = {
        canvas_get_items_media_upload_url: { course_id: COURSE_ID, assignment_id: "77" },
        canvas_get_new_quiz: { course_id: COURSE_ID, assignment_id: "77" },
        canvas_get_quiz_item: { course_id: COURSE_ID, assignment_id: "77", item_id: "11" },
        canvas_item_bank_get_bank: { course_id: COURSE_ID, bank_id: "91" },
        canvas_item_bank_get_entry: { course_id: COURSE_ID, bank_id: "91", bank_entry_id: "701" },
        canvas_item_bank_get_item: { course_id: COURSE_ID, bank_id: "91", item_id: "501" },
        canvas_item_bank_list_banks: { course_id: COURSE_ID },
        canvas_item_bank_list_entries: { course_id: COURSE_ID, bank_id: "91" },
        canvas_item_bank_list_shares: { course_id: COURSE_ID, bank_id: "91" },
        canvas_item_bank_list_quiz_draws: { course_id: COURSE_ID, assignment_id: "77" },
        canvas_list_new_quizzes: { course_id: COURSE_ID },
        canvas_list_quiz_items: { course_id: COURSE_ID, assignment_id: "77" },
      };
      for (const operation of admitted.filter((candidate) => candidate.readOnly)) {
        const result = await callRead(operation.toolName, readArguments[operation.toolName]!);
        expect(structured(result), operation.toolName).toMatchObject({ status: "succeeded" });
        provedCatalog.set(operation.toolName, "mcp_read_bridge_fixture");
      }

      const wrongCourseBefore = bridgeCommands.length;
      const wrongCourse = await client!.callTool({
        name: "morrow_capability_read",
        arguments: { name: "canvas_get_new_quiz", arguments: { course_id: "99", assignment_id: "77", _morrow: { source_binding_id: SOURCE_BINDING_ID } } },
      });
      expect(wrongCourse.isError).toBe(true);
      expect(bridgeCommands).toHaveLength(wrongCourseBefore);

      await planAndDispatch("canvas_update_single_quiz", {
        course_id: COURSE_ID, assignment_id: "77", quiz_title: "Updated through MCP",
        _morrow: { source_binding_id: SOURCE_BINDING_ID },
      });
      expect(quizzes.get("77")?.title).toBe("Updated through MCP");
      provedCatalog.set("canvas_update_single_quiz", "plan_approval_bridge_exact_readback");

      const directItemId = exactId((quizItems.get("77") ?? [])[0]?.id);
      await planAndDispatch("canvas_update_quiz_item", {
        course_id: COURSE_ID, assignment_id: "77", item_id: directItemId, item_points_possible: 4,
        _morrow: { source_binding_id: SOURCE_BINDING_ID },
      });
      expect((quizItems.get("77") ?? []).find((item) => exactId(item.id) === directItemId)?.points_possible).toBe(4);
      provedCatalog.set("canvas_update_quiz_item", "plan_approval_bridge_exact_readback");

      for (const operation of held) {
        const before = writeCommands.length;
        const capability = await client!.callTool({ name: "morrow_capability_get", arguments: { name: operation.toolName } });
        expect(structured(capability), operation.toolName).toMatchObject({ code: "capability_not_found" });
        const refused = await client!.callTool({ name: "morrow_capability_change", arguments: { name: operation.toolName, arguments: {} } });
        expect(refused.isError, operation.toolName).toBe(true);
        expect(structured(refused), operation.toolName).toMatchObject({ code: "capability_not_found" });
        expect(writeCommands, `${operation.toolName} reached a write`).toHaveLength(before);
        provedCatalog.set(operation.toolName, `held_${canvasOperationAdmission(operation).write.state}`);
      }

      const wrongBankWriteBefore = writeCommands.length;
      const wrongBankWrite = await client!.callTool({
        name: "morrow_capability_change",
        arguments: {
          name: "canvas_item_bank_rename_bank",
          arguments: {
            course_id: "99", bank_id: "91", title: "Wrong course",
            expected_snapshot: { bank_sha256: "0".repeat(64) },
            _morrow: { source_binding_id: SOURCE_BINDING_ID },
          },
        },
      });
      expect(wrongBankWrite.isError).toBe(true);
      expect(writeCommands).toHaveLength(wrongBankWriteBefore);

      const catalogQuestionTypes = ((operationFor("canvas_create_quiz_item").inputSchema.properties as JsonObject)
        .item_entry_interaction_type_slug as JsonObject).enum as string[];
      expect(new Set(Object.keys(questionPayloads))).toEqual(new Set(catalogQuestionTypes));
      expect(new Set(Object.keys(fixtures.QUIZ_BANK_E2E_QUESTION_TYPE_DISPOSITION))).toEqual(new Set(catalogQuestionTypes));
      for (const [slug, payload] of Object.entries(questionPayloads)) {
        const before = writeCommands.length;
        const planned = await client!.callTool({
          name: "morrow_plan_new_quiz_item_create",
          arguments: { source_binding_id: SOURCE_BINDING_ID, course_id: COURSE_ID, quiz_id: "77", item: payload },
        }) as CallToolResult;
        provedCurated.add("morrow_plan_new_quiz_item_create");
        if (fixtures.QUIZ_BANK_E2E_QUESTION_TYPE_DISPOSITION[slug] === "held_media_chain") {
          // A Hot Spot create is a real create now, but only through the reviewed media chain:
          // Canvas's signed upload URL, one PUT of the exact reviewed bytes, then the item create
          // with that URL minus its query string. This fixture payload carries its own image_url
          // and no material_path, so it is refused before anything reaches Canvas. The working
          // chain is proved by canvas-new-quiz-hot-spot.test.ts and its integration suite.
          expect(planned.isError, slug).toBe(true);
          // The refusal code is the routing proof. The ordinary question planner refuses with
          // new_quiz_item_lifecycle_not_planned; only the Hot Spot path rejects a frozen operation
          // plan, which is what refusing a caller-supplied image URL does.
          expect(structured(planned), slug).toMatchObject({
            tool: "morrow_plan_new_quiz_item_create", status: "failed", phase: "rejected",
            data: { schema: "morrow.problem.v1", code: "operation_plan_invalid" },
          });
          expect(JSON.stringify(planned), slug).not.toContain("new_quiz_item_lifecycle_not_planned");
          expect(writeCommands).toHaveLength(before);
          provedQuestionTypes.set(slug, "refused_before_bridge_without_reviewed_media_chain");
          continue;
        }
        expect(planned.isError, `${slug}: ${JSON.stringify(planned)}`).not.toBe(true);
        const operation = (structured(planned).operations as JsonObject[])[0]!;
        expect(operation).toMatchObject({ tool: "canvas_create_quiz_item" });
        await planAndDispatch(String(operation.tool), operation.arguments as JsonObject);
        expect(writeCommands).toHaveLength(before + 1);
        provedCatalog.set("canvas_create_quiz_item", "curated_lifecycle_guard_browser_provider_readback");
        provedQuestionTypes.set(slug, "planner_approval_bridge_provider_readback");
      }

      const audit = await client!.callTool({
        name: "morrow_check_new_quiz",
        arguments: { source_binding_id: SOURCE_BINDING_ID, course_id: COURSE_ID, quiz_id: "78", expected_question_count: 11, expected_question_points: 11 },
      });
      expect(audit.isError, JSON.stringify(audit)).not.toBe(true);
      expect(structured(audit)).toMatchObject({ status: "checks_finished", findingCount: 0, quizzes: [{ questionContractsChecked: 11 }] });
      expect(Object.keys(((structured(audit).quizzes as JsonObject[])[0]!.questionTypes as JsonObject))).toHaveLength(11);
      provedCurated.add("morrow_check_new_quiz");

      const imageItem = () => (quizItems.get("77") ?? []).find((item) => exactId(item.id) === "14")!;
      const imageEntry = () => imageItem().entry as JsonObject;
      const repairInputs: readonly { name: string; args: JsonObject; saved: () => string; expected: string; prepare?: () => void }[] = [
        {
          name: "morrow_plan_new_quiz_item_image_alt_repair",
          args: {
            source_binding_id: SOURCE_BINDING_ID, course_id: COURSE_ID, quiz_id: "77", item_id: "14",
            expected_body_sha256: sha256Text(String(imageEntry().item_body)), image_index: 1,
            image_src_sha256: sha256Text("/courses/42/files/12"), alt_text: "Question diagram", decorative: false,
          },
          saved: () => String(imageEntry().item_body), expected: 'alt="Question diagram"',
        },
        {
          name: "morrow_plan_new_quiz_choice_image_alt_repair",
          args: {
            source_binding_id: SOURCE_BINDING_ID, course_id: COURSE_ID, quiz_id: "77", item_id: "14",
            choice_id: "11111111-1111-4111-8111-111111111111",
            expected_body_sha256: sha256Text(String((((imageEntry().interaction_data as JsonObject).choices as JsonObject[])[0]!).item_body)),
            image_index: 1, image_src_sha256: sha256Text("/courses/42/files/13"), alt_text: "Choice diagram", decorative: false,
          },
          prepare: () => {
            const choice = ((imageEntry().interaction_data as JsonObject).choices as JsonObject[])[0]!;
            choice.item_body = String(choice.item_body).replace(' alt="fixture"', "");
          },
          saved: () => String(((((imageEntry().interaction_data as JsonObject).choices as JsonObject[])[0]!)).item_body), expected: 'alt="Choice diagram"',
        },
        {
          name: "morrow_plan_new_quiz_answer_feedback_image_alt_repair",
          args: {
            source_binding_id: SOURCE_BINDING_ID, course_id: COURSE_ID, quiz_id: "77", item_id: "14",
            choice_id: "11111111-1111-4111-8111-111111111111",
            expected_body_sha256: sha256Text(String((imageEntry().answer_feedback as JsonObject)["11111111-1111-4111-8111-111111111111"])),
            image_index: 1, image_src_sha256: sha256Text("/courses/42/files/14"), alt_text: "Answer feedback diagram", decorative: false,
          },
          prepare: () => {
            const feedback = imageEntry().answer_feedback as JsonObject;
            feedback["11111111-1111-4111-8111-111111111111"] = String(feedback["11111111-1111-4111-8111-111111111111"]).replace(' alt="fixture"', "");
          },
          saved: () => String((imageEntry().answer_feedback as JsonObject)["11111111-1111-4111-8111-111111111111"]), expected: 'alt="Answer feedback diagram"',
        },
        {
          name: "morrow_plan_new_quiz_feedback_image_alt_repair",
          args: {
            source_binding_id: SOURCE_BINDING_ID, course_id: COURSE_ID, quiz_id: "77", item_id: "14", feedback_type: "correct",
            expected_body_sha256: sha256Text(String((imageEntry().feedback as JsonObject).correct)),
            image_index: 1, image_src_sha256: sha256Text("/courses/42/files/15"), alt_text: "Correct feedback diagram", decorative: false,
          },
          prepare: () => {
            const feedback = imageEntry().feedback as JsonObject;
            feedback.correct = String(feedback.correct).replace(' alt="fixture"', "");
          },
          saved: () => String((imageEntry().feedback as JsonObject).correct), expected: 'alt="Correct feedback diagram"',
        },
      ];
      for (const repairCase of repairInputs) {
        repairCase.prepare?.();
        repairCase.args.expected_body_sha256 = sha256Text(repairCase.saved());
        const before = writeCommands.length;
        const planned = await client!.callTool({ name: repairCase.name, arguments: repairCase.args });
        expect(planned.isError, `${repairCase.name}: ${JSON.stringify(planned)}`).not.toBe(true);
        expect(writeCommands).toHaveLength(before);
        const id = operationId(planned);
        morrow!.gateway.approveOperation(id);
        const applied = await client!.callTool({ name: "morrow_operation_dispatch", arguments: { operation_id: id } });
        expect(structured(applied), `${repairCase.name}: ${JSON.stringify(structured(applied))}`).toMatchObject({ effectState: "verified", verification: { status: "verified" } });
        expect(repairCase.saved(), repairCase.name).toContain(repairCase.expected);
        expect(writeCommands).toHaveLength(before + 1);
        provedCurated.add(repairCase.name);
      }

      for (const [index, targetId] of ["801", "802", "803"].entries()) {
        const before = [...(quizItems.get("80") ?? [])].sort((left, right) => Number(left.position) - Number(right.position));
        const targetPosition = Number(before.find((item) => exactId(item.id) === targetId)?.position);
        expect(targetPosition, targetId).toBe(index + 1);
        const replacement = await client!.callTool({
          name: "morrow_plan_new_quiz_item_replacement",
          arguments: {
            source_binding_id: SOURCE_BINDING_ID,
            course_id: COURSE_ID,
            quiz_id: "80",
            item_id: targetId,
            item: { entry: { item_body: `<p>Replacement at position ${targetPosition}</p>` } },
          },
        });
        expect(replacement.isError, `${targetId}: ${JSON.stringify(replacement)}`).not.toBe(true);
        const replacementOps = structured(replacement).operations as JsonObject[];
        expect(replacementOps.map((operation) => operation.tool)).toEqual(["canvas_delete_quiz_item", "canvas_create_quiz_item"]);
        await planAndDispatch(String(replacementOps[0]!.tool), replacementOps[0]!.arguments as JsonObject);
        provedCatalog.set("canvas_delete_quiz_item", "curated_lifecycle_guard_browser_exact_absence");
        if (index === 0) {
          const stale = await executeRealCanvasCommand(writeCommands.at(-1)!);
          expect(stale.writes).toBe(0);
          expect(stale.result).toMatchObject({ ok: false, sent: false });
          expect(String(stale.result.error)).toMatch(/^new_quiz_item_lifecycle_stale:/);
        }
        await planAndDispatch(String(replacementOps[1]!.tool), replacementOps[1]!.arguments as JsonObject);
        const after = [...(quizItems.get("80") ?? [])].sort((left, right) => Number(left.position) - Number(right.position));
        const added = after.filter((item) => !before.some((candidate) => exactId(candidate.id) === exactId(item.id)));
        expect(after.some((item) => exactId(item.id) === targetId), targetId).toBe(false);
        expect(after.map((item) => Number(item.position)), targetId).toEqual([1, 2, 3]);
        expect(added, targetId).toHaveLength(1);
        expect(added[0], targetId).toMatchObject({ position: targetPosition, entry: { item_body: `<p>Replacement at position ${targetPosition}</p>` } });
      }
      provedCurated.add("morrow_plan_new_quiz_item_replacement");

      const deleteTarget = exactId((quizItems.get("77") ?? []).find((item) => exactId(item.id) !== "13")?.id);
      const deletion = await client!.callTool({
        name: "morrow_plan_new_quiz_item_delete",
        arguments: { source_binding_id: SOURCE_BINDING_ID, course_id: COURSE_ID, quiz_id: "77", item_id: deleteTarget },
      });
      expect(deletion.isError, JSON.stringify(deletion)).not.toBe(true);
      const deleteOperation = (structured(deletion).operations as JsonObject[])[0]!;
      await planAndDispatch(String(deleteOperation.tool), deleteOperation.arguments as JsonObject);
      expect((quizItems.get("77") ?? []).some((item) => exactId(item.id) === deleteTarget)).toBe(false);
      provedCatalog.set("canvas_delete_quiz_item", "curated_lifecycle_guard_browser_exact_absence");
      provedCurated.add("morrow_plan_new_quiz_item_delete");

      const beforeOrder = (quizItems.get("78") ?? []).sort((left, right) => Number(left.position) - Number(right.position)).map((item) => exactId(item.id));
      const expectedOrder = [beforeOrder.at(-1)!, ...beforeOrder.slice(0, -1)];
      const order = await client!.callTool({
        name: "morrow_plan_new_quiz_item_order",
        arguments: { source_binding_id: SOURCE_BINDING_ID, course_id: COURSE_ID, quiz_id: "78", ordered_item_ids: expectedOrder },
      });
      expect(order.isError, JSON.stringify(order)).not.toBe(true);
      const orderOperations = structured(order).operations as JsonObject[];
      expect(orderOperations).toHaveLength(1);
      await planAndDispatch(String(orderOperations[0]!.tool), orderOperations[0]!.arguments as JsonObject);
      expect((quizItems.get("78") ?? []).sort((left, right) => Number(left.position) - Number(right.position)).map((item) => exactId(item.id))).toEqual(expectedOrder);
      provedCurated.add("morrow_plan_new_quiz_item_order");

      const settings = {
        shuffle_answers: true, shuffle_questions: true, one_at_a_time_type: "question", allow_backtracking: true,
        calculator_type: "scientific", filter_ip_address: true, filters: { ips: [["192.0.2.1", "192.0.2.2"]] },
        has_time_limit: true, session_time_limit_in_seconds: 900,
        require_student_access_code: true, student_access_code: "cells",
        multiple_attempts: { multiple_attempts_enabled: true, attempt_limit: true, max_attempts: 3, score_to_keep: "highest", cooling_period: true, cooling_period_seconds: 60 },
        result_view_settings: {
          result_view_restricted: true, display_points_awarded: true, display_points_possible: true,
          display_items: true, display_item_feedback: true, display_item_response: true,
          display_item_response_qualifier: "always", display_item_response_correctness: true,
          display_item_response_correctness_qualifier: "always", display_item_correct_answer: true,
          show_item_responses_at: "2026-10-01T17:00:00Z", hide_item_responses_at: "2026-10-02T17:00:00Z",
          show_item_response_correctness_at: "2026-10-01T17:00:00Z", hide_item_response_correctness_at: "2026-10-02T17:00:00Z",
        },
      };
      const settingsPlan = await client!.callTool({
        name: "morrow_plan_new_quiz_settings",
        arguments: { source_binding_id: SOURCE_BINDING_ID, course_id: COURSE_ID, quiz_id: "77", settings },
      });
      expect(settingsPlan.isError, JSON.stringify(settingsPlan)).not.toBe(true);
      const settingsId = operationId(settingsPlan);
      morrow!.gateway.approveOperation(settingsId);
      const settingsResult = await client!.callTool({ name: "morrow_operation_dispatch", arguments: { operation_id: settingsId } });
      expect(structured(settingsResult)).toMatchObject({ effectState: "verified", verification: { status: "verified" } });
      expect(quizzes.get("77")?.quiz_settings).toEqual((structured(settingsPlan).settings_plan as JsonObject).merged_settings);
      provedCurated.add("morrow_plan_new_quiz_settings");

      // Canvas carries a New Quiz in a module as an Assignment module item whose content id is
      // the New Quiz id, and orders it in its group as the Assignment it is.
      const placement = await client!.callTool({
        name: "morrow_plan_new_quiz_module_placement",
        arguments: { source_binding_id: SOURCE_BINDING_ID, course_id: COURSE_ID, quiz_id: "77", module_id: "7", position: 2 },
      });
      expect(placement.isError, JSON.stringify(placement)).not.toBe(true);
      const placementId = operationId(placement);
      morrow!.gateway.approveOperation(placementId);
      expect(structured(await client!.callTool({ name: "morrow_operation_dispatch", arguments: { operation_id: placementId } })))
        .toMatchObject({ effectState: "verified", verification: { status: "verified" } });
      const placed = courseModuleItems.find((item) => item.type === "Assignment" && exactId(item.content_id) === "77")!;
      expect(placed).toMatchObject({ module_id: "7", position: 2 });
      provedCurated.add("morrow_plan_new_quiz_module_placement");

      const move = await client!.callTool({
        name: "morrow_plan_new_quiz_module_move",
        arguments: { source_binding_id: SOURCE_BINDING_ID, course_id: COURSE_ID, quiz_id: "77", module_id: "7", module_item_id: String(placed.id), target_module_id: "9", position: 1 },
      });
      expect(move.isError, JSON.stringify(move)).not.toBe(true);
      const moveId = operationId(move);
      morrow!.gateway.approveOperation(moveId);
      expect(structured(await client!.callTool({ name: "morrow_operation_dispatch", arguments: { operation_id: moveId } })))
        .toMatchObject({ effectState: "verified", verification: { status: "verified" } });
      expect(placed).toMatchObject({ module_id: "9", position: 1 });
      provedCurated.add("morrow_plan_new_quiz_module_move");

      const groupOrder = await client!.callTool({
        name: "morrow_plan_new_quiz_assignment_group_order",
        arguments: { source_binding_id: SOURCE_BINDING_ID, course_id: COURSE_ID, quiz_id: "77", position: 2 },
      });
      expect(groupOrder.isError, JSON.stringify(groupOrder)).not.toBe(true);
      const groupOrderId = operationId(groupOrder);
      morrow!.gateway.approveOperation(groupOrderId);
      expect(structured(await client!.callTool({ name: "morrow_operation_dispatch", arguments: { operation_id: groupOrderId } })))
        .toMatchObject({ effectState: "verified", verification: { status: "verified" } });
      expect(quizAssignments.get("77")).toMatchObject({ position: 2 });
      provedCurated.add("morrow_plan_new_quiz_assignment_group_order");

      // A New Quiz create is bound to the complete current course quiz list, and Canvas assigns
      // the id. The readback requires exactly one added id and the created quiz to match.
      const quizzesBeforeCreate = quizzes.size;
      const createdQuiz = await client!.callTool({
        name: "morrow_plan_new_quiz_create",
        arguments: { source_binding_id: SOURCE_BINDING_ID, course_id: COURSE_ID, quiz: { title: "Conformance create", points_possible: 3 } },
      });
      expect(createdQuiz.isError, JSON.stringify(createdQuiz)).not.toBe(true);
      const createdQuizId = operationId(createdQuiz);
      morrow!.gateway.approveOperation(createdQuizId);
      expect(structured(await client!.callTool({ name: "morrow_operation_dispatch", arguments: { operation_id: createdQuizId } })))
        .toMatchObject({ effectState: "verified", verification: { status: "verified" } });
      expect(quizzes.size).toBe(quizzesBeforeCreate + 1);
      const savedNewQuiz = [...quizzes.values()].find((quiz) => quiz.title === "Conformance create");
      expect(savedNewQuiz).toMatchObject({ course_id: COURSE_ID, points_possible: 3 });
      provedCatalog.set("canvas_create_new_quiz", "curated_lifecycle_guard_browser_provider_readback");
      provedCurated.add("morrow_plan_new_quiz_create");

      // A delete freezes the quiz, its complete item list and the linked Assignment, and requires
      // Canvas to report no submitted and no graded work. The readback is exact absence.
      const deleteTargetId = exactId(savedNewQuiz!.id);
      const deletedQuiz = await client!.callTool({
        name: "morrow_plan_new_quiz_delete",
        arguments: { source_binding_id: SOURCE_BINDING_ID, course_id: COURSE_ID, quiz_id: deleteTargetId },
      });
      expect(deletedQuiz.isError, JSON.stringify(deletedQuiz)).not.toBe(true);
      const deletedQuizOperationId = operationId(deletedQuiz);
      morrow!.gateway.approveOperation(deletedQuizOperationId);
      expect(structured(await client!.callTool({ name: "morrow_operation_dispatch", arguments: { operation_id: deletedQuizOperationId } })))
        .toMatchObject({ effectState: "verified", verification: { status: "verified" } });
      expect(quizzes.has(deleteTargetId)).toBe(false);
      provedCatalog.set("canvas_delete_new_quiz", "curated_lifecycle_guard_browser_exact_absence");
      provedCurated.add("morrow_plan_new_quiz_delete");

      // Canvas has no accommodation GET, so the contract is a response-bound effect: one exact
      // JSON array, one matching success row and no failure row. The learner is named by a
      // course-local label and the Canvas user id is resolved only inside the dispatch path.

      // A report create must answer with an Assignment-bound Progress record carrying its own
      // official Progress URL. That URL is the durable follow-up read.
      const report = await client!.callTool({
        name: "morrow_plan_new_quiz_report",
        arguments: { source_binding_id: SOURCE_BINDING_ID, course_id: COURSE_ID, quiz_id: "77", report_type: "student_analysis", format: "csv" },
      });
      expect(report.isError, JSON.stringify(report)).not.toBe(true);
      const reportId = operationId(report);
      morrow!.gateway.approveOperation(reportId);
      expect(structured(await client!.callTool({ name: "morrow_operation_dispatch", arguments: { operation_id: reportId } })), JSON.stringify(report))
        .toMatchObject({ effectState: "verified" });
      provedCatalog.set("canvas_create_quiz_report_course_id_quizzes_assignment_id_reports_post", "curated_progress_bound_request");
      provedCurated.add("morrow_plan_new_quiz_report");

      const fanOut = await client!.callTool({
        name: "morrow_read_item_bank_fan_out",
        arguments: { source_binding_id: SOURCE_BINDING_ID, course_id: COURSE_ID, bank_id: "91", quiz_use_course_ids: [COURSE_ID] },
      });
      expect(fanOut.isError, JSON.stringify({ fanOut, browserExecutionFailure, recentCommands: bridgeCommands.slice(-20) })).not.toBe(true);
      // The record is an observed-reach disclosure, never a completeness claim. `quiz_uses` has no
      // Item Banks route and share paging is unestablished, so both stay unread and the record
      // stays incomplete. The one course share row names numeric course 77, which is not the
      // selected course, so it is disclosed as an external course a reviewer must acknowledge
      // exactly. A share row carrying a private context UUID instead would be refused, because
      // Morrow has no proved mapping from that value to a numeric Canvas course id.
      expect(structured(fanOut)).toMatchObject({
        status: "incomplete",
        fan_out: {
          schema: "morrow.canvas.item-bank.fan-out.v1", bank_id: "91", course_id: COURSE_ID,
          complete: false, unreachable: ["quiz_uses", "shared_banks"], external_course_ids: ["77"],
          // Quiz 77 in the selected course draws from this bank, so it is a consumer too. It is
          // not external, because it is in the course the reviewer already selected.
          consumers: [
            { course_id: COURSE_ID, entity_type: "quiz_use", entity_id: "77" },
            { course_id: "77", entity_type: "shared_bank", entity_id: "77" },
          ],
          consumer_count: 2,
        },
        // The record alone is not enough to authorise a change: the reader also returns a
        // process-local receipt, and a repair must present the receipt issued with that exact
        // record.
        fan_out_receipt: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      provedCurated.add("morrow_read_item_bank_fan_out");

      const repairWritesBefore = writeCommands.length;
      const bankBodyBefore = String((bankItem.entry as JsonObject).item_body);
      const repair = await client!.callTool({
        name: "morrow_plan_item_bank_question_image_alt_repair",
        arguments: {
          source_binding_id: SOURCE_BINDING_ID, course_id: COURSE_ID, bank_id: "91", bank_entry_id: "701", item_id: "501",
          item_sha256: await guard.itemBankItemDigest(bankItem), image_index: 1,
          image_src_sha256: await crypto.subtle.digest("SHA-256", new TextEncoder().encode("/courses/42/files/9")).then((bytes) => Buffer.from(bytes).toString("hex")),
          // The acknowledgement is exact: every disclosed external course, and no other.
          alt_text: "Cell membrane diagram", fan_out: structured(fanOut).fan_out,
          fan_out_receipt: structured(fanOut).fan_out_receipt, acknowledged_course_ids: ["77"],
        },
      });
      // Reach is now disclosed and acknowledged rather than claimed complete, so an exact
      // acknowledgement of every disclosed external course, presented with the receipt issued for
      // that exact record, lets the repair plan. Planning still sends nothing: the operation waits
      // for approval and the saved bank question is untouched.
      expect(repair.isError, JSON.stringify(repair)).not.toBe(true);
      expect(structured(repair)).toMatchObject({
        tool: "canvas_item_bank_update_item", status: "awaiting_approval", phase: "planned",
        effectState: "awaiting_approval", verification: { status: "unconfirmed" },
      });
      expect(writeCommands).toHaveLength(repairWritesBefore);
      expect((bankItem.entry as JsonObject).item_body).toBe(bankBodyBefore);

      // The exact-acknowledgement rule is enforced at plan time now, with the same fixed code the
      // Bridge enforces immediately before dispatch (validObservedFanOut in
      // connector/extension/src/item-bank-executor.js). The planner refuses a plan whose
      // acknowledgement is not exactly the disclosed external course list, so an inexact
      // acknowledgement never reaches approval at all; dispatch stays the independent last line.
      // Planning sends nothing either way.
      const inexact = await client!.callTool({
        name: "morrow_plan_item_bank_question_image_alt_repair",
        arguments: {
          source_binding_id: SOURCE_BINDING_ID, course_id: COURSE_ID, bank_id: "91", bank_entry_id: "701", item_id: "501",
          item_sha256: await guard.itemBankItemDigest(bankItem), image_index: 1,
          image_src_sha256: await crypto.subtle.digest("SHA-256", new TextEncoder().encode("/courses/42/files/9")).then((bytes) => Buffer.from(bytes).toString("hex")),
          alt_text: "Cell membrane diagram", fan_out: structured(fanOut).fan_out,
          fan_out_receipt: structured(fanOut).fan_out_receipt, acknowledged_course_ids: [],
        },
      });
      expect(inexact.isError).toBe(true);
      expect(structured(inexact)).toMatchObject({ code: "item_bank_fan_out_acknowledgement_mismatch" });
      expect(writeCommands).toHaveLength(repairWritesBefore);
      expect((bankItem.entry as JsonObject).item_body).toBe(bankBodyBefore);
      provedCurated.add("morrow_plan_item_bank_question_image_alt_repair");

      // Approving the exact repair sends one bank item update and rereads the exact item.
      const repairOperationId = operationId(repair);
      morrow!.gateway.approveOperation(repairOperationId);
      expect(structured(await client!.callTool({ name: "morrow_operation_dispatch", arguments: { operation_id: repairOperationId } })))
        .toMatchObject({ effectState: "verified", verification: { status: "verified" } });
      // The executor replaces the saved record, so the bank's own copy is the one to read.
      expect(String(((bankItems.get("501")!).entry as JsonObject).item_body)).toContain('alt="Cell membrane diagram"');
      provedCatalog.set("canvas_item_bank_update_item", "curated_repair_guard_browser_exact_readback");

      const wrongWriteBefore = writeCommands.length;
      const wrongWrite = await client!.callTool({
        name: "morrow_capability_change",
        arguments: { name: "canvas_update_single_quiz", arguments: { course_id: "99", assignment_id: "77", quiz_title: "Wrong course", _morrow: { source_binding_id: SOURCE_BINDING_ID } } },
      });
      expect(wrongWrite.isError).toBe(true);
      expect(writeCommands).toHaveLength(wrongWriteBefore);

      const lostPlan = await client!.callTool({
        name: "morrow_capability_change",
        arguments: { name: "canvas_update_single_quiz", arguments: { course_id: COURSE_ID, assignment_id: "77", quiz_title: "Recovered after restart", _morrow: { source_binding_id: SOURCE_BINDING_ID } } },
      });
      const lostId = operationId(lostPlan);
      morrow!.gateway.approveOperation(lostId);
      nextUnknownTool = "canvas_update_single_quiz";
      const lostWritesBefore = writeCommands.length;
      const lost = await client!.callTool({ name: "morrow_operation_dispatch", arguments: { operation_id: lostId } });
      expect(structured(lost)).toMatchObject({ effectState: "applied_or_unknown", verification: { status: "unconfirmed" } });
      expect(writeCommands).toHaveLength(lostWritesBefore + 1);
      expect(quizzes.get("77")?.title).toBe("Recovered after restart");

      await stop();
      await start();
      const recovered = await client!.callTool({ name: "morrow_operation_reconcile", arguments: { operation_id: lostId } });
      expect(recovered.isError, JSON.stringify(recovered)).not.toBe(true);
      expect(structured(recovered)).toMatchObject({
        phase: "verified_readback", effectState: "verified", verification: { status: "verified" },
        data: { schema: "morrow.canvas-operation-recovery.v1", resentWrite: false },
      });
      expect(writeCommands).toHaveLength(lostWritesBefore + 1);

      // Operations whose contract is proved by a named dedicated suite instead of this harness.
      // Each one needs provider or privacy state this end-to-end fixture does not model, and each
      // is named with the suite that does prove it, so nothing is recorded as covered by nobody.
      const PROVED_ELSEWHERE: Readonly<Record<string, string>> = {
        // The learner label these two write is minted by the roster privacy boundary, which this
        // fixture's roster does not establish (privacy_identity_record_unresolved).
        canvas_set_course_level_accommodations: "packages/mcp-server/test/new-quiz-effects.test.ts",
        canvas_set_quiz_level_accommodations: "packages/mcp-server/test/new-quiz-effects.test.ts",
        // Owner-bank writes. Each one is driven end to end against the real in-page executor,
        // with its own snapshot preconditions and refusals, by the Item Bank executor suite.
        canvas_item_bank_create_bank: "scripts/test/canvas-item-bank-executor.test.mjs",
        canvas_item_bank_rename_bank: "scripts/test/canvas-item-bank-executor.test.mjs",
        canvas_item_bank_archive_bank: "scripts/test/canvas-item-bank-executor.test.mjs",
        canvas_item_bank_create_item: "scripts/test/canvas-item-bank-executor.test.mjs",
        canvas_item_bank_attach_item: "scripts/test/canvas-item-bank-executor.test.mjs",
        canvas_item_bank_delete_entry: "scripts/test/canvas-item-bank-executor.test.mjs",
        canvas_item_bank_share_bank: "scripts/test/canvas-item-bank-executor.test.mjs",
        // The three assignment-bound quiz-builder writes, driven end to end against the real
        // executor, including the documented all-items draw and the exact-absence delete.
        canvas_item_bank_attach_bank_to_quiz: "scripts/test/canvas-quiz-bank-draw-executor.test.mjs",
        canvas_item_bank_attach_bank_entry_to_quiz: "scripts/test/canvas-quiz-bank-draw-executor.test.mjs",
        canvas_item_bank_delete_quiz_bank_entry: "scripts/test/canvas-quiz-bank-draw-executor.test.mjs",
      };
      for (const name of Object.keys(PROVED_ELSEWHERE)) {
        expect(provedCatalog.has(name), `${name} is now proved here; remove it from PROVED_ELSEWHERE`).toBe(false);
      }
      const expectedCatalog = new Set(relevantOperations.map((operation) => operation.toolName));
      expect(new Set([...provedCatalog.keys(), ...Object.keys(PROVED_ELSEWHERE)])).toEqual(expectedCatalog);
      // Same rule for the curated planners: the accommodation planner needs the roster privacy
      // boundary this fixture does not establish, and new-quiz-effects.test.ts proves it.
      const CURATED_PROVED_ELSEWHERE = new Set(["morrow_plan_new_quiz_accommodation"]);
      for (const name of CURATED_PROVED_ELSEWHERE) {
        expect(provedCurated.has(name), `${name} is now proved here; remove it from CURATED_PROVED_ELSEWHERE`).toBe(false);
      }
      expect(new Set([...provedCurated, ...CURATED_PROVED_ELSEWHERE])).toEqual(CURATED_TOOLS);
      expect(new Set(provedQuestionTypes.keys())).toEqual(new Set(catalogQuestionTypes));
      // Uncovered means covered by nobody: proved neither here nor by the named suite that owns it.
      const uncoveredCatalog = [...expectedCatalog].filter((name) => !provedCatalog.has(name) && !(name in PROVED_ELSEWHERE));
      const uncoveredCurated = [...CURATED_TOOLS].filter((name) => !provedCurated.has(name) && !CURATED_PROVED_ELSEWHERE.has(name));
      const uncoveredQuestionTypes = catalogQuestionTypes.filter((name) => !provedQuestionTypes.has(name));
      expect({ uncoveredCatalog, uncoveredCurated, uncoveredQuestionTypes }).toEqual({
        uncoveredCatalog: [], uncoveredCurated: [], uncoveredQuestionTypes: [],
      });
      expect(browserExecutionFailure).toBeUndefined();
    } finally {
      await stop().catch(() => undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
