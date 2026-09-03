/**
 * Local gateway adapter for the frozen Morrow legacy extension.
 *
 * Reads use the existing donor runtime. Writes are staged into the existing
 * Morrow approval and task system. This module never approves or dispatches a
 * provider mutation by itself.
 */
import { currentMorrowBridgeBindings } from './morrow-gateway-bridge-bindings.js';
import {
  BRIDGE_KEEPALIVE_MS,
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_RECONNECT_MAX_MS,
  BRIDGE_RECONNECT_MIN_MS,
  BRIDGE_SCHEMA,
  bridgeMessageBytes,
  bridgeSafeProblem,
  getMorrowGatewayBridgeConfig,
} from './morrow-gateway-bridge-protocol.js';
import { handleMorrowGatewayBridgeCommand } from './morrow-gateway-bridge-runtime.js';

let socket = null;
let generation = 0;
let reconnectDelay = BRIDGE_RECONNECT_MIN_MS;
let reconnectTimer = null;
let keepaliveTimer = null;
let stopped = false;

function send(value) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  if (bridgeMessageBytes(value) > BRIDGE_MAX_MESSAGE_BYTES) return false;
  socket.send(JSON.stringify(value));
  return true;
}

function sendBindings() {
  if (!generation) return false;
  return send({
    schema: BRIDGE_SCHEMA.bindings,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    generation,
    bindings: currentMorrowBridgeBindings(),
    sentAt: Date.now(),
  });
}

async function onMessage(event) {
  let command;
  try {
    if (typeof event.data !== 'string' || new TextEncoder().encode(event.data).byteLength > BRIDGE_MAX_MESSAGE_BYTES) {
      throw new Error('invalid bridge message');
    }
    command = JSON.parse(event.data);
  } catch {
    socket?.close(4400, 'invalid_message');
    return;
  }
  if (command?.schema === BRIDGE_SCHEMA.ready) {
    if (
      command.protocolVersion !== BRIDGE_PROTOCOL_VERSION
      || !Number.isSafeInteger(command.generation)
      || command.generation < 1
      || command.catalogDigest !== getMorrowGatewayBridgeConfig()?.catalogDigest
    ) {
      socket?.close(4403, 'bridge_ready_mismatch');
      return;
    }
    generation = command.generation;
    reconnectDelay = BRIDGE_RECONNECT_MIN_MS;
    sendBindings();
    return;
  }
  if (command?.schema === BRIDGE_SCHEMA.ping) {
    if (command.generation === generation) {
      send({
        schema: BRIDGE_SCHEMA.pong,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        generation,
        sentAt: Date.now(),
      });
      sendBindings();
    }
    return;
  }
  if (command?.schema !== BRIDGE_SCHEMA.command) return;
  try {
    const result = await handleMorrowGatewayBridgeCommand(command, generation);
    send({
      schema: BRIDGE_SCHEMA.result,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId: command.requestId,
      operationId: command.operationId,
      generation,
      ok: true,
      result: result && typeof result === 'object' ? result : { value: result ?? null },
      completedAt: Date.now(),
    });
  } catch (error) {
    const code = error?.code || 'bridge_extension_error';
    send({
      schema: BRIDGE_SCHEMA.result,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId: String(command.requestId || ''),
      operationId: String(command.operationId || ''),
      generation,
      ok: false,
      problem: bridgeSafeProblem(
        code,
        !['bridge_write_not_admitted', 'bridge_read_not_admitted', 'bridge_command_invalid'].includes(code),
      ),
      completedAt: Date.now(),
    });
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
  if (stopped || !current || socket) return;
  try {
    socket = new WebSocket(current.url);
  } catch {
    socket = null;
    scheduleReconnect();
    return;
  }
  socket.addEventListener('open', () => {
    send({
      schema: BRIDGE_SCHEMA.hello,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      token: current.token,
      extensionId: chrome.runtime.id,
      donorRevision: current.donorRevision,
      catalogDigest: current.catalogDigest,
      bindings: currentMorrowBridgeBindings(),
      sentAt: Date.now(),
    });
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      send({
        schema: BRIDGE_SCHEMA.pong,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        generation: Math.max(1, generation),
        sentAt: Date.now(),
      });
      sendBindings();
    }, BRIDGE_KEEPALIVE_MS);
  });
  socket.addEventListener('message', (event) => void onMessage(event));
  socket.addEventListener('error', () => undefined);
  socket.addEventListener('close', () => {
    socket = null;
    generation = 0;
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    keepaliveTimer = null;
    scheduleReconnect();
  });
}

export function installMorrowGatewayBridge({ readyPromise = Promise.resolve() } = {}) {
  if (!getMorrowGatewayBridgeConfig()) return false;
  stopped = false;
  Promise.resolve(readyPromise).finally(() => connect());
  return true;
}

export function stopMorrowGatewayBridge() {
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  keepaliveTimer = null;
  socket?.close(1000, 'bridge_stopped');
  socket = null;
  generation = 0;
}
