import { executeItemBankInPage } from "./item-bank-executor.js";
import { evaluateBrowserReadback, planBrowserReadback } from "./verification.js";
import { executeMoodleInPage } from "./moodle-executor.js";

const PORT = 32147;
const BRIDGE_PATH = "/morrow-bridge/v1";
const PROTOCOL_VERSION = 1;
const RUNTIME_REVISION = "1.0.0-rc.2";
const state = { socket: null, generation: 0, catalog: null, operations: new Map(), reconnectTimer: null };

async function sha256(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function catalog() {
  if (state.catalog) return state.catalog;
  const response = await fetch(chrome.runtime.getURL("generated/canvas-api-catalog.json"));
  const value = await response.json();
  if (value?.schema !== "morrow.canvas-api-catalog.v1" || !Array.isArray(value.operations)) throw new Error("connector_catalog_invalid");
  const moodleResponse = await fetch(chrome.runtime.getURL("generated/moodle-browser-catalog.json"));
  const moodleText = await moodleResponse.text();
  const moodle = JSON.parse(moodleText);
  if (moodle.schema !== "morrow.browser-catalog.v1" || moodle.provider !== "moodle" || !Array.isArray(moodle.operations)
    || moodle.operations.some((operation) => operation.provider !== "moodle" || !operation.toolName.startsWith("moodle_"))) throw new Error("connector_catalog_invalid");
  state.catalog = { ...value, catalogDigest: await sha256(`${value.catalogDigest}\n${await sha256(moodleText)}`) };
  const operations = [...value.operations.map((operation) => ({ ...operation, provider: "canvas" })), ...moodle.operations];
  state.operations = new Map(operations.map((operation) => [operation.toolName, operation]));
  if (state.operations.size !== operations.length) throw new Error("connector_catalog_invalid");
  return state.catalog;
}

function bridgeUrl() {
  return `ws://127.0.0.1:${PORT}${BRIDGE_PATH}`;
}

function httpUrl(path = "") {
  return `http://127.0.0.1:${PORT}${BRIDGE_PATH}${path}`;
}

async function storage() {
  return await chrome.storage.local.get(["token", "bindings", "pairing"]);
}

async function publicBindings() {
  const stored = await storage();
  return await Promise.all((stored.bindings || []).map(async ({ principalId: _principalId, tabId, ...binding }) => ({
    ...binding,
    runtimeVerified: binding.runtimeVerified && await courseTabMatches(await chrome.tabs.get(tabId).catch(() => null), { ...binding, principalId: _principalId, tabId }),
  })));
}

async function courseTabMatches(tab, binding) {
  if (!tab?.url) return false;
  const url = new URL(tab.url);
  if (binding.provider === "moodle") {
    if (url.origin !== binding.origin) return false;
    const [probe] = await chrome.scripting.executeScript({ target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleInPage, args: [JSON.stringify({ mode: "probe" })] }).catch(() => []);
    const profile = probe?.result?.profile;
    return probe?.result?.ok === true && profile?.siteUrl === binding.siteUrl && profile.principalId === binding.principalId
      && (!binding.courseId || profile.courseId === binding.courseId);
  }
  if (binding.provider !== "canvas") return false;
  return url.origin === binding.origin && (!binding.courseId || url.pathname.match(/^\/courses\/([1-9][0-9]*)(?:\/|$)/)?.[1] === binding.courseId);
}

async function publishBindings() {
  const bindings = await publicBindings();
  if (state.socket?.readyState === WebSocket.OPEN && state.generation) {
    state.socket.send(JSON.stringify({ schema: "morrow.bridge.bindings.v1", protocolVersion: PROTOCOL_VERSION, generation: state.generation, bindings, sentAt: Date.now() }));
  }
  void chrome.runtime.sendMessage({ type: "morrow_bridge_status_changed" }).catch(() => undefined);
}

async function canvasTabChanged(tabId) {
  const { bindings = [] } = await storage();
  if (bindings.some((binding) => binding.tabId === tabId)) await publishBindings();
}

async function connectBridge() {
  const stored = await storage();
  if (!stored.token || state.socket?.readyState === WebSocket.OPEN || state.socket?.readyState === WebSocket.CONNECTING) return;
  const api = await catalog();
  const socket = new WebSocket(bridgeUrl());
  state.socket = socket;
  socket.onopen = async () => socket.send(JSON.stringify({
    schema: "morrow.bridge.hello.v1",
    protocolVersion: PROTOCOL_VERSION,
    token: stored.token,
    extensionId: chrome.runtime.id,
    runtimeRevision: RUNTIME_REVISION,
    catalogDigest: api.catalogDigest,
    bindings: await publicBindings(),
    sentAt: Date.now(),
  }));
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    void handleBridgeMessage(message).then(() => {
      if (message?.schema === "morrow.bridge.ready.v1" && state.socket === socket) {
        void chrome.runtime.sendMessage({ type: "morrow_bridge_status_changed" }).catch(() => undefined);
      }
    });
  };
  socket.onclose = (event) => {
    if (state.socket !== socket) return;
    state.socket = null;
    state.generation = 0;
    void chrome.runtime.sendMessage({ type: "morrow_bridge_status_changed" }).catch(() => undefined);
    if (event.code === 4403) {
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
      void (async () => {
        const latest = await storage();
        if (latest.token !== stored.token) return;
        await chrome.alarms.clear("morrow-pairing");
        await chrome.storage.local.remove(["token", "bindings", "pairing"]);
      })();
      return;
    }
    scheduleReconnect();
  };
  socket.onerror = () => undefined;
}

function scheduleReconnect() {
  if (state.reconnectTimer) return;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    void connectBridge();
  }, 2_000);
}

function problem(code, message, recoverable = false) {
  return { schema: "morrow.bridge.problem.v1", code, message, recoverable };
}

function errorMessage(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "Canvas returned an unreadable error.";
  }
}

function sendResult(command, ok, result, failure) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  state.socket.send(JSON.stringify({
    schema: "morrow.bridge.result.v1",
    protocolVersion: PROTOCOL_VERSION,
    requestId: command.requestId,
    operationId: command.operationId,
    generation: command.generation,
    ok,
    ...(ok ? { result } : { problem: failure }),
    completedAt: Date.now(),
  }));
}

async function bindingFor(id) {
  const { bindings = [] } = await storage();
  if (id) return bindings.find((binding) => binding.sourceBindingId === id) || null;
  return bindings.length === 1 ? bindings[0] : null;
}

async function reserveReceipt(command) {
  if (command.kind !== "invoke_write") return true;
  const receipt = command.outerGrant?.effectReceiptId;
  if (!receipt) return false;
  const area = chrome.storage.session || chrome.storage.local;
  const stored = await area.get("usedEffectReceipts");
  const used = new Set(stored.usedEffectReceipts || []);
  if (used.has(receipt)) return false;
  used.add(receipt);
  await area.set({ usedEffectReceipts: [...used].slice(-2_000) });
  return true;
}

async function executeCanvas(binding, operation, args, expiresAt) {
  let sent = false;
  try {
    await chrome.scripting.executeScript({ target: { tabId: binding.tabId, frameIds: [0] }, files: ["src/canvas-content.js"] });
    sent = true;
    return await chrome.tabs.sendMessage(binding.tabId, {
      type: "morrow_canvas_execute",
      operation,
      arguments: args,
      principalId: binding.principalId,
      expiresAt,
    }, { frameId: 0 });
  } catch (error) {
    return { ok: false, sent, outcomeUnknown: sent && !operation.readOnly, error: sent && !operation.readOnly ? "canvas_write_response_unknown" : String(error?.message || error) };
  }
}

async function executeItemBank(binding, operation, args) {
  try {
    const rows = await chrome.scripting.executeScript({
      target: { tabId: binding.tabId, allFrames: true },
      world: "MAIN",
      func: executeItemBankInPage,
      args: [{ operation, arguments: args, principalId: binding.principalId, canvasOrigin: binding.origin, courseId: binding.courseId, contextOnly: true }],
    });
    const matches = rows.filter((row) => row.result?.matched === true);
    if (matches.length !== 1) return { ok: false, sent: false, error: matches.length ? "item_bank_context_ambiguous" : "item_bank_context_not_established" };
    try {
      const [execution] = await chrome.scripting.executeScript({
        target: { tabId: binding.tabId, frameIds: [matches[0].frameId] },
        world: "MAIN",
        func: executeItemBankInPage,
        args: [{ operation, arguments: args, principalId: binding.principalId, canvasOrigin: binding.origin, courseId: binding.courseId }],
      });
      return execution?.result || { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "item_bank_result_missing" };
    } catch {
      return { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "item_bank_execution_interrupted" };
    }
  } catch (error) {
    return { ok: false, sent: false, error: String(error?.message || error) };
  }
}

async function executeOperation(binding, operation, args, expiresAt) {
  if (operation.provider === "moodle") {
    try {
      const [execution] = await chrome.scripting.executeScript({
        target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleInPage,
        // Chrome drops null object fields from scripting arguments unless they are serialized.
        args: [JSON.stringify({ mode: "execute", operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
      });
      return execution?.result || { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_result_missing" };
    } catch {
      return { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_execution_interrupted" };
    }
  }
  return operation.service === "item_bank"
    ? await executeItemBank(binding, operation, args)
    : await executeCanvas(binding, operation, args, expiresAt);
}

async function handleCommand(command) {
  if (command.generation !== state.generation || Date.now() > command.expiresAt) {
    return sendResult(command, false, null, problem("stale_bridge_command", "The bridge command is stale.", false));
  }
  const operation = state.operations.get(command.toolName);
  if (!operation || operation.key !== command.operationKey || operation.readOnly !== (command.kind === "invoke_read")) {
    return sendResult(command, false, null, problem("operation_catalog_mismatch", "The command does not match the connector catalog.", false));
  }
  if (operation.service === "item_bank" && !operation.readOnly && operation.nickname !== "create_bank") {
    return sendResult(command, false, null, problem("item_bank_dependency_review_required", "Changes to an existing Item Bank require a complete dependency and affected-course review. This release cannot yet establish that evidence.", false));
  }
  const binding = await bindingFor(command.sourceBindingId);
  if (!binding?.runtimeVerified || binding.provider !== operation.provider) return sendResult(command, false, null, problem("canvas_binding_required", "Select one current connection for this learning platform.", true));
  const tab = await chrome.tabs.get(binding.tabId).catch(() => null);
  if (!await courseTabMatches(tab, binding)) return sendResult(command, false, null, problem("canvas_binding_stale", "The connected course or account changed. Open the course and connect it again.", true));
  if (!await reserveReceipt(command)) return sendResult(command, false, null, problem("effect_receipt_refused", "The provider effect receipt is missing or was already used.", false));
  const result = await executeOperation(binding, operation, command.arguments || {}, command.expiresAt);
  if (!result?.ok) {
    const unknown = result?.outcomeUnknown === true || (result?.sent === true && command.kind === "invoke_write" && (
      !Number.isInteger(result.status)
      || (operation.provider === "moodle" && result.verification?.status !== "verified" && result.error !== "moodle_form_validation_failed")
    ));
    return sendResult(command, false, null, problem(unknown ? "write_outcome_unknown" : result?.sent === false ? "canvas_request_not_sent" : "canvas_request_failed", errorMessage(result?.error || `Canvas returned HTTP ${result?.status || 0}`).slice(0, 900), !unknown));
  }
  let verification;
  if (command.kind === "invoke_write") {
    const guardedPage = command.arguments?.morrow_page_guard;
    const plan = guardedPage || operation.provider !== "canvas" ? null : planBrowserReadback([...state.operations.values()].filter((entry) => entry.provider === "canvas"), operation, command.arguments || {}, result.data);
    if (operation.provider === "moodle") {
      verification = result.verification || { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_verification_missing" };
    } else if (guardedPage) {
      verification = result.verification || { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "page_verification_missing" };
    } else if (plan) {
      const readback = await executeOperation(binding, plan.readOperation, plan.arguments);
      verification = evaluateBrowserReadback(plan, readback);
    } else {
      verification = { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "no_safe_readback_route" };
    }
  }
  return sendResult(command, true, { schema: "morrow.canvas-browser-result.v1", ...result, provider: operation.provider, ...(verification ? { verification } : {}) }, null);
}

async function handleBridgeMessage(message) {
  if (message?.schema === "morrow.bridge.ready.v1") {
    state.generation = message.generation;
    return;
  }
  if (message?.schema === "morrow.bridge.ping.v1" && message.generation === state.generation) {
    state.socket?.send(JSON.stringify({ schema: "morrow.bridge.pong.v1", protocolVersion: PROTOCOL_VERSION, generation: state.generation, sentAt: Date.now() }));
    return;
  }
  if (message?.schema === "morrow.bridge.command.v1") await handleCommand(message);
}

async function requestPairing() {
  const api = await catalog();
  const response = await fetch(httpUrl("/pair"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ extensionId: chrome.runtime.id, catalogDigest: api.catalogDigest, runtimeRevision: RUNTIME_REVISION }),
  });
  if (!response.ok) {
    if (response.status === 403) {
      const body = await response.json().catch(() => null);
      if (body?.error === "connector_identity_refused") {
        throw new Error("Morrow and Morrow Course Connector versions do not match. Update or reload Morrow Course Connector in Chrome.");
      }
    }
    throw new Error("Morrow MCP is not running on this computer.");
  }
  const pairing = await response.json();
  await chrome.storage.local.set({ pairing });
  await chrome.alarms.create("morrow-pairing", { periodInMinutes: 0.5 });
  await chrome.tabs.create({ url: pairing.approvalUrl });
  return pairing;
}

async function pollPairing() {
  const { pairing } = await storage();
  if (!pairing?.statusUrl || !Number.isFinite(pairing.expiresAt) || Date.now() >= pairing.expiresAt) {
    const latest = await storage();
    if (latest.pairing?.statusUrl !== pairing?.statusUrl) return;
    await chrome.storage.local.remove("pairing");
    await chrome.alarms.clear("morrow-pairing");
    return;
  }
  const response = await fetch(pairing.statusUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ extensionId: chrome.runtime.id }),
  }).catch(() => null);
  if (response?.status === 404 || response?.status === 410) {
    const latest = await storage();
    if (latest.pairing?.statusUrl !== pairing.statusUrl) return;
    await chrome.storage.local.remove("pairing");
    await chrome.alarms.clear("morrow-pairing");
    return;
  }
  if (!response?.ok) return;
  const status = await response.json();
  if (status.status === "approved" && status.token) {
    const latest = await storage();
    if (latest.pairing?.statusUrl !== pairing.statusUrl) return;
    await chrome.storage.local.set({ token: status.token, pairing: null });
    await chrome.alarms.clear("morrow-pairing");
    await connectBridge();
  } else if (status.status === "denied" || Date.now() >= status.expiresAt) {
    const latest = await storage();
    if (latest.pairing?.statusUrl !== pairing.statusUrl) return;
    await chrome.storage.local.set({ pairing: null });
    await chrome.alarms.clear("morrow-pairing");
  }
}

async function permissionOrigins(tabId, tabUrl) {
  const permissionPattern = (value) => {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}/*`;
  };
  const origins = new Set([permissionPattern(tabUrl)]);
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => []);
  for (const frame of frames || []) {
    try {
      const url = new URL(frame.url);
      if (/^[^.]+\.quiz-(?:lti|api)(?:-[^.]+)*\.instructure\.com$/i.test(url.hostname)) origins.add(permissionPattern(url.href));
    } catch {}
  }
  return [...origins];
}

async function connectCourseTab(requestedTabId) {
  const tab = Number.isInteger(requestedTabId)
    ? await chrome.tabs.get(requestedTabId).catch(() => null)
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab?.id || !tab.url?.startsWith("https://")) throw new Error("Open the signed-in course that Morrow should use.");
  const origins = await permissionOrigins(tab.id, tab.url);
  if (!await chrome.permissions.contains({ origins })) throw new Error("Morrow needs access to this exact course site.");
  const [moodle] = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: "MAIN", func: executeMoodleInPage, args: [JSON.stringify({ mode: "probe" })] });
  let profile = moodle?.result?.ok === true ? moodle.result.profile : null;
  if (!profile) {
    if (/^\/(?:ultra|webapps)(?:\/|$)/.test(new URL(tab.url).pathname)) throw new Error("Blackboard browser access is not yet verified in this preview.");
    await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ["src/canvas-content.js"] });
    const probe = await chrome.tabs.sendMessage(tab.id, { type: "morrow_canvas_probe" }, { frameId: 0 });
    if (!probe?.ok) throw new Error("Open a signed-in Canvas or Moodle course.");
    profile = { ...probe.profile, provider: "canvas", principalId: probe.profile.id };
  }
  const digest = await sha256(`${profile.provider}\0${profile.siteUrl || profile.origin}\0${profile.principalId}`);
  const stored = await storage();
  const previous = (stored.bindings || []).find((binding) => binding.principalFingerprint === digest && binding.origin === profile.origin);
  const sessionGeneration = (previous?.sessionGeneration || 0) + 1;
  const binding = {
    sourceBindingId: `${profile.provider}:${digest.slice(0, 20)}:g${sessionGeneration}`,
    provider: profile.provider,
    origin: profile.origin,
    ...(profile.siteUrl ? { siteUrl: profile.siteUrl } : {}),
    principalFingerprint: digest,
    sessionGeneration,
    runtimeVerified: true,
    lastSeenAt: Date.now(),
    ...(profile.courseId ? { courseId: profile.courseId } : {}),
    ...(profile.courseName ? { courseName: profile.courseName } : {}),
    principalId: profile.principalId,
    tabId: tab.id,
  };
  const bindings = [...(stored.bindings || []).filter((candidate) => candidate.principalFingerprint !== digest || candidate.origin !== binding.origin), binding];
  await chrome.storage.local.set({ bindings });
  await publishBindings();
  return binding;
}

async function status() {
  const before = await storage();
  if (before.pairing?.status === "pending") await pollPairing();
  const stored = await storage();
  const bindings = await publicBindings();
  return {
    paired: Boolean(stored.token),
    pairing: stored.pairing?.status === "pending",
    connecting: state.socket?.readyState === WebSocket.CONNECTING || (state.socket?.readyState === WebSocket.OPEN && state.generation === 0),
    connected: state.socket?.readyState === WebSocket.OPEN && state.generation > 0,
    bindingCount: bindings.length,
    bindings: bindings.map((binding) => ({ sourceBindingId: binding.sourceBindingId, provider: binding.provider, origin: binding.origin, siteUrl: binding.siteUrl, courseId: binding.courseId, courseName: binding.courseName, runtimeVerified: binding.runtimeVerified, lastSeenAt: binding.lastSeenAt })),
  };
}

async function disconnectConnector() {
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  const socket = state.socket;
  state.socket = null;
  state.generation = 0;
  socket?.close(1000, "user_disconnected");
  await chrome.alarms.clear("morrow-pairing");
  await chrome.storage.local.remove(["token", "bindings", "pairing"]);
  await (chrome.storage.session || chrome.storage.local).remove("usedEffectReceipts");
  const permissions = await chrome.permissions.getAll();
  const optionalOrigins = (permissions.origins || []).filter((origin) => origin.startsWith("https://"));
  let permissionsRevoked = true;
  if (optionalOrigins.length > 0) {
    try {
      permissionsRevoked = await chrome.permissions.remove({ origins: optionalOrigins });
    } catch {
      permissionsRevoked = false;
    }
  }
  return { disconnected: true, permissionsRevoked };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const run = message?.type === "morrow_pair" ? requestPairing
    : message?.type === "morrow_connect_course" ? () => connectCourseTab(message.tabId)
      : message?.type === "morrow_status" ? status
        : message?.type === "morrow_disconnect" ? disconnectConnector
        : null;
  if (!run) return false;
  Promise.resolve(run()).then((result) => sendResponse({ ok: true, result }), (error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === "morrow-pairing") void pollPairing(); });
chrome.tabs.onRemoved.addListener((tabId) => { void canvasTabChanged(tabId); });
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url) void canvasTabChanged(tabId);
  if (change.status !== "complete" || !tab.url?.startsWith(httpUrl("/pair/"))) return;
  void storage().then(({ pairing }) => {
    if (pairing?.approvalUrl === tab.url) return pollPairing();
  });
});
chrome.runtime.onStartup.addListener(() => { void pollPairing(); void connectBridge(); });
chrome.runtime.onInstalled.addListener(() => { void connectBridge(); });
void pollPairing();
void connectBridge();
