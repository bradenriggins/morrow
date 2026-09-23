// Morrow Bridge's half of a person's approval. The review server accepts an approval only with a
// signature from the key the runtime sends here over the paired connection. The Bridge signs only
// for a real click in a tab that shows a review from that exact server, so a program that reads
// the review page over HTTP has the form but never the signature.

export const REVIEW_APPROVAL_SIGN_MESSAGE = "morrow_review_approval_sign";
export const REVIEW_APPROVAL_CONTENT_SCRIPT = "src/review-approval-content.js";
export const REVIEW_LEARNER_NAMES_MESSAGE = "morrow_review_learner_names";
export const REVIEW_LEARNER_NAMES_CHANGED_MESSAGE = "morrow_review_learner_names_changed";

const PRESENCE_STORAGE_KEY = "morrowReviewApprovalPresence";
const LEARNER_NAMES_STORAGE_KEY = "morrowReviewLearnerNames";
const LEARNER_NAME_REVIEW_PATH = /^\/(?:operations|batches)\/[A-Za-z0-9_.:@-]{8,160}$/;
const LEARNER_LABEL = /^Student A[1-9][0-9]{0,5}$/;
const MAX_LEARNER_NAME_REVIEWS = 20;
const MAX_LEARNER_NAMES = 300;
const PROOF_CONTEXT = "morrow.review-approval.v1";
const PRESENCE_ORIGIN = /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/;
const PRESENCE_KEY = /^[A-Za-z0-9_-]{43}$/;
const REVIEW_PATH = /^\/(?:operations|batches)\/[A-Za-z0-9_.%-]{1,480}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;

/** The same rule as `normalizeBridgeUiState` in packages/bridge-protocol applies to `presence`. */
export function parseReviewApprovalPresence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !["origin", "key"].includes(key))
    || typeof value.origin !== "string" || !PRESENCE_ORIGIN.test(value.origin)
    || typeof value.key !== "string" || !PRESENCE_KEY.test(value.key)) {
    throw new Error("ui_state_invalid");
  }
  return { origin: value.origin, key: value.key };
}

/**
 * The same rule as `normalizeBridgeUiState` in packages/bridge-protocol applies to `learnerNames`:
 * each review path once, and 1 to 300 Morrow learner labels with a name for each.
 */
export function parseReviewLearnerNames(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_LEARNER_NAME_REVIEWS) throw new Error("ui_state_invalid");
  const paths = new Set();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).some((key) => !["path", "names"].includes(key))
      || typeof entry.path !== "string" || !LEARNER_NAME_REVIEW_PATH.test(entry.path) || paths.has(entry.path)
      || !entry.names || typeof entry.names !== "object" || Array.isArray(entry.names)) {
      throw new Error("ui_state_invalid");
    }
    const labels = Object.keys(entry.names);
    if (!labels.length || labels.length > MAX_LEARNER_NAMES) throw new Error("ui_state_invalid");
    const names = {};
    for (const label of labels) {
      const name = entry.names[label];
      if (!LEARNER_LABEL.test(label) || typeof name !== "string" || !name.trim() || name.length > 120) throw new Error("ui_state_invalid");
      names[label] = name;
    }
    paths.add(entry.path);
    return { path: entry.path, names };
  });
}

function base64UrlBytes(text) {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesBase64Url(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Matches `reviewApprovalProof` in packages/mcp-server/src/approval-server.ts. */
export async function reviewApprovalProof(key, approvePath, nonce) {
  const cryptoKey = await crypto.subtle.importKey("raw", base64UrlBytes(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(`${PROOF_CONTEXT}\n${approvePath}\n${nonce}`));
  return bytesBase64Url(signature);
}

/** The review page path in a tab at the presence origin, or null for any other page. */
export function reviewPagePath(url, presence) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!presence || parsed.origin !== presence.origin || parsed.search || parsed.hash || !REVIEW_PATH.test(parsed.pathname)) return null;
  return parsed.pathname;
}

/**
 * Signs one approval, or one close-out of a change Morrow could not settle, for the content
 * script in a review tab. Refuses a sender that is not this extension's own content script in the
 * top frame of a review page at the presence origin, and a path that is not that same page's
 * approve form or, on a single change's page, its close form.
 */
export async function signReviewApproval(message, sender, presence, extensionId) {
  if (!presence) return { ok: false, code: "review_approval_key_missing" };
  const pagePath = contentScriptReviewPath(sender, presence, extensionId);
  if (!pagePath) return { ok: false, code: "review_approval_sender_refused" };
  const signable = message?.approvePath === `${pagePath}/approve`
    || (pagePath.startsWith("/operations/") && message?.approvePath === `${pagePath}/close`);
  if (!signable || typeof message.nonce !== "string" || !NONCE.test(message.nonce)) {
    return { ok: false, code: "review_approval_request_invalid" };
  }
  return { ok: true, presence: await reviewApprovalProof(presence.key, message.approvePath, message.nonce) };
}

/** The sender's own review page path, or null unless it is this extension's top-frame script there. */
function contentScriptReviewPath(sender, presence, extensionId) {
  return presence && sender?.id === extensionId && sender.tab && sender.frameId === 0
    && (sender.origin === undefined || sender.origin === presence.origin)
    ? reviewPagePath(sender.url, presence) : null;
}

/**
 * The names for the review the asking tab shows, and only that review. A tab address carries the
 * id encoded, so the lookup decodes it to the path form the runtime sends.
 */
export function reviewLearnerNamesFor(sender, entries, presence, extensionId) {
  const pagePath = contentScriptReviewPath(sender, presence, extensionId);
  if (!pagePath) return { ok: false, names: {} };
  let decoded;
  try {
    decoded = decodeURIComponent(pagePath);
  } catch {
    return { ok: false, names: {} };
  }
  const entry = entries.find((candidate) => candidate.path === decoded);
  return { ok: true, names: entry ? { ...entry.names } : {} };
}

async function storedPresence() {
  const stored = await chrome.storage.session.get(PRESENCE_STORAGE_KEY).catch(() => ({}));
  try {
    return parseReviewApprovalPresence(stored?.[PRESENCE_STORAGE_KEY]);
  } catch {
    return null;
  }
}

async function storedLearnerNames() {
  const stored = await chrome.storage.session.get(LEARNER_NAMES_STORAGE_KEY).catch(() => ({}));
  try {
    return parseReviewLearnerNames(stored?.[LEARNER_NAMES_STORAGE_KEY]);
  } catch {
    return [];
  }
}

async function injectInto(tabId) {
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: [REVIEW_APPROVAL_CONTENT_SCRIPT] }).catch(() => undefined);
}

/**
 * Keeps the key in session storage, which Chrome holds in memory only and never shows to a
 * content script, then readies any review tab that opened before the key arrived.
 */
export async function storeReviewApprovalPresence(presence) {
  await chrome.storage.session.set({ [PRESENCE_STORAGE_KEY]: presence });
  const tabs = await chrome.tabs.query({ url: "http://127.0.0.1/*" }).catch(() => []);
  await Promise.all(tabs.filter((tab) => Number.isInteger(tab.id) && reviewPagePath(tab.url, presence)).map((tab) => injectInto(tab.id)));
}

/** Forgets the key when the paired connection ends; the runtime sends it again on the next review. */
export async function clearReviewApprovalPresence() {
  await chrome.storage.session.remove(PRESENCE_STORAGE_KEY).catch(() => undefined);
}

/** Tells each open review tab to ask again for its names, readying a tab that has no script yet. */
async function announceLearnerNamesChanged(presence) {
  if (!presence) return;
  const tabs = await chrome.tabs.query({ url: "http://127.0.0.1/*" }).catch(() => []);
  await Promise.all(tabs.filter((tab) => Number.isInteger(tab.id) && reviewPagePath(tab.url, presence)).map(async (tab) => {
    await injectInto(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: REVIEW_LEARNER_NAMES_CHANGED_MESSAGE }, { frameId: 0 }).catch(() => undefined);
  }));
}

/**
 * Keeps who each learner label is, for the reviews the runtime names now, in session storage. The
 * runtime sends the whole map each time, so a review that ended is simply absent.
 */
export async function storeReviewLearnerNames(entries) {
  if (entries.length) await chrome.storage.session.set({ [LEARNER_NAMES_STORAGE_KEY]: entries });
  else await chrome.storage.session.remove(LEARNER_NAMES_STORAGE_KEY);
  await announceLearnerNamesChanged(await storedPresence());
}

/** Forgets every name when the paired connection ends, and has open review tabs show labels again. */
export async function clearReviewLearnerNames() {
  const presence = await storedPresence();
  await chrome.storage.session.remove(LEARNER_NAMES_STORAGE_KEY).catch(() => undefined);
  await announceLearnerNamesChanged(presence).catch(() => undefined);
}

/** Answers the review-tab content script's request for the names on its own page. */
export function handleReviewLearnerNamesMessage(message, sender, sendResponse) {
  if (message?.type !== REVIEW_LEARNER_NAMES_MESSAGE) return false;
  Promise.all([storedPresence(), storedLearnerNames()])
    .then(([presence, entries]) => reviewLearnerNamesFor(sender, entries, presence, chrome.runtime.id))
    .then(sendResponse, () => sendResponse({ ok: false, names: {} }));
  return true;
}

/**
 * Answers one sign request from the review-tab content script. The worker's own message listener
 * calls this, so the worker keeps one listener for every message.
 */
export function handleReviewApprovalMessage(message, sender, sendResponse) {
  if (message?.type !== REVIEW_APPROVAL_SIGN_MESSAGE) return false;
  storedPresence()
    .then((presence) => signReviewApproval(message, sender, presence, chrome.runtime.id))
    .then(sendResponse, () => sendResponse({ ok: false, code: "review_approval_failed" }));
  return true;
}

/** Registers the worker's navigation listener. Called once, when the worker module first runs. */
export function installReviewApproval() {
  chrome.webNavigation?.onCompleted?.addListener((details) => {
    if (details?.frameId !== 0 || !Number.isInteger(details.tabId) || details.tabId < 0) return;
    void storedPresence().then((presence) => {
      if (reviewPagePath(details.url, presence)) return injectInto(details.tabId);
      return undefined;
    });
  }, { url: [{ schemes: ["http"], hostEquals: "127.0.0.1" }] });
}
