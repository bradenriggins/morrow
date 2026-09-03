import { MORROW_GATEWAY_BRIDGE_CONFIG } from './morrow-gateway-bridge.local.js';

export const BRIDGE_PROTOCOL_VERSION = 1;
export const BRIDGE_PATH = '/morrow-bridge/v1';
export const BRIDGE_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
export const BRIDGE_RECONNECT_MIN_MS = 1000;
export const BRIDGE_RECONNECT_MAX_MS = 30000;
export const BRIDGE_KEEPALIVE_MS = 20000;

export const BRIDGE_SCHEMA = Object.freeze({
  hello: 'morrow.bridge.hello.v1',
  ready: 'morrow.bridge.ready.v1',
  command: 'morrow.bridge.command.v1',
  result: 'morrow.bridge.result.v1',
  bindings: 'morrow.bridge.bindings.v1',
  ping: 'morrow.bridge.ping.v1',
  pong: 'morrow.bridge.pong.v1',
});

export function getMorrowGatewayBridgeConfig() {
  const value = MORROW_GATEWAY_BRIDGE_CONFIG;
  if (!value || typeof value !== 'object' || value.enabled !== true) return null;
  const url = String(value.url || '').trim();
  const token = String(value.token || '').trim();
  const donorRevision = String(value.donorRevision || '').trim();
  const catalogDigest = String(value.catalogDigest || '').trim();
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'ws:'
    || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname.toLowerCase())
    || parsed.pathname !== BRIDGE_PATH
    || parsed.search
    || parsed.hash
    || token.length < 32
    || token.length > 512
    || !donorRevision
    || !/^[0-9a-f]{64}$/.test(catalogDigest)
  ) return null;
  return Object.freeze({ url, token, donorRevision, catalogDigest });
}

export function bridgeMessageBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function bridgeSafeErrorMessage(code) {
  const normalized = String(code || '').trim();
  if (normalized === 'bridge_active_conversation_required') {
    return 'Open Morrow and select the intended conversation, then retry the request.';
  }
  if (normalized === 'bridge_binding_ambiguous') {
    return 'More than one Canvas source is active. Select an exact Morrow source binding, then retry.';
  }
  if (normalized === 'bridge_no_live_binding' || normalized === 'bridge_source_binding_unavailable') {
    return 'The requested Canvas source is not currently available in Morrow.';
  }
  if (normalized === 'bridge_command_expired') {
    return 'The local bridge request expired before Morrow began execution.';
  }
  if (normalized === 'bridge_task_not_found' || normalized === 'bridge_task_scope_mismatch') {
    return 'The requested Morrow task is unavailable in the active conversation.';
  }
  return 'The Morrow extension could not complete this local bridge request. Inspect Morrow for the current source or task state.';
}

export function bridgeSafeProblem(code, recoverable) {
  return {
    schema: 'morrow.bridge.problem.v1',
    code: String(code || 'bridge_extension_error').slice(0, 120),
    message: bridgeSafeErrorMessage(code),
    recoverable: recoverable === true,
  };
}

export function bridgeError(code, message) {
  return Object.assign(new Error(message), { code });
}
