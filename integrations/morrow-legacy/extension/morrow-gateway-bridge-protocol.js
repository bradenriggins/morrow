import { MORROW_GATEWAY_BRIDGE_CONFIG } from './morrow-gateway-bridge.local.js';

export const BRIDGE_PROTOCOL_VERSION = 1;
export const BRIDGE_PATH = '/morrow-bridge/v1';
export const BRIDGE_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
export const BRIDGE_RECONNECT_MIN_MS = 1000;
export const BRIDGE_RECONNECT_MAX_MS = 30000;
export const BRIDGE_KEEPALIVE_MS = 20000;
export const LEGACY_BRIDGE_OVERLAY_DIGEST = 'c08c88dee4a3f526109b03a1f88341beb6277d7b41dcd57d47f8972dd0a6bf15';

export const BRIDGE_SCHEMA = Object.freeze({
  authenticate: 'morrow.bridge.authenticate.v1',
  challenge: 'morrow.bridge.challenge.v1',
  hello: 'morrow.bridge.hello.v1',
  ready: 'morrow.bridge.ready.v1',
  command: 'morrow.bridge.command.v1',
  result: 'morrow.bridge.result.v1',
  bindings: 'morrow.bridge.bindings.v1',
  ping: 'morrow.bridge.ping.v1',
  pong: 'morrow.bridge.pong.v1',
  cancel: 'morrow.bridge.cancel.v1',
});

export function legacyBridgeRuntimeRevision(donorRevision) {
  const revision = String(donorRevision || '').trim();
  if (!revision) throw new TypeError('donor revision is required');
  return `${revision}:${LEGACY_BRIDGE_OVERLAY_DIGEST}`;
}

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

export function bridgeAuthentication({ config, extensionId, sentAt = Date.now() }) {
  return {
    schema: BRIDGE_SCHEMA.authenticate,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    clientNonce: Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join(''),
    extensionId,
    runtimeRevision: legacyBridgeRuntimeRevision(config.donorRevision),
    catalogDigest: config.catalogDigest,
    sentAt,
  };
}

function bridgeProofPayload(direction, authentication, serverNonce) {
  return JSON.stringify([
    `morrow.bridge.${direction}-proof.v1`, BRIDGE_PROTOCOL_VERSION, BRIDGE_PATH,
    authentication.clientNonce, serverNonce, authentication.extensionId,
    authentication.runtimeRevision, authentication.catalogDigest,
  ]);
}

export async function bridgeProof(token, direction, authentication, serverNonce) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const value = await crypto.subtle.sign('HMAC', key, encoder.encode(bridgeProofPayload(direction, authentication, serverNonce)));
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function sameBridgeProof(expected, actual) {
  if (!/^[0-9a-f]{64}$/.test(expected) || !/^[0-9a-f]{64}$/.test(actual)) return false;
  let different = 0;
  for (let index = 0; index < expected.length; index += 1) different |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  return different === 0;
}

export async function bridgeHello({ config, authentication, challenge, bindings, sentAt = Date.now() }) {
  return {
    schema: BRIDGE_SCHEMA.hello,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    clientNonce: authentication.clientNonce,
    serverNonce: challenge.serverNonce,
    clientProof: await bridgeProof(config.token, 'client', authentication, challenge.serverNonce),
    extensionId: authentication.extensionId,
    runtimeRevision: authentication.runtimeRevision,
    catalogDigest: authentication.catalogDigest,
    bindings,
    sentAt,
  };
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
  if (normalized === 'request_cancelled_before_dispatch') {
    return 'Morrow cancelled the local bridge request before the staged change started.';
  }
  if (normalized === 'write_outcome_unknown') {
    return 'Morrow may have staged the requested change before cancellation. Inspect the existing task before repeating it.';
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

export function parseBridgeCancellation(value, generation) {
  if (
    !value || typeof value !== 'object' || Array.isArray(value)
    || value.schema !== BRIDGE_SCHEMA.cancel
    || value.protocolVersion !== BRIDGE_PROTOCOL_VERSION
    || Object.keys(value).some((key) => !['schema', 'protocolVersion', 'requestId', 'operationId', 'generation', 'cancelledAt'].includes(key))
    || typeof value.requestId !== 'string'
    || !/^[A-Za-z0-9_.:@-]{8,160}$/.test(value.requestId)
    || typeof value.operationId !== 'string'
    || !/^[A-Za-z0-9_.:@-]{8,160}$/.test(value.operationId)
    || !Number.isSafeInteger(value.generation)
    || value.generation !== generation
    || !Number.isSafeInteger(value.cancelledAt)
  ) return null;
  return value;
}

export function bridgeError(code, message) {
  return Object.assign(new Error(message), { code });
}
