import { executeItemBankInPage } from "./item-bank-executor.js";
import { evaluateBrowserReadback, planBrowserReadback } from "./verification.js";

const PORT = 32147;
const BRIDGE_PATH = "/morrow-bridge/v1";
const PROTOCOL_VERSION = 1;
const RUNTIME_REVISION = "1.0.0-rc.0";
const state = { socket: null, generation: 0, catalog: null, operations: new Map(), reconnectTimer: null };

async function catalog() {
  if (state.catalog) return state.catalog;
  const response = await fetch(chrome.runtime.getURL("generated/canvas-api-catalog.json"));
  const value = await response.json();
  if (value?.schema !== "morrow.canvas-api-catalog.v1" || !Array.isArray(value.operations)) throw new Error("connector_catalog_invalid");
  state.catalog = value;
  state.operations = new Map(value.operations.map((operation) => [operation.toolName, operation]));
  return value;
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
  return (stored.bindings || []).map(({ principalId: _principalId, tabId: _tabId, ...binding }) => binding);
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
  socket.onmessage = (event) => void handleBridgeMessage(JSON.parse(event.data));
  socket.onclose = () => {
    if (state.socket === socket) state.socket = null;
    state.generation = 0;
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

async function executeCanvas(binding, operation, args) {
  try {
    await chrome.scripting.executeScript({ target: { tabId: binding.tabId, frameIds: [0] }, files: ["src/canvas-content.js"] });
    return await chrome.tabs.sendMessage(binding.tabId, {
      type: "morrow_canvas_execute",
      operation,
      arguments: args,
      principalId: binding.principalId,
    }, { frameId: 0 });
  } catch (error) {
    return { ok: false, sent: false, error: String(error?.message || error) };
  }
}

async function executeItemBank(binding, operation, args) {
  try {
    const rows = await chrome.scripting.executeScript({
      target: { tabId: binding.tabId, allFrames: true },
      world: "MAIN",
      func: executeItemBankInPage,
      args: [{ operation, arguments: args, principalId: binding.principalId, canvasOrigin: binding.origin, courseId: binding.courseId }],
    });
    const matches = rows.map((row) => row.result).filter((result) => result?.matched === true);
    return matches.length === 1 ? matches[0] : { ok: false, sent: false, error: matches.length ? "item_bank_context_ambiguous" : "item_bank_context_not_established" };
  } catch (error) {
    return { ok: false, sent: false, error: String(error?.message || error) };
  }
}

async function executeOperation(binding, operation, args) {
  return operation.service === "item_bank"
    ? await executeItemBank(binding, operation, args)
    : await executeCanvas(binding, operation, args);
}

async function handleCommand(command) {
  if (command.generation !== state.generation || Date.now() > command.expiresAt) {
    return sendResult(command, false, null, problem("stale_bridge_command", "The bridge command is stale.", false));
  }
  const operation = state.operations.get(command.toolName);
  if (!operation || operation.key !== command.operationKey || operation.readOnly !== (command.kind === "invoke_read")) {
    return sendResult(command, false, null, problem("operation_catalog_mismatch", "The command does not match the connector catalog.", false));
  }
  const binding = await bindingFor(command.sourceBindingId);
  if (!binding?.runtimeVerified) return sendResult(command, false, null, problem("canvas_binding_required", "Select one connected Canvas account.", true));
  const tab = await chrome.tabs.get(binding.tabId).catch(() => null);
  if (!tab?.url || new URL(tab.url).origin !== binding.origin) return sendResult(command, false, null, problem("canvas_binding_stale", "The connected Canvas tab is no longer available.", true));
  if (!await reserveReceipt(command)) return sendResult(command, false, null, problem("effect_receipt_refused", "The provider effect receipt is missing or was already used.", false));
  const result = await executeOperation(binding, operation, command.arguments || {});
  if (!result?.ok) {
    const unknown = result?.outcomeUnknown === true || (result?.sent === true && command.kind === "invoke_write" && !Number.isInteger(result.status));
    return sendResult(command, false, null, problem(unknown ? "write_outcome_unknown" : "canvas_request_failed", errorMessage(result?.error || `Canvas returned HTTP ${result?.status || 0}`).slice(0, 900), !unknown));
  }
  let verification;
  if (command.kind === "invoke_write") {
    const plan = planBrowserReadback([...state.operations.values()], operation, command.arguments || {}, result.data);
    if (plan) {
      const readback = await executeOperation(binding, plan.readOperation, plan.arguments);
      verification = evaluateBrowserReadback(plan, readback);
    } else {
      verification = { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "no_safe_readback_route" };
    }
  }
  return sendResult(command, true, { schema: "morrow.canvas-browser-result.v1", ...result, ...(verification ? { verification } : {}) }, null);
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
  if (!response.ok) throw new Error("Morrow MCP is not running on this computer.");
  const pairing = await response.json();
  await chrome.storage.local.set({ pairing });
  await chrome.alarms.create("morrow-pairing", { periodInMinutes: 0.5 });
  await chrome.tabs.create({ url: pairing.approvalUrl });
  return pairing;
}

async function pollPairing() {
  const { pairing } = await storage();
  if (!pairing?.statusUrl) return;
  const response = await fetch(pairing.statusUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ extensionId: chrome.runtime.id }),
  }).catch(() => null);
  if (!response?.ok) return;
  const status = await response.json();
  if (status.status === "approved" && status.token) {
    await chrome.storage.local.set({ token: status.token, pairing: null });
    await chrome.alarms.clear("morrow-pairing");
    await connectBridge();
  } else if (status.status === "denied" || Date.now() >= status.expiresAt) {
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

async function connectCanvasTab(requestedTabId) {
  const tab = Number.isInteger(requestedTabId)
    ? await chrome.tabs.get(requestedTabId).catch(() => null)
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab?.id || !tab.url?.startsWith("https://")) throw new Error("Open the signed-in Canvas course that Morrow should use.");
  const origins = await permissionOrigins(tab.id, tab.url);
  if (!await chrome.permissions.contains({ origins })) throw new Error("Morrow needs access to this exact Canvas site.");
  await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ["src/canvas-content.js"] });
  const probe = await chrome.tabs.sendMessage(tab.id, { type: "morrow_canvas_probe" }, { frameId: 0 });
  if (!probe?.ok) throw new Error("This tab is not a signed-in Canvas page.");
  const material = new TextEncoder().encode(`${probe.profile.origin}\0${probe.profile.id}`);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", material)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const stored = await storage();
  const previous = (stored.bindings || []).find((binding) => binding.principalFingerprint === digest && binding.origin === probe.profile.origin);
  const sessionGeneration = (previous?.sessionGeneration || 0) + 1;
  const binding = {
    sourceBindingId: `canvas:${digest.slice(0, 20)}:g${sessionGeneration}`,
    provider: "canvas",
    origin: probe.profile.origin,
    principalFingerprint: digest,
    sessionGeneration,
    runtimeVerified: true,
    lastSeenAt: Date.now(),
    ...(probe.profile.courseId ? { courseId: probe.profile.courseId } : {}),
    principalId: probe.profile.id,
    tabId: tab.id,
  };
  const bindings = [...(stored.bindings || []).filter((candidate) => candidate.principalFingerprint !== digest || candidate.origin !== binding.origin), binding];
  await chrome.storage.local.set({ bindings });
  if (state.socket?.readyState === WebSocket.OPEN && state.generation) {
    state.socket.send(JSON.stringify({ schema: "morrow.bridge.bindings.v1", protocolVersion: PROTOCOL_VERSION, generation: state.generation, bindings: await publicBindings(), sentAt: Date.now() }));
  }
  return binding;
}

async function status() {
  const stored = await storage();
  return {
    paired: Boolean(stored.token),
    pairing: stored.pairing?.status === "pending",
    connected: state.socket?.readyState === WebSocket.OPEN && state.generation > 0,
    bindingCount: (stored.bindings || []).length,
    bindings: (stored.bindings || []).map((binding) => ({ sourceBindingId: binding.sourceBindingId, origin: binding.origin, courseId: binding.courseId, runtimeVerified: binding.runtimeVerified })),
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
    : message?.type === "morrow_connect_canvas" ? () => connectCanvasTab(message.tabId)
      : message?.type === "morrow_status" ? status
        : message?.type === "morrow_disconnect" ? disconnectConnector
        : null;
  if (!run) return false;
  Promise.resolve(run()).then((result) => sendResponse({ ok: true, result }), (error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === "morrow-pairing") void pollPairing(); });
chrome.runtime.onStartup.addListener(() => { void pollPairing(); void connectBridge(); });
chrome.runtime.onInstalled.addListener(() => { void connectBridge(); });
void pollPairing();
void connectBridge();
