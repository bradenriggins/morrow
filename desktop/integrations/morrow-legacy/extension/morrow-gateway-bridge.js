/**
 * Local gateway adapter for the frozen Morrow legacy extension.
 *
 * Reads use the existing donor runtime. Writes are staged into the existing
 * Morrow approval and task system. This module never approves or dispatches a
 * provider mutation by itself.
 */
import {
  LEGACY_BRIDGE_OVERLAY_DIGEST as BINDINGS_OVERLAY_DIGEST,
  currentMorrowBridgeBindings,
} from './morrow-gateway-bridge-bindings.js';
import {
  BRIDGE_KEEPALIVE_MS,
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_RECONNECT_MAX_MS,
  BRIDGE_RECONNECT_MIN_MS,
  BRIDGE_SCHEMA,
  LEGACY_BRIDGE_OVERLAY_DIGEST as PROTOCOL_OVERLAY_DIGEST,
  bridgeAuthentication,
  bridgeHello,
  bridgeMessageBytes,
  bridgeProof,
  bridgeSafeProblem,
  getMorrowGatewayBridgeConfig,
  parseBridgeCancellation,
  sameBridgeProof,
} from './morrow-gateway-bridge-protocol.js';
import {
  LEGACY_BRIDGE_OVERLAY_DIGEST as RUNTIME_OVERLAY_DIGEST,
  handleMorrowGatewayBridgeCommand,
} from './morrow-gateway-bridge-runtime.js';

export const LEGACY_BRIDGE_OVERLAY_DIGEST = 'c08c88dee4a3f526109b03a1f88341beb6277d7b41dcd57d47f8972dd0a6bf15';

let connection = null;
let reconnectDelay = BRIDGE_RECONNECT_MIN_MS;
let reconnectTimer = null;
let keepaliveTimer = null;
let stopped = false;
let installEpoch = 0;

function isCurrent(owner) {
  return connection === owner && !owner.lifecycle.signal.aborted;
}

function send(owner, value) {
  if (!isCurrent(owner) || owner.socket.readyState !== WebSocket.OPEN) return false;
  if (bridgeMessageBytes(value) > BRIDGE_MAX_MESSAGE_BYTES) return false;
  owner.socket.send(JSON.stringify(value));
  return true;
}

async function sendBindings(owner) {
  if (!owner.generation) return false;
  const bindings = await currentMorrowBridgeBindings();
  return send(owner, {
    schema: BRIDGE_SCHEMA.bindings,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    generation: owner.generation,
    bindings,
    sentAt: Date.now(),
  });
}

function sendResult(owner, command, ok, result, problem) {
  return send(owner, {
    schema: BRIDGE_SCHEMA.result,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    requestId: String(command.requestId || ''),
    operationId: String(command.operationId || ''),
    generation: owner.generation,
    ok,
    ...(ok ? { result: result && typeof result === 'object' ? result : { value: result ?? null } } : { problem }),
    completedAt: Date.now(),
  });
}

function abortOwnedCommands(owner) {
  owner.lifecycle.abort();
  for (const active of owner.commands.values()) active.controller.abort();
  owner.commands.clear();
}

async function onMessage(event, owner) {
  if (!isCurrent(owner)) return;
  let command;
  try {
    if (typeof event.data !== 'string' || new TextEncoder().encode(event.data).byteLength > BRIDGE_MAX_MESSAGE_BYTES) {
      throw new Error('invalid bridge message');
    }
    command = JSON.parse(event.data);
  } catch {
    owner.socket.close(4400, 'invalid_message');
    return;
  }
  if (command?.schema === BRIDGE_SCHEMA.challenge && !owner.serverAuthenticated) {
    const valid = command.protocolVersion === BRIDGE_PROTOCOL_VERSION
      && command.clientNonce === owner.authentication.clientNonce
      && /^[0-9a-f]{64}$/.test(String(command.serverNonce || ''))
      && /^[0-9a-f]{64}$/.test(String(command.serverProof || ''))
      && Number.isSafeInteger(command.issuedAt)
      && Math.abs(Date.now() - command.issuedAt) <= 30000;
    const expected = valid ? await bridgeProof(owner.config.token, 'server', owner.authentication, command.serverNonce) : '';
    if (!isCurrent(owner)) return;
    if (!valid || !sameBridgeProof(expected, command.serverProof)) {
      owner.socket.close(4403, 'bridge_server_identity_refused');
      return;
    }
    owner.serverAuthenticated = true;
    send(owner, await bridgeHello({
      config: owner.config,
      authentication: owner.authentication,
      challenge: command,
      bindings: await currentMorrowBridgeBindings(),
    }));
    return;
  }
  if (command?.schema === BRIDGE_SCHEMA.ready) {
    if (
      !owner.serverAuthenticated
      || command.protocolVersion !== BRIDGE_PROTOCOL_VERSION
      || !Number.isSafeInteger(command.generation)
      || command.generation < 1
      || command.catalogDigest !== owner.config.catalogDigest
    ) {
      owner.socket.close(4403, 'bridge_ready_mismatch');
      return;
    }
    owner.generation = command.generation;
    reconnectDelay = BRIDGE_RECONNECT_MIN_MS;
    await sendBindings(owner);
    return;
  }
  if (command?.schema === BRIDGE_SCHEMA.ping) {
    if (command.generation === owner.generation) {
      send(owner, {
        schema: BRIDGE_SCHEMA.pong,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        generation: owner.generation,
        sentAt: Date.now(),
      });
      await sendBindings(owner);
    }
    return;
  }
  const cancellation = parseBridgeCancellation(command, owner.generation);
  if (cancellation) {
    const active = owner.commands.get(cancellation.requestId);
    if (!active || active.command.operationId !== cancellation.operationId) return;
    active.responded = true;
    active.controller.abort();
    sendResult(owner, active.command, false, null, active.effectPossible
      ? bridgeSafeProblem('write_outcome_unknown', false)
      : bridgeSafeProblem('request_cancelled_before_dispatch', true));
    return;
  }
  if (command?.schema !== BRIDGE_SCHEMA.command || !owner.serverAuthenticated || !owner.generation) return;
  if (owner.commands.has(command.requestId)) {
    owner.socket.close(4400, 'duplicate_request');
    return;
  }
  const active = {
    command,
    controller: new AbortController(),
    effectPossible: false,
    responded: false,
  };
  owner.commands.set(command.requestId, active);
  try {
    const result = await handleMorrowGatewayBridgeCommand(command, owner.generation, {
      signal: active.controller.signal,
      markEffectPossible: () => { active.effectPossible = true; },
    });
    if (isCurrent(owner) && owner.commands.get(command.requestId) === active && !active.responded) {
      active.responded = true;
      sendResult(owner, command, true, result, null);
    }
  } catch (error) {
    if (isCurrent(owner) && owner.commands.get(command.requestId) === active && !active.responded) {
      active.responded = true;
      const code = error?.code || 'bridge_extension_error';
      sendResult(owner, command, false, null, bridgeSafeProblem(
        code,
        !['bridge_write_not_admitted', 'bridge_read_not_admitted', 'bridge_command_invalid'].includes(code),
      ));
    }
  } finally {
    if (owner.commands.get(command.requestId) === active) owner.commands.delete(command.requestId);
  }
}

function scheduleReconnect() {
  if (stopped || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(BRIDGE_RECONNECT_MAX_MS, reconnectDelay * 2);
}

function connect() {
  const current = getMorrowGatewayBridgeConfig();
  if (stopped || !current || connection) return;
  let nextSocket;
  try {
    nextSocket = new WebSocket(current.url);
  } catch {
    scheduleReconnect();
    return;
  }
  const owner = {
    socket: nextSocket,
    config: current,
    authentication: bridgeAuthentication({ config: current, extensionId: chrome.runtime.id }),
    serverAuthenticated: false,
    generation: 0,
    lifecycle: new AbortController(),
    commands: new Map(),
  };
  connection = owner;
  nextSocket.addEventListener('open', () => {
    if (!isCurrent(owner)) return;
    send(owner, owner.authentication);
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => {
      if (!isCurrent(owner) || owner.socket.readyState !== WebSocket.OPEN) return;
      send(owner, {
        schema: BRIDGE_SCHEMA.pong,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        generation: Math.max(1, owner.generation),
        sentAt: Date.now(),
      });
      void sendBindings(owner);
    }, BRIDGE_KEEPALIVE_MS);
  });
  nextSocket.addEventListener('message', (event) => void onMessage(event, owner));
  nextSocket.addEventListener('error', () => undefined);
  nextSocket.addEventListener('close', () => {
    if (connection !== owner) return;
    connection = null;
    abortOwnedCommands(owner);
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    keepaliveTimer = null;
    scheduleReconnect();
  });
}

export function installMorrowGatewayBridge({ readyPromise = Promise.resolve() } = {}) {
  if (
    LEGACY_BRIDGE_OVERLAY_DIGEST !== PROTOCOL_OVERLAY_DIGEST
    || BINDINGS_OVERLAY_DIGEST !== PROTOCOL_OVERLAY_DIGEST
    || RUNTIME_OVERLAY_DIGEST !== PROTOCOL_OVERLAY_DIGEST
  ) return false;
  if (!getMorrowGatewayBridgeConfig()) return false;
  const epoch = ++installEpoch;
  stopped = false;
  Promise.resolve(readyPromise).finally(() => {
    if (epoch === installEpoch) connect();
  });
  return true;
}

export function stopMorrowGatewayBridge() {
  installEpoch += 1;
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  keepaliveTimer = null;
  const owner = connection;
  connection = null;
  if (!owner) return;
  abortOwnedCommands(owner);
  owner.socket.close(1000, 'bridge_stopped');
}
