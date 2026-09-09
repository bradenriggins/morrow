export const ITEM_BANK_CREDENTIAL_MAX_AGE_MS = 10 * 60 * 1_000;
export const ITEM_BANK_EXTERNAL_TOOL_ID = "54065";

const API_HOST = /^[^.]+\.quiz-api(?:-[^.]+)*\.instructure\.com$/i;
const LTI_HOST = /^[^.]+\.quiz-lti(?:-[^.]+)*\.instructure\.com$/i;
const CONTEXT_UUID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const COURSE_ID = /^[1-9][0-9]{0,18}$/;
const LAUNCH_NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parsedHttpsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function apiHostFor(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (API_HOST.test(host)) return host;
  if (LTI_HOST.test(host)) return host.replace(".quiz-lti", ".quiz-api");
  return "";
}

export function itemBankApiOriginForFrameUrl(value) {
  const url = parsedHttpsUrl(value);
  const host = url ? apiHostFor(url.hostname) : "";
  return host ? `https://${host}` : "";
}

export function itemBankLaunchUrl(tabUrl, canvasOrigin, courseId) {
  const url = parsedHttpsUrl(tabUrl);
  const origin = parsedHttpsUrl(canvasOrigin);
  const pathCourse = url?.pathname.match(/^\/courses\/([1-9][0-9]{0,18})(?:\/|$)/)?.[1] || "";
  const course = String(courseId || pathCourse);
  if (!url || !origin || origin.href !== `${origin.origin}/` || url.origin !== origin.origin
    || !COURSE_ID.test(course) || pathCourse !== course) return "";
  return `${url.origin}/courses/${course}/external_tools/${ITEM_BANK_EXTERNAL_TOOL_ID}`;
}

/**
 * Returns the two exact optional origins needed for one standard Canvas
 * tenant's Item Banks client. The launch page must expose exactly one matching
 * quiz-lti origin. A custom Canvas domain has no trustworthy tenant label, so
 * it is refused instead of granting access to a guessed host.
 */
export function itemBankPermissionOrigins(frames, canvasOrigin) {
  const canvas = parsedHttpsUrl(canvasOrigin);
  const tenant = canvas?.hostname.match(/^([^.]+)(?:\.(?:beta|test))?\.instructure\.com$/i)?.[1]?.toLowerCase() || "";
  if (!canvas || canvas.href !== `${canvas.origin}/` || !tenant) return [];
  const origins = new Set();
  for (const frame of Array.isArray(frames) ? frames : []) {
    if (!Number.isInteger(frame?.frameId) || frame.frameId <= 0) continue;
    const url = parsedHttpsUrl(frame.url);
    if (!url || !LTI_HOST.test(url.hostname) || url.hostname.split(".")[0].toLowerCase() !== tenant) continue;
    origins.add(url.origin);
  }
  if (origins.size !== 1) return [];
  const ltiOrigin = [...origins][0];
  const apiOrigin = itemBankApiOriginForFrameUrl(ltiOrigin);
  return apiOrigin ? [`${ltiOrigin}/*`, `${apiOrigin}/*`] : [];
}

function requestHeader(headers, name) {
  const expected = name.toLowerCase();
  const matches = (Array.isArray(headers) ? headers : []).filter((header) => String(header?.name || "").toLowerCase() === expected);
  if (matches.length !== 1 || typeof matches[0]?.value !== "string") return "";
  return matches[0].value.trim();
}

/**
 * Capture the credential Canvas's own Item Banks client just sent. Chrome does
 * not expose response bodies to MV3 extensions, but it does expose request
 * headers after the user grants the exact quiz-api origin. The token never
 * leaves service-worker memory.
 */
export function itemBankCredentialFromRequest(details, launch, now = Date.now()) {
  if (!Number.isFinite(now) || String(details?.method || "").toUpperCase() !== "GET"
    || !Number.isInteger(details?.tabId) || details.tabId < 0
    || !Number.isInteger(details?.frameId) || details.frameId <= 0) return null;
  if (!launch || launch.tabId !== details.tabId || !Number.isFinite(launch.launchedAt)
    || launch.launchedAt > now || now - launch.launchedAt > 45_000
    || typeof launch.launchNonce !== "string" || !LAUNCH_NONCE.test(launch.launchNonce)
    || !COURSE_ID.test(String(launch.canvasLocalContextId || ""))) return null;
  const launchedUrl = parsedHttpsUrl(launch.launchUrl);
  if (!launchedUrl || itemBankLaunchUrl(launch.launchUrl, launchedUrl.origin, launch.canvasLocalContextId) !== launch.launchUrl) return null;
  const requestUrl = parsedHttpsUrl(details.url);
  if (!requestUrl || !API_HOST.test(requestUrl.hostname) || requestUrl.pathname !== "/api/banks") return null;
  const contextClaims = requestUrl.searchParams.getAll("course_id");
  const contextUuid = contextClaims.length === 1 ? contextClaims[0] : "";
  if (!CONTEXT_UUID.test(contextUuid)) return null;
  const documentUrl = parsedHttpsUrl(details.documentUrl || details.initiator);
  if (!documentUrl || itemBankApiOriginForFrameUrl(documentUrl.href) !== requestUrl.origin) return null;
  const token = requestHeader(details.requestHeaders, "authorization");
  const authType = requestHeader(details.requestHeaders, "authtype");
  if (token.length < 51 || token.length > 8192 || authType.toLowerCase() !== "signature") return null;
  return Object.freeze({
    tabId: details.tabId,
    frameId: details.frameId,
    apiOrigin: requestUrl.origin,
    token,
    authType: "Signature",
    contextUuid,
    canvasLocalContextId: String(launch.canvasLocalContextId),
    launchUrl: launch.launchUrl,
    launchNonce: launch.launchNonce,
    launchedAt: launch.launchedAt,
    capturedAt: now,
  });
}

export function usableItemBankCredential(credential, expected, now = Date.now()) {
  if (!credential || !expected || !Number.isFinite(now) || !Number.isFinite(expected.launchedAt)) return null;
  const launchedUrl = parsedHttpsUrl(credential.launchUrl);
  if (credential.tabId !== expected.tabId || credential.frameId !== expected.frameId
    || credential.apiOrigin !== expected.apiOrigin
    || credential.canvasLocalContextId !== expected.canvasLocalContextId
    || credential.launchUrl !== expected.launchUrl
    || credential.launchNonce !== expected.launchNonce
    || credential.launchedAt !== expected.launchedAt
    || credential.capturedAt < expected.launchedAt
    || credential.capturedAt > now
    || now - credential.capturedAt > ITEM_BANK_CREDENTIAL_MAX_AGE_MS
    || !COURSE_ID.test(String(credential.canvasLocalContextId || ""))
    || !LAUNCH_NONCE.test(String(credential.launchNonce || ""))
    || !launchedUrl || itemBankLaunchUrl(credential.launchUrl, launchedUrl.origin, credential.canvasLocalContextId) !== credential.launchUrl
    || itemBankApiOriginForFrameUrl(credential.apiOrigin) !== credential.apiOrigin
    || typeof credential.token !== "string" || credential.token.length < 51 || credential.token.length > 8192
    || credential.authType !== "Signature" || !CONTEXT_UUID.test(String(credential.contextUuid || ""))) return null;
  return credential;
}
