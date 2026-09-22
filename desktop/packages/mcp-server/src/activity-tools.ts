import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  isJsonObject,
  normalizeRequestedBy,
  type JsonObject,
  type RequestedByIdentity,
} from "@morrow/contracts";
import type { BatchRecord } from "@morrow/batch-engine";
import type { MorrowRuntime } from "./morrow-runtime.js";
import type { GatewayRuntime } from "./runtime.js";

/**
 * The saved-change states that still hold their provider target. A second
 * assistant that plans a change to one of these targets is refused, so this is
 * the list it must read before it starts work.
 */
const LOCKED_TARGET_STATES: readonly string[] = [
  "dispatching",
  "awaiting_inner_approval",
  "awaiting_verification",
  "applied_or_unknown",
];

/**
 * The two states morrow_operation_close_unresolved accepts. Morrow holds no
 * evidence of its own for these, so only a person can end them.
 */
const NEEDS_PERSON_STATES: readonly string[] = ["awaiting_verification", "applied_or_unknown"];

/** The saved-record page this tool reads. It is the broker and batch-store maximum. */
const ACTIVITY_RECORD_LIMIT = 200;

const COURSE_ID = /^[1-9][0-9]{0,18}$|^_[1-9][0-9]{0,18}_[1-9][0-9]{0,18}$/;

/** The batch-store and scheduler view. It is absent on a server without group tools. */
export type ActivityGroups = Pick<MorrowRuntime, "batches" | "batchScheduler">;

export interface ActivityToolOptions {
  /** The assistant identity for one connected session, when that assistant named itself. */
  readonly identityFor: (sessionId: string) => RequestedByIdentity | undefined;
  readonly groups?: ActivityGroups;
}

interface SessionEntry {
  readonly connectedAt: string;
  /** This session's own identity builder; each server reports its own client. */
  readonly identityFor: (sessionId: string) => RequestedByIdentity | undefined;
}

/**
 * One registry for each shared runtime, so every server built on that runtime
 * sees the same connected assistants. A session is removed when its connection
 * closes, and a session whose transport is gone is dropped when this is read.
 */
const registries = new WeakMap<GatewayRuntime, Map<McpServer, SessionEntry>>();

function registryFor(gateway: GatewayRuntime): Map<McpServer, SessionEntry> {
  const existing = registries.get(gateway);
  if (existing) return existing;
  const created = new Map<McpServer, SessionEntry>();
  registries.set(gateway, created);
  return created;
}

function sessionIdOf(server: McpServer): string {
  const sessionId = server.server.transport?.sessionId;
  return typeof sessionId === "string" && sessionId ? sessionId : "stdio-single-client";
}

/**
 * The exact label a batch window carries for one session. Morrow shows the name
 * that assistant reported, not proof of identity, and always its own session id,
 * so two connections of one assistant stay separable.
 */
export function batchWindowHolderLabel(
  requestedBy: { readonly clientName: string } | undefined,
  sessionId: string,
): string {
  return requestedBy ? `${requestedBy.clientName} (session ${sessionId})` : sessionId;
}

function textAndStructured(summary: string, structuredContent: JsonObject): CallToolResult {
  return {
    content: [{ type: "text", text: summary }],
    structuredContent,
  };
}

function counted(value: number, singular: string, plural: string): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function exactCourseId(value: unknown): string | null {
  if (typeof value === "string" && COURSE_ID.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}

function operationCourseId(entry: JsonObject): string | null {
  const plan = isJsonObject(entry.plan) ? entry.plan : null;
  const args = plan && isJsonObject(plan.arguments) ? plan.arguments : null;
  return args ? exactCourseId(args.course_id) : null;
}

function attentionOf(entry: JsonObject): readonly string[] {
  return Array.isArray(entry.attention)
    ? entry.attention.filter((value): value is string => typeof value === "string")
    : [];
}

function operationActivity(entry: JsonObject): JsonObject {
  const requestedBy = normalizeRequestedBy(entry.requestedBy);
  return {
    operationId: String(entry.operationId),
    tool: typeof entry.publicToolName === "string" ? entry.publicToolName : "",
    courseId: operationCourseId(entry),
    state: String(entry.state),
    attention: attentionOf(entry),
    targetDigest: typeof entry.targetIdentityDigest === "string" ? entry.targetIdentityDigest : null,
    ...(typeof entry.sourceBindingId === "string" ? { sourceBindingId: entry.sourceBindingId } : {}),
    updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : null,
    requestedBy: requestedBy ?? null,
  };
}

function savedChangeActivity(gateway: GatewayRuntime): {
  readonly locked: JsonObject;
  readonly needsPerson: JsonObject;
} {
  const listed = gateway.operationList(ACTIVITY_RECORD_LIMIT);
  const operations = Array.isArray(listed.operations)
    ? listed.operations.filter(isJsonObject).filter((entry) => typeof entry.operationId === "string")
    : [];
  // The store answers at most this many records, so a full page means older
  // records exist that this answer did not read.
  const coverageComplete = operations.length < ACTIVITY_RECORD_LIMIT;
  const locked = operations.filter((entry) => LOCKED_TARGET_STATES.includes(String(entry.state)));
  const needsPerson = locked.filter((entry) => NEEDS_PERSON_STATES.includes(String(entry.state)));
  return {
    locked: {
      count: locked.length,
      coverageComplete,
      targets: locked.map(operationActivity),
    },
    needsPerson: {
      count: needsPerson.length,
      coverageComplete,
      operations: needsPerson.map(operationActivity),
    },
  };
}

function batchChildren(record: BatchRecord): JsonObject {
  return {
    total: record.totalChildren,
    // A child with a known final result. An uncertain child is counted apart
    // because Morrow never repeats it.
    done: record.succeededChildren + record.failedChildren + record.cancelledChildren,
    uncertain: record.unknownChildren,
    running: record.runningChildren,
    pending: record.pendingChildren,
  };
}

function groupActivity(groups: ActivityGroups | undefined): JsonObject {
  if (!groups) {
    return { known: false, reason: "group_tools_unavailable_in_this_profile" };
  }
  const scheduler = groups.batchScheduler.health();
  const records = groups.batches.list(ACTIVITY_RECORD_LIMIT);
  const byId = new Map(records.map((record) => [record.batchId, record]));
  const holders = new Map(scheduler.activeBatches.map((holder) => [holder.batchId, holder]));
  const running = records
    .filter((record) => record.state === "running" || holders.has(record.batchId))
    .map((record) => {
      const holder = holders.get(record.batchId);
      return {
        batchId: record.batchId,
        name: record.name,
        mode: record.mode,
        state: record.state,
        windowHeld: Boolean(holder),
        holder: holder?.holder ?? null,
        startedAt: holder?.startedAt ?? record.startedAt,
        children: batchChildren(record),
        requestedBy: normalizeRequestedBy(record.requestedBy) ?? null,
      };
    });
  const queued = scheduler.waiting.map((waiter) => {
    const record = byId.get(waiter.batchId);
    return {
      batchId: waiter.batchId,
      name: record?.name ?? null,
      mode: waiter.mode,
      state: record?.state ?? null,
      holder: waiter.holder,
      queuedAt: waiter.queuedAt,
      children: record ? batchChildren(record) : null,
      requestedBy: (record ? normalizeRequestedBy(record.requestedBy) : undefined) ?? null,
    };
  });
  return {
    known: true,
    // A full page means older groups exist that this answer did not read.
    coverageComplete: records.length < ACTIVITY_RECORD_LIMIT,
    running,
    queued,
    maxConcurrentReadWindows: scheduler.maxConcurrentReadWindows,
    maxConcurrentWriteWindows: scheduler.maxConcurrentWriteWindows,
    maxQueuedWindows: scheduler.maxQueuedWindows,
    queueTimeoutMs: scheduler.queueTimeoutMs,
  };
}

function sessionActivity(
  gateway: GatewayRuntime,
  groups: ActivityGroups | undefined,
): JsonObject {
  const registry = registryFor(gateway);
  const scheduler = groups?.batchScheduler.health();
  const holding = new Set((scheduler?.activeBatches ?? []).map((holder) => holder.holder));
  const waiting = new Set((scheduler?.waiting ?? []).map((waiter) => waiter.holder));
  const sessions: JsonObject[] = [];
  for (const [server, entry] of registry) {
    if (!server.server.transport) {
      registry.delete(server);
      continue;
    }
    const sessionId = sessionIdOf(server);
    const requestedBy = entry.identityFor(sessionId);
    const label = batchWindowHolderLabel(requestedBy, sessionId);
    sessions.push({
      sessionId,
      connectedAt: entry.connectedAt,
      requestedBy: requestedBy ?? null,
      holdsBatchWindow: holding.has(label),
      waitingForBatchWindow: waiting.has(label),
    });
  }
  return {
    connected: sessions.length,
    // The client name and version are what each assistant reported at connect
    // time. Morrow does not verify them.
    namesAreSelfReported: true,
    sessions,
  };
}

function anchorSites(bindings: readonly JsonObject[]): JsonObject[] {
  const sites = new Map<string, { provider: string; origin: string; connections: number; verified: number }>();
  for (const binding of bindings) {
    const provider = typeof binding.provider === "string" ? binding.provider : "";
    const origin = typeof binding.origin === "string" ? binding.origin : "";
    if (!provider || !origin) continue;
    const key = `${provider} ${origin}`;
    const site = sites.get(key) ?? { provider, origin, connections: 0, verified: 0 };
    site.connections += 1;
    if (binding.runtimeVerified === true) site.verified += 1;
    sites.set(key, site);
  }
  return [...sites.values()].map((site) => ({
    provider: site.provider,
    origin: site.origin,
    courseConnections: site.connections,
    verifiedCourseConnections: site.verified,
    verified: site.connections > 0 && site.verified === site.connections,
  }));
}

/**
 * Reads the saved browser connections the Bridge already holds. The connector
 * answers from its own last message from the extension, so this sends nothing
 * to Canvas or Moodle.
 */
async function connectedAnchorSites(
  gateway: GatewayRuntime,
  signal: AbortSignal | undefined,
): Promise<{ readonly known: boolean; readonly sites: JsonObject[] }> {
  const matches = gateway.catalog.tools.filter((tool) => (
    tool.upstreamName === "morrow_browser_bindings" && tool.annotations?.readOnlyHint === true
  ));
  if (matches.length !== 1) return { known: false, sites: [] };
  try {
    const result = await gateway.callSourceOwned(matches[0]!.publicName, {}, { ...(signal ? { signal } : {}) });
    const content = isJsonObject(result.structuredContent) ? result.structuredContent : null;
    if (result.isError === true || !content || content.schema !== "morrow.browser-bindings.v1"
      || !Array.isArray(content.bindings)) {
      return { known: false, sites: [] };
    }
    return { known: true, sites: anchorSites(content.bindings.filter(isJsonObject)) };
  } catch {
    return { known: false, sites: [] };
  }
}

async function bridgeActivity(
  gateway: GatewayRuntime,
  health: JsonObject,
  signal: AbortSignal | undefined,
): Promise<JsonObject> {
  const components = isJsonObject(health.components) ? health.components : null;
  const bridge = components && isJsonObject(components.extensionBridge) ? components.extensionBridge : null;
  // A server that reports no Bridge component says so, rather than reporting a
  // disconnected Bridge it did not look at.
  if (!bridge) return { known: false, reason: "bridge_status_unavailable" };
  const connected = bridge.connected === true;
  const anchors = connected ? await connectedAnchorSites(gateway, signal) : { known: false, sites: [] };
  return {
    known: true,
    connected,
    ...(typeof bridge.reason === "string" ? { reason: bridge.reason } : {}),
    generation: typeof bridge.generation === "number" ? bridge.generation : null,
    extensionId: typeof bridge.extensionId === "string" ? bridge.extensionId : null,
    catalogDigest: typeof bridge.catalogDigest === "string" ? bridge.catalogDigest : null,
    // The Bridge refuses any extension whose catalog digest differs from the one
    // this Morrow expects, so a connected extension has already matched it.
    // Nothing is known about the digest while nothing is connected.
    catalogDigestMatches: connected ? true : null,
    connectedAt: typeof bridge.connectedAt === "string" ? bridge.connectedAt : null,
    anchorSitesKnown: anchors.known,
    anchorSites: anchors.sites,
  };
}

function summaryText(report: JsonObject): string {
  const assistants = isJsonObject(report.assistants) ? report.assistants : {};
  const groups = isJsonObject(report.groups) ? report.groups : {};
  const locked = isJsonObject(report.lockedTargets) ? report.lockedTargets : {};
  const needsPerson = isJsonObject(report.needsPerson) ? report.needsPerson : {};
  const connected = Number(assistants.connected) || 0;
  const running = Array.isArray(groups.running) ? groups.running.length : 0;
  const queued = Array.isArray(groups.queued) ? groups.queued.length : 0;
  const lockedCount = Number(locked.count) || 0;
  const personCount = Number(needsPerson.count) || 0;
  const lines = [
    `${counted(connected, "assistant is", "assistants are")} connected to this Morrow.`,
    groups.known !== true
      ? "This Morrow profile has no request groups."
      : running === 0
        ? "No request group is running."
        : `${counted(running, "request group is", "request groups are")} running`
          + `${queued === 0 ? "." : `, and ${counted(queued, "run is", "runs are")} waiting for a batch window.`}`,
    lockedCount === 0
      ? "No saved change is holding a course item."
      : `${counted(lockedCount, "saved change holds", "saved changes hold")} a course item, and `
        + `${personCount === 0 ? "none of them need" : counted(personCount, "needs", "need")} a person to check the item.`,
  ];
  return lines.join(" ");
}

export function registerActivityTool(
  server: McpServer,
  gateway: GatewayRuntime,
  health: () => JsonObject | Promise<JsonObject>,
  options: ActivityToolOptions,
): void {
  const registry = registryFor(gateway);
  const connected = () => {
    if (registry.has(server)) return;
    registry.set(server, {
      connectedAt: new Date().toISOString(),
      identityFor: options.identityFor,
    });
  };
  const initialized = server.server.oninitialized;
  server.server.oninitialized = () => {
    initialized?.();
    connected();
  };
  const closed = server.server.onclose;
  server.server.onclose = () => {
    closed?.();
    registry.delete(server);
  };

  server.registerTool(
    "morrow_activity",
    {
      title: "See what every assistant is doing",
      description: "Report what this Morrow is doing for every connected assistant right now: which assistants are connected, which request groups run or wait and which assistant holds each batch window, which saved changes still hold a course item, which changes need a person to check them, and the browser Bridge status with its connected sites. Read this before starting work another assistant already holds. It reads only Morrow's own saved state and does not read or change Canvas or Moodle.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (_input: unknown, context: ServerContext): Promise<CallToolResult> => {
      // A session that calls this before its initialized notification arrives is
      // still a connected assistant, so it is recorded here too.
      connected();
      const savedChanges = savedChangeActivity(gateway);
      const report: JsonObject = {
        schema: "morrow.activity.v1",
        observedAt: new Date().toISOString(),
        assistants: sessionActivity(gateway, options.groups),
        groups: groupActivity(options.groups),
        lockedTargets: savedChanges.locked,
        needsPerson: savedChanges.needsPerson,
        bridge: await bridgeActivity(gateway, await health(), context.mcpReq.signal),
      };
      return textAndStructured(summaryText(report), report);
    },
  );
}
