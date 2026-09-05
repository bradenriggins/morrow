import { open } from "node:fs/promises";
import { isJsonObject, sha256Json, type JsonObject, type UpstreamTool } from "@morrow/contracts";
import * as z from "zod/v4";
import type { LmsApiClient, LmsApiOperation, LmsProvider } from "./lms-api-types.js";

const Connection = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  label: z.string().trim().min(1).max(160),
  provider: z.enum(["moodle", "blackboard"]),
  baseUrl: z.string().url(),
  token: z.string().min(8).max(16_384).regex(/^[^\s]+$/),
  userId: z.string().min(1).max(160).optional(),
}).strict();
export type LmsConnection = z.infer<typeof Connection>;

export function parseLmsConnections(value: unknown): readonly LmsConnection[] {
  const parsed = z.object({
    schema: z.literal("morrow.lms-connections.v1"),
    connections: z.array(Connection).max(20),
  }).strict().parse(value);
  const ids = new Set<string>();
  return parsed.connections.map((connection) => {
    if (ids.has(connection.id)) throw new Error("Each connection needs a different name.");
    ids.add(connection.id);
    const url = new URL(connection.baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
      || (connection.provider === "blackboard" && url.pathname !== "/")) {
      throw new Error("Use the secure address of the learning platform without sign-in details.");
    }
    if (connection.provider === "blackboard" && !connection.userId) {
      throw new Error("The Blackboard connection needs the user_id returned during sign-in.");
    }
    return { ...connection, baseUrl: url.href.replace(/\/$/, "") };
  });
}

export async function loadLmsConnections(path: string): Promise<readonly LmsConnection[]> {
  try {
    const file = await open(path, "r");
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 400_000 || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
        throw new Error("The saved learning-platform connection must be a private file.");
      }
      return parseLmsConnections(JSON.parse(await file.readFile("utf8")));
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("Morrow could not load the saved learning-platform connections.");
  }
}

function formValue(form: URLSearchParams, key: string, value: unknown): void {
  if (Array.isArray(value)) value.forEach((entry, index) => formValue(form, `${key}[${index}]`, entry));
  else if (isJsonObject(value)) Object.entries(value).forEach(([field, entry]) => formValue(form, `${key}[${field}]`, entry));
  else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    form.append(key, typeof value === "boolean" ? value ? "1" : "0" : String(value));
  } else throw new Error("This request has an unsupported value.");
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("json")) {
    await response.body?.cancel();
    throw new Error("The learning platform did not return a complete result. Check the connection and your access.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 2_000_000) throw new Error("This result is too large. Ask for a smaller part of the course.");
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function clientFor(connection: LmsConnection, signal: AbortSignal, fetcher: typeof fetch): LmsApiClient {
  return {
    baseUrl: connection.baseUrl,
    principalId: connection.userId || "",
    signal,
    async moodle(functionName, args) {
      if (connection.provider !== "moodle" || !/^[a-z][a-z0-9_]+$/.test(functionName)) throw new Error("Wrong learning platform.");
      const form = new URLSearchParams({ wstoken: connection.token, wsfunction: functionName, moodlewsrestformat: "json", moodlewssettingraw: "true" });
      Object.entries(args).forEach(([key, value]) => formValue(form, key, value));
      const result = await boundedJson(await fetcher(`${connection.baseUrl}/webservice/rest/server.php`, {
        method: "POST", body: form, signal, redirect: "error", headers: { accept: "application/json" },
      }));
      if (isJsonObject(result) && (result.exception || result.errorcode)) throw new Error("Moodle refused this request. Check the connection and your course access.");
      return result;
    },
    async blackboard(path, method = "GET", body) {
      if (connection.provider !== "blackboard" || !path.startsWith("/learn/api/public/") || path.includes("\\")) throw new Error("Wrong learning platform.");
      const url = new URL(path, connection.baseUrl);
      if (url.origin !== new URL(connection.baseUrl).origin || !url.pathname.startsWith("/learn/api/public/")) throw new Error("Wrong learning platform.");
      return boundedJson(await fetcher(url, {
        method, signal, redirect: "error", headers: { authorization: `Bearer ${connection.token}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }));
    },
  };
}

async function authorize(client: LmsApiClient, connection: LmsConnection, operation: LmsApiOperation): Promise<LmsApiClient> {
  if (connection.provider === "moodle") {
    const info = await client.moodle("core_webservice_get_site_info", {});
    if (!isJsonObject(info) || !Number.isSafeInteger(info.userid) || Number(info.userid) < 1
      || typeof info.siteurl !== "string" || info.siteurl.replace(/\/$/, "") !== connection.baseUrl
      || !Array.isArray(info.functions)) throw new Error("Morrow could not confirm this Moodle account.");
    const functions = new Set(info.functions.filter(isJsonObject).map((entry) => entry.name));
    if (operation.requiredFunctions?.some((name) => !functions.has(name))) throw new Error("This Moodle connection does not include the requested action.");
    return { ...client, principalId: String(info.userid) };
  }
  const identity = await client.blackboard(`/learn/api/public/v1/users/uuid:${encodeURIComponent(connection.userId!)}?fields=id`);
  const ownMemberships = await client.blackboard("/learn/api/public/v1/users/me/courses?limit=1&fields=userId");
  if (!isJsonObject(identity) || typeof identity.id !== "string" || !/^_[0-9]+_[0-9]+$/.test(identity.id)
    || !isJsonObject(ownMemberships) || !Array.isArray(ownMemberships.results) || ownMemberships.results.length !== 1
    || !isJsonObject(ownMemberships.results[0]) || ownMemberships.results[0].userId !== identity.id) {
    throw new Error("Morrow could not confirm this Blackboard account.");
  }
  return { ...client, principalId: identity.id };
}

export function lmsTool(operation: LmsApiOperation): UpstreamTool {
  const changing = Boolean(operation.change);
  const properties = isJsonObject(operation.inputSchema.properties) ? operation.inputSchema.properties : {};
  return {
    name: operation.name, title: operation.title, description: operation.description,
    inputSchema: {
      ...operation.inputSchema,
      properties: {
        ...properties, connection_id: { type: "string", minLength: 1, maxLength: 64 },
        ...(changing ? {
          expected_digest: { type: "string", pattern: "^[0-9a-f]{64}$", description: "snapshot_digest from the exact preceding item read." },
          expected_connection: { type: "string", pattern: "^[0-9a-f]{64}$", description: "connection_digest from that same read." },
          _morrow: { type: "object", additionalProperties: true },
        } : {}),
      },
      required: [...(Array.isArray(operation.inputSchema.required) ? operation.inputSchema.required : []), "connection_id", ...(changing ? ["expected_digest", "expected_connection"] : [])],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: !changing, destructiveHint: false, idempotentHint: !changing, openWorldHint: true },
    capability: {
      provider: operation.provider, family: "course-content", sourcePath: operation.documentation, sourceExport: operation.name,
      sourceDigest: sha256Json({ name: operation.name, schema: operation.inputSchema, documentation: operation.documentation }),
      behavior: { readOnly: !changing, mutating: changing, supportsDryRun: changing, supportsReadback: true, supportsBatch: false, requiresBrowser: false, requiresLiveCanvas: false },
      authority: { scopeClass: "course", approvalClass: changing ? "standard" : "none", dataClass: "course" },
      route: { backend: "lms-api", ...(operation.reviewTool ? { planBackend: operation.reviewTool } : {}), comparator: "exact-requested-fields" },
      profiles: {
        "private-full": { state: "supported" },
        "public-canvas": { state: "profile_limited", reason: "This is a Moodle or Blackboard connection, not a Canvas connection." },
        sandbox: { state: "profile_limited", reason: "This action needs a configured learning platform." },
        "read-only": { state: changing ? "profile_limited" : "supported" },
      },
    },
  };
}

export class LmsApiRuntime {
  constructor(
    private readonly connections: readonly LmsConnection[],
    readonly operations: readonly LmsApiOperation[],
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  connectionList(): JsonObject {
    return { schema: "morrow.lms-connections.v1", connections: this.connections.map(({ id, label, provider, baseUrl }) => ({ id, label, provider, baseUrl })), checked: false };
  }

  async call(name: string, args: JsonObject, parentSignal?: AbortSignal): Promise<JsonObject> {
    let sent = false;
    let applying = false;
    let step = "connection";
    let provider: LmsProvider | undefined;
    try {
      const operation = this.operations.find((entry) => entry.name === name);
      const connection = this.connections.find((entry) => entry.id === args.connection_id && entry.provider === operation?.provider);
      if (!operation || !connection) throw new Error("Add this learning-platform connection in Morrow before using it.");
      provider = connection.provider;
      step = "approval";
      const controls = isJsonObject(args._morrow) ? args._morrow : {};
      const grant = isJsonObject(controls.outer_grant) ? controls.outer_grant : {};
      if (operation.change && (grant.dispatch_attempt !== 1 || typeof controls.operation_id !== "string"
        || ![grant.plan_digest, grant.approval_grant_digest].every((value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value))
        || typeof grant.effect_receipt_id !== "string" || !grant.effect_receipt_id || typeof grant.gateway_process_id !== "string" || !grant.gateway_process_id)) {
        throw new Error("This change needs your approval in Morrow.");
      }
      const { connection_id: _connection, expected_digest: _expected, expected_connection: _account, _morrow: _controls, ...domainArgs } = args;
      const signal = parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
      signal.throwIfAborted();
      step = "access";
      const client = await authorize(clientFor(connection, signal, async (...request) => {
        if (applying) sent = true;
        return this.fetcher(...request);
      }), connection, operation);
      const connectionDigest = sha256Json({ ...connection, principalId: client.principalId });
      step = "account";
      if (operation.change && args.expected_connection !== connectionDigest) throw new Error("The account changed. Read the item again before requesting a change.");
      step = "read";
      const before = await operation.read(client, domainArgs);
      if (!operation.change) return {
        schema: "morrow.lms-api.result.v1", ok: true, provider, resultState: "read",
        data: before.data, targets: [{ field: "connection_id", label: "Account", name: connection.label }, ...(before.targets || [])], snapshot_digest: sha256Json(before.data), connection_digest: connectionDigest,
        checked_at: new Date().toISOString(),
      };
      step = "changed";
      if (args.expected_digest !== sha256Json(before.data)) throw new Error("This item changed since it was read. Read it again and review a new request.");
      signal.throwIfAborted();
      step = "write";
      applying = true;
      await operation.change.apply(client, domainArgs, before);
      applying = false;
      const after = await operation.read(client, domainArgs);
      const verified = operation.change.matches(before, after, domainArgs);
      return {
        schema: "morrow.lms-api.result.v1", ok: true, provider, resultState: verified ? "verified" : "applied_or_unknown",
        data: after.data, targets: after.targets || [],
        verification: { schema: "morrow.lms-verification.v1", status: verified ? "verified" : "mismatch", checked_at: new Date().toISOString(), readback_digest: sha256Json(after.data) },
        limitations: ["Morrow checked for newer edits before sending. The platform does not provide an atomic edit lock for this action."],
      };
    } catch {
      const messages: Record<string, string> = {
        connection: "Add this Moodle or Blackboard connection in Morrow before using it.",
        approval: "This change needs your approval in Morrow. Nothing was sent.",
        access: "Morrow could not confirm access to this action. Check the saved connection and your course access.",
        account: "The connected account changed. Read the item again before requesting a change.",
        read: "Morrow could not read the complete item. Check your course access and ask for a smaller part if needed.",
        changed: "This item changed since it was read. Nothing was changed by Morrow. Read it again and review a new request.",
        write: "Morrow did not send this change. The selected item or requested content is not supported by this action.",
      };
      return {
        schema: "morrow.lms-api.result.v1", ok: false, ...(provider ? { provider } : {}),
        resultState: sent ? "applied_or_unknown" : "not_sent",
        code: sent ? "result_unconfirmed" : `${step}_unavailable`,
        message: sent ? "Morrow could not confirm this change. Check the saved request. Do not repeat it." : messages[step],
      };
    }
  }
}
