// Morrow Bridge's half of a person's approval. The review server accepts an approval only with a
// signature from the key the runtime sends here over the paired connection. The Bridge signs only
// for a real click in a tab that shows a review from that exact server, so a program that reads
// the review page over HTTP has the form but never the signature.

export const REVIEW_APPROVAL_SIGN_MESSAGE = "morrow_review_approval_sign";
export const REVIEW_APPROVAL_CONTENT_SCRIPT = "src/review-approval-content.js";

const PRESENCE_STORAGE_KEY = "morrowReviewApprovalPresence";
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
 * Signs one approval for the content script in a review tab. Refuses a sender that is not this
 * extension's own content script in the top frame of a review page at the presence origin, and an
 * approve path that is not that same page's.
 */
export async function signReviewApproval(message, sender, presence, extensionId) {
  if (!presence) return { ok: false, code: "review_approval_key_missing" };
  const pagePath = sender?.id === extensionId && sender.tab && sender.frameId === 0
    && (sender.origin === undefined || sender.origin === presence.origin)
    ? reviewPagePath(sender.url, presence) : null;
  if (!pagePath) return { ok: false, code: "review_approval_sender_refused" };
  if (message?.approvePath !== `${pagePath}/approve` || typeof message.nonce !== "string" || !NONCE.test(message.nonce)) {
    return { ok: false, code: "review_approval_request_invalid" };
  }
  return { ok: true, presence: await reviewApprovalProof(presence.key, message.approvePath, message.nonce) };
}

async function storedPresence() {
  const stored = await chrome.storage.session.get(PRESENCE_STORAGE_KEY).catch(() => ({}));
  try {
    return parseReviewApprovalPresence(stored?.[PRESENCE_STORAGE_KEY]);
  } catch {
    return null;
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

/** Registers the worker's listeners. Called once, when the worker module first runs. */
export function installReviewApproval() {
  chrome.webNavigation?.onCompleted?.addListener((details) => {
    if (details?.frameId !== 0 || !Number.isInteger(details.tabId) || details.tabId < 0) return;
    void storedPresence().then((presence) => {
      if (reviewPagePath(details.url, presence)) return injectInto(details.tabId);
      return undefined;
    });
  }, { url: [{ schemes: ["http"], hostEquals: "127.0.0.1" }] });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== REVIEW_APPROVAL_SIGN_MESSAGE) return false;
    storedPresence()
      .then((presence) => signReviewApproval(message, sender, presence, chrome.runtime.id))
      .then(sendResponse, () => sendResponse({ ok: false, code: "review_approval_failed" }));
    return true;
  });
}
