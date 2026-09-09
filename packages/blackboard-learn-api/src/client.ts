import { isJsonObject, type JsonObject } from "@morrow/contracts";
import type { BlackboardApiError, BlackboardPrincipalResolution, BlackboardResponseDiagnostics, BlackboardTenant } from "./types.js";
import { BLACKBOARD_ID, BlackboardApiError as ApiError } from "./types.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_COLLECTION_PAGES = 20;
const MAX_COLLECTION_RECORDS = 5_000;
const DEFAULT_COLLECTION_LIMIT = 100;
const MAX_DIAGNOSTIC_HEADERS = 8;
const MAX_DIAGNOSTIC_HEADER_LENGTH = 200;
const AUTHENTICATED_PRINCIPAL_PATH = "/learn/api/public/v1/users/me";
/** A record, a created record, or a change the tenant accepted without describing it. */
const ACCEPTED_STATUS = new Set([200, 201, 204]);
/** The documented asynchronous course-copy request answers 202 with a task Location. */
const COURSE_COPY_ACCEPTED_STATUS = 202;

/**
 * The response headers Morrow keeps on a failure. Anthology tells an integration
 * to monitor the rate-limit headers a Learn site returns and does not fix their
 * names, so this list is a default a caller replaces with the names its own
 * tenant sends.
 * https://docs.blackboard.com/docs/blackboard/rest-apis/rest-api-best-practices
 * Morrow reads them as diagnostics only and retries nothing because of them.
 */
export const BLACKBOARD_DIAGNOSTIC_HEADERS: readonly string[] = [
  "retry-after",
  "x-rate-limit-limit",
  "x-rate-limit-remaining",
  "x-rate-limit-reset",
];

/**
 * The content fields Morrow asks a Blackboard listing for, and the one level it
 * asks for. The recovery contract pins `recursive=false` and an explicit field
 * list on every content listing (docs/research/blackboard-recovery-contract.md:179).
 * `full` names every field a content projection reads; `structure` leaves out
 * the item text, for a listing that maps a course rather than reading it. Every
 * name here is a documented Blackboard content field, but no tenant Swagger has
 * been read, so which of them a given Learn version answers stays
 * live-unverified.
 * https://docs.blackboard.com/docs/blackboard/rest-apis/advanced/content-handler
 */
export const BLACKBOARD_CONTENT_FIELDS = Object.freeze({
  full: Object.freeze(["id", "parentId", "title", "description", "body", "position", "availability", "contentHandler", "hasChildren"]),
  structure: Object.freeze(["id", "parentId", "title", "position", "availability", "contentHandler", "hasChildren"]),
});

/** One level of a course's content tree, as every Morrow content listing asks for it. */
export const BLACKBOARD_ONE_LEVEL = "recursive=false";

export interface BlackboardClientOptions {
  /** Replaces the default diagnostic header names. At most eight names are read. */
  readonly diagnosticHeaders?: readonly string[];
}

/** One Learn collection read, described instead of concatenated into a query string. */
export interface BlackboardCollectionOptions {
  /** Records per page. Blackboard decides what it actually returns. */
  readonly limit?: number;
  readonly fields?: readonly string[];
  readonly expand?: readonly string[];
  readonly maxPages?: number;
  readonly maxRecords?: number;
  /** Names these records in a refusal a person reads, as in "content" or "roster". */
  readonly label?: string;
  readonly signal?: AbortSignal;
}

/** One file Morrow stages with a Blackboard upload request. */
export interface BlackboardUploadFile {
  readonly filename: string;
  readonly contentType: string;
  /** Bytes over their own buffer, which is what one multipart part is built from. */
  readonly bytes: Uint8Array<ArrayBuffer>;
}

interface TokenRecord {
  readonly accessToken: string;
  readonly expiresAt: number;
}

function abortError(error: unknown): BlackboardApiError | undefined {
  if (error instanceof DOMException && error.name === "AbortError") {
    return new ApiError("blackboard_request_cancelled", "The Blackboard request was cancelled.");
  }
  return undefined;
}

function object(value: unknown, code: ConstructorParameters<typeof ApiError>[0] = "blackboard_response_invalid"): JsonObject {
  if (!isJsonObject(value)) throw new ApiError(code, "Blackboard returned an invalid response.");
  return value;
}

/** What the tenant said about its own limits, bounded and kept as diagnostics. */
function responseDiagnostics(response: Response, names: readonly string[]): BlackboardResponseDiagnostics | undefined {
  const observed: Record<string, string> = {};
  for (const name of names) {
    const value = response.headers.get(name);
    if (typeof value !== "string" || !value.trim()) continue;
    observed[name] = value.trim().slice(0, MAX_DIAGNOSTIC_HEADER_LENGTH);
  }
  return Object.keys(observed).length ? observed : undefined;
}

function responseError(response: Response, diagnosticHeaders: readonly string[]): BlackboardApiError {
  const status = response.status;
  const diagnostics = responseDiagnostics(response, diagnosticHeaders);
  if (status === 401) return new ApiError("blackboard_request_unauthorized", "Blackboard rejected the configured server credential.", status, "not_sent", diagnostics);
  if (status === 429) return new ApiError("blackboard_request_rate_limited", "Blackboard rate-limited this request. The request was not retried.", status, "not_sent", diagnostics);
  return new ApiError("blackboard_request_failed", `Blackboard returned HTTP ${status}. The request was not retried.`, status, "not_sent", diagnostics);
}

/** The response body, or null when Blackboard answered without one. */
async function jsonResponse(response: Response): Promise<JsonObject | null> {
  const length = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    throw new ApiError("blackboard_response_oversized", "Blackboard returned a response that exceeds the safe limit.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new ApiError("blackboard_response_oversized", "Blackboard returned a response that exceeds the safe limit.");
  }
  const text = new TextDecoder().decode(bytes);
  if (response.status === 204 || !text.trim()) return null;
  try { return object(JSON.parse(text) as unknown); }
  catch { throw new ApiError("blackboard_response_invalid", "Blackboard returned invalid JSON."); }
}

function collectionUrl(path: string, tenant: BlackboardTenant, options: BlackboardCollectionOptions): URL {
  const url = new URL(path, tenant.baseUrl);
  url.searchParams.set("limit", String(options.limit ?? DEFAULT_COLLECTION_LIMIT));
  if (options.fields?.length) url.searchParams.set("fields", options.fields.join(","));
  if (options.expand?.length) url.searchParams.set("expand", options.expand.join(","));
  return url;
}

function exactPaginationUrl(raw: unknown, tenant: BlackboardTenant, expectedPath: string): URL | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || !raw) throw new ApiError("blackboard_pagination_refused", "Blackboard returned an invalid pagination link.");
  let url: URL;
  try { url = new URL(raw, tenant.baseUrl); } catch { throw new ApiError("blackboard_pagination_refused", "Blackboard returned an invalid pagination link."); }
  if (url.origin !== new URL(tenant.baseUrl).origin || url.pathname !== expectedPath || url.username || url.password || url.hash) {
    throw new ApiError("blackboard_pagination_refused", "Blackboard returned a pagination link outside this exact course endpoint.");
  }
  return url;
}

function resultsPage(value: JsonObject): { readonly results: readonly JsonObject[]; readonly next?: unknown } {
  if (!Array.isArray(value.results) || value.results.some((entry) => !isJsonObject(entry))) {
    throw new ApiError("blackboard_response_incomplete", "Blackboard returned an incomplete collection response.");
  }
  const paging = value.paging;
  if (paging !== undefined && !isJsonObject(paging)) throw new ApiError("blackboard_response_incomplete", "Blackboard returned invalid paging data.");
  return { results: value.results as readonly JsonObject[], next: isJsonObject(paging) ? paging.nextPage : undefined };
}

export class BlackboardLearnClient {
  private token?: TokenRecord;
  private tokenRequest?: Promise<TokenRecord>;
  /** Held against the exact token record it was read with, so a new token re-reads it. */
  private principal?: { readonly token: TokenRecord; readonly resolution: BlackboardPrincipalResolution };
  private requests = 0;
  private generation = 0;
  private readonly diagnosticHeaders: readonly string[];

  constructor(
    readonly tenant: BlackboardTenant,
    private readonly fetcher: typeof fetch = fetch,
    options: BlackboardClientOptions = {},
  ) {
    this.diagnosticHeaders = (options.diagnosticHeaders || BLACKBOARD_DIAGNOSTIC_HEADERS)
      .slice(0, MAX_DIAGNOSTIC_HEADERS)
      .map((name) => name.toLowerCase());
  }

  /** Every request this client has sent to the tenant, including each credential exchange, so a result can state what it cost. */
  get requestCount(): number {
    return this.requests;
  }

  /**
   * Rises with each new access token. State a caller holds against one
   * credential, such as a prepared course roster, belongs to that credential only, so
   * this number is what a caller compares before it reuses that state.
   */
  get tokenGeneration(): number {
    return this.generation;
  }

  private async accessToken(signal?: AbortSignal): Promise<TokenRecord> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token;
    if (this.tokenRequest) return this.tokenRequest;
    this.tokenRequest = (async () => {
      const url = new URL("/learn/api/public/v1/oauth2/token", this.tenant.baseUrl);
      try {
        this.requests += 1;
        const response = await this.fetcher(url, {
          method: "POST",
          redirect: "manual",
          headers: {
            authorization: `Basic ${Buffer.from(`${this.tenant.applicationKey}:${this.tenant.clientSecret}`, "utf8").toString("base64")}`,
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          body: "grant_type=client_credentials",
          signal,
        });
        if (response.status !== 200) throw responseError(response, this.diagnosticHeaders);
        const payload = await jsonResponse(response);
        if (!payload || typeof payload.access_token !== "string" || !payload.access_token || typeof payload.expires_in !== "number" || !Number.isFinite(payload.expires_in) || payload.expires_in < 1) {
          throw new ApiError("blackboard_response_invalid", "Blackboard returned an invalid OAuth response.");
        }
        const token = { accessToken: payload.access_token, expiresAt: Date.now() + Math.min(payload.expires_in, 3_600) * 1_000 };
        this.generation += 1;
        this.token = token;
        return token;
      } catch (error) { throw abortError(error) || error; }
      finally { this.tokenRequest = undefined; }
    })();
    return this.tokenRequest;
  }

  /**
   * Sends one request to this tenant and nowhere else. A 200, 201 or 204 is an
   * answer; anything else is a failure that carries the tenant's own limit
   * headers as diagnostics and is never retried on them. Only a read may repeat
   * itself after a 401, because a repeated write could apply twice.
   */
  private async request(
    url: URL,
    init: RequestInit,
    signal?: AbortSignal,
    retryUnauthorized = true,
  ): Promise<JsonObject | null> {
    const response = await this.response(url, init, signal, retryUnauthorized);
    if (!ACCEPTED_STATUS.has(response.status)) throw responseError(response, this.diagnosticHeaders);
    return jsonResponse(response);
  }

  /** Sends one authenticated request after proving it stays on this Learn site. */
  private async response(
    url: URL,
    init: RequestInit,
    signal?: AbortSignal,
    retryUnauthorized = true,
  ): Promise<Response> {
    const origin = new URL(this.tenant.baseUrl).origin;
    if (url.origin !== origin || url.username || url.password) {
      throw new ApiError("blackboard_scope_binding_mismatch", "Blackboard request origin does not match this configured tenant.");
    }
    const send = async (): Promise<Response> => {
      const token = await this.accessToken(signal);
      this.requests += 1;
      return this.fetcher(url, {
        ...init,
        redirect: "manual",
        headers: { accept: "application/json", ...init.headers, authorization: `Bearer ${token.accessToken}` },
        signal,
      });
    };
    try {
      let response = await send();
      if (response.status === 401 && retryUnauthorized) {
        this.token = undefined;
        response = await send();
      }
      return response;
    } catch (error) { throw abortError(error) || error; }
  }

  /** The same request for a route whose record Morrow reads, where no body is a failed read. */
  private async requestRecord(
    url: URL,
    init: RequestInit,
    signal?: AbortSignal,
    retryUnauthorized = true,
  ): Promise<JsonObject> {
    const payload = await this.request(url, init, signal, retryUnauthorized);
    if (!payload) throw new ApiError("blackboard_response_invalid", "Blackboard answered this read without a record.");
    return payload;
  }

  /** One JSON write. A write is never repeated after a 401, and a tenant may answer it with no body. */
  private write(method: "POST" | "PUT" | "PATCH", path: string, payload: JsonObject, signal?: AbortSignal): Promise<JsonObject | null> {
    return this.request(new URL(path, this.tenant.baseUrl), {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }, signal, false);
  }

  async get(path: string, signal?: AbortSignal): Promise<JsonObject> {
    return this.requestRecord(new URL(path, this.tenant.baseUrl), { method: "GET" }, signal);
  }

  async patch(path: string, payload: JsonObject, signal?: AbortSignal): Promise<JsonObject | null> {
    return this.write("PATCH", path, payload, signal);
  }

  async post(path: string, payload: JsonObject, signal?: AbortSignal): Promise<JsonObject | null> {
    return this.write("POST", path, payload, signal);
  }

  async put(path: string, payload: JsonObject, signal?: AbortSignal): Promise<JsonObject | null> {
    return this.write("PUT", path, payload, signal);
  }

  /**
   * Starts the documented asynchronous Learn course-copy task. The Location is
   * read with redirects disabled, because a followed redirect would discard the
   * task identifier Morrow must verify before it reports success.
   */
  async startCourseCopy(
    courseId: string,
    targetCourseId: string,
    canonicalCourseId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await this.response(new URL(`/learn/api/public/v2/courses/${encodeURIComponent(courseId)}/copy`, this.tenant.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetCourse: { courseId: targetCourseId } }),
      redirect: "manual",
    }, signal, false);
    if (response.status !== COURSE_COPY_ACCEPTED_STATUS) throw responseError(response, this.diagnosticHeaders);
    return this.courseCopyTaskPath(response.headers.get("location"), canonicalCourseId);
  }

  /**
   * Reads the task returned by `startCourseCopy`. Learn documents 200 while the
   * copy is still running and 303 with the copied course Location when it ends.
   */
  async readCourseCopyTask(taskPath: string, courseId: string, signal?: AbortSignal): Promise<
    { readonly state: "pending" } | { readonly state: "complete"; readonly coursePath: string }
  > {
    const task = new URL(this.courseCopyTaskPath(taskPath, courseId), this.tenant.baseUrl);
    const response = await this.response(task, { method: "GET", redirect: "manual" }, signal);
    if (response.status === 200) {
      await jsonResponse(response);
      return { state: "pending" };
    }
    if (response.status !== 303) throw responseError(response, this.diagnosticHeaders);
    return { state: "complete", coursePath: this.courseCopyTargetPath(response.headers.get("location")) };
  }

  private courseCopyTaskPath(raw: string | null, courseId: string): string {
    if (!raw) throw new ApiError("blackboard_response_invalid", "Blackboard accepted the course copy without a task location.");
    let task: URL;
    try { task = new URL(raw, this.tenant.baseUrl); }
    catch { throw new ApiError("blackboard_response_invalid", "Blackboard returned an invalid course-copy task location."); }
    const expected = `/learn/api/public/v1/courses/${encodeURIComponent(courseId)}/tasks/`;
    const taskId = task.pathname.startsWith(expected) ? task.pathname.slice(expected.length) : "";
    if (task.origin !== new URL(this.tenant.baseUrl).origin || task.username || task.password
      || task.search || task.hash || !taskId || taskId.includes("/")) {
      throw new ApiError("blackboard_response_invalid", "Blackboard returned an invalid course-copy task location.");
    }
    return task.pathname;
  }

  private courseCopyTargetPath(raw: string | null): string {
    if (!raw) throw new ApiError("blackboard_response_invalid", "Blackboard completed the course copy without the copied course location.");
    let course: URL;
    try { course = new URL(raw, this.tenant.baseUrl); }
    catch { throw new ApiError("blackboard_response_invalid", "Blackboard returned an invalid copied-course location."); }
    const segments = course.pathname.split("/").filter(Boolean);
    const valid = segments.length === 6 && segments[0] === "learn" && segments[1] === "api" && segments[2] === "public"
      && /^v[1-3]$/.test(segments[3] || "") && segments[4] === "courses" && Boolean(segments[5]);
    if (course.origin !== new URL(this.tenant.baseUrl).origin || course.username || course.password || course.hash || !valid) {
      throw new ApiError("blackboard_response_invalid", "Blackboard returned an invalid copied-course location.");
    }
    return `${course.pathname}${course.search}`;
  }

  /**
   * Stages one file with Blackboard's upload route, as `multipart/form-data`
   * and behind the same exact-origin guard every other request passes. The
   * bytes go to this tenant and nowhere else, and the request is never repeated
   * after a 401, because a repeated upload would stage the bytes twice. A
   * staged upload is attached to nothing: the caller attaches the id this
   * returns to one exact course item.
   * https://docs.blackboard.com/docs/blackboard/rest-apis/advanced/ultra-assignments
   */
  async upload(path: string, file: BlackboardUploadFile, signal?: AbortSignal): Promise<JsonObject> {
    const form = new FormData();
    // The multipart part name and the upload response shape are not stated by
    // Anthology's public documentation and no tenant Swagger has been read, so
    // the caller reads the response and refuses rather than assumes.
    form.append("file", new Blob([file.bytes], { type: file.contentType }), file.filename);
    const payload = await this.request(new URL(path, this.tenant.baseUrl), { method: "POST", body: form }, signal, false);
    if (!payload) throw new ApiError("blackboard_response_invalid", "Blackboard answered the file upload without a record of it.");
    return payload;
  }

  async del(path: string, signal?: AbortSignal): Promise<JsonObject | null> {
    return this.request(new URL(path, this.tenant.baseUrl), { method: "DELETE" }, signal, false);
  }

  /**
   * Reads one Learn collection to its end, or refuses. Every page has to come
   * from this tenant's origin and this exact path, and a repeated page, a
   * repeated or missing record id, or a page or record ceiling is a refusal.
   * A caller cannot tell a short list from a complete one, so this never
   * returns part of a collection.
   */
  async collect(path: string, options: BlackboardCollectionOptions = {}): Promise<readonly JsonObject[]> {
    const label = options.label || "collection";
    const maxPages = options.maxPages ?? MAX_COLLECTION_PAGES;
    const maxRecords = options.maxRecords ?? MAX_COLLECTION_RECORDS;
    let url = collectionUrl(path, this.tenant, options);
    const expectedPath = url.pathname;
    const visited = new Set<string>();
    const identities = new Set<string>();
    const results: JsonObject[] = [];
    for (let page = 0; page < maxPages; page += 1) {
      if (visited.has(url.href)) throw new ApiError("blackboard_pagination_refused", `Blackboard returned a cyclic ${label} page.`);
      visited.add(url.href);
      const current = resultsPage(await this.requestRecord(url, { method: "GET" }, options.signal));
      for (const entry of current.results) {
        if (typeof entry.id !== "string" || !entry.id || identities.has(entry.id)) {
          throw new ApiError("blackboard_response_incomplete", `Blackboard returned duplicate or invalid ${label} identities.`);
        }
        if (results.length >= maxRecords) {
          throw new ApiError("blackboard_response_incomplete", `Blackboard returned too many ${label} records.`);
        }
        identities.add(entry.id); results.push(entry);
      }
      const next = exactPaginationUrl(current.next, this.tenant, expectedPath);
      if (!next) return results;
      url = next;
    }
    throw new ApiError("blackboard_response_incomplete", `Blackboard ${label} pagination exceeded the safe limit.`);
  }

  /**
   * Reads the Learn account this server credential acts as. Anthology binds a
   * client_credentials token to the Learn site and to the Learn user an
   * administrator selected when the REST integration was installed, so Morrow's
   * own configuration cannot show which account will make a change.
   * https://docs.blackboard.com/docs/blackboard/rest-apis/getting-started/basic-authentication
   * https://docs.blackboard.com/docs/blackboard/rest-apis/getting-started/rest-and-learn
   *
   * Another account is refused here. A tenant that does not answer this read is
   * returned as `unresolved` instead, because "Morrow could not find out" is a
   * different finding from "a different account", and the caller decides what an
   * unresolved account still permits. Whether a given tenant answers this read
   * for a client-credentials token is not settled by Anthology's documentation
   * and has not been tested against a live Learn site.
   */
  async resolveAuthenticatedPrincipal(signal?: AbortSignal): Promise<BlackboardPrincipalResolution> {
    const token = await this.accessToken(signal);
    if (this.principal && this.principal.token === token) return this.principal.resolution;
    const resolution = await this.readAuthenticatedPrincipal(signal);
    this.principal = { token, resolution };
    return resolution;
  }

  private async readAuthenticatedPrincipal(signal?: AbortSignal): Promise<BlackboardPrincipalResolution> {
    let payload: JsonObject;
    try {
      payload = await this.requestRecord(new URL(AUTHENTICATED_PRINCIPAL_PATH, this.tenant.baseUrl), { method: "GET" }, signal);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        return { state: "unresolved", detail: `Blackboard answered the account read with HTTP ${error.status}.` };
      }
      if (error instanceof ApiError && error.code === "blackboard_response_invalid") {
        return { state: "unresolved", detail: "Blackboard did not answer the account read with an account record." };
      }
      throw error;
    }
    if (typeof payload.id !== "string" || !BLACKBOARD_ID.test(payload.id)) {
      return { state: "unresolved", detail: "Blackboard did not name an account in the account read." };
    }
    if (payload.id !== this.tenant.principalId) {
      throw new ApiError("blackboard_account_mismatch", "Blackboard reports that this server credential acts as a different Learn account than the configured integration principal.");
    }
    return { state: "verified", principalId: payload.id };
  }

  async verifyPrincipalAndMembership(courseId: string, signal?: AbortSignal): Promise<void> {
    const principal = await this.get(`/learn/api/public/v1/users/${encodeURIComponent(this.tenant.principalId)}`, signal);
    if (principal.id !== this.tenant.principalId) {
      throw new ApiError("blackboard_account_mismatch", "Blackboard did not return the configured integration principal.");
    }
    const membership = await this.get(`/learn/api/public/v1/courses/${encodeURIComponent(courseId)}/users/${encodeURIComponent(this.tenant.principalId)}`, signal);
    if (membership.courseId !== courseId || membership.userId !== this.tenant.principalId) {
      throw new ApiError("blackboard_membership_mismatch", "Blackboard did not return the configured principal's exact course membership.");
    }
  }

  /** The top level of one course's content, one level only and with the fields Morrow reads. */
  async listContents(courseId: string, signal?: AbortSignal): Promise<readonly JsonObject[]> {
    return this.collect(`/learn/api/public/v1/courses/${encodeURIComponent(courseId)}/contents?${BLACKBOARD_ONE_LEVEL}`, {
      label: "content",
      fields: BLACKBOARD_CONTENT_FIELDS.full,
      signal,
    });
  }

  async listCourseMemberships(courseId: string, signal?: AbortSignal): Promise<readonly JsonObject[]> {
    return this.collect(`/learn/api/public/v1/courses/${encodeURIComponent(courseId)}/users`, { label: "roster", expand: ["user"], signal });
  }
}
