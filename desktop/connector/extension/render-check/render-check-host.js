/**
 * Relays one render-check request between the service worker and the sandboxed
 * render-check page. A service worker has no document, so it cannot hold the
 * sandboxed frame; this offscreen document holds it and passes exactly one
 * request in and one record out.
 *
 * Nothing else happens here: no storage, no network, no Canvas access.
 */

import { RENDER_CHECK_MESSAGE_TYPE, RENDER_CHECK_REPLY_SCHEMA, RENDER_CHECK_REQUEST_SCHEMA } from "./render-check.js";

const REQUEST_TIMEOUT_MS = 10_000;
const REQUEST_RETRY_MS = 200;

const frame = document.getElementById("render-check-sandbox");
const sandboxUrl = chrome.runtime.getURL("render-check/render-check.html");
const pending = new Map();

globalThis.addEventListener("message", (event) => {
  // The sandbox has an opaque origin, so the frame identity is the check that
  // this reply came from the page this document created.
  if (event.source !== frame.contentWindow) return;
  const reply = event.data;
  if (reply?.schema !== RENDER_CHECK_REPLY_SCHEMA || typeof reply.requestId !== "string") return;
  const settle = pending.get(reply.requestId);
  if (!settle) return;
  pending.delete(reply.requestId);
  settle(reply.record);
});

async function renderCheck(field, html) {
  if (frame.src !== sandboxUrl) return null;
  const requestId = crypto.randomUUID();
  const request = { schema: RENDER_CHECK_REQUEST_SCHEMA, requestId, field, html };
  return await new Promise((resolve) => {
    // The sandbox may still be loading when this document is created, and a
    // message sent before it is loaded reaches nothing. Repeating the request
    // until the record arrives keeps that ordering out of the result. The
    // sandbox answers each request it receives, and only the first answer for
    // this id is kept.
    const post = () => { if (pending.has(requestId)) frame.contentWindow?.postMessage(request, "*"); };
    const retry = setInterval(post, REQUEST_RETRY_MS);
    const timer = setTimeout(() => {
      clearInterval(retry);
      pending.delete(requestId);
      resolve(null);
    }, REQUEST_TIMEOUT_MS);
    pending.set(requestId, (record) => { clearInterval(retry); clearTimeout(timer); resolve(record); });
    post();
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== RENDER_CHECK_MESSAGE_TYPE) return false;
  // Only this extension's own service worker may ask for a render check.
  if (sender.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL("src/service-worker.js")) {
    sendResponse({ ok: false });
    return false;
  }
  renderCheck(message.field, message.html).then(
    (record) => sendResponse(record ? { ok: true, record } : { ok: false }),
    () => sendResponse({ ok: false }),
  );
  return true;
});
