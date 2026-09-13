import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseBridgeAuthenticate, parseBridgeHello } from '../../packages/bridge-protocol/dist/index.js';
import { SourceMcpPrivacyBoundary } from '../../packages/gateway-core/dist/index.js';
import {
  LEGACY_BRIDGE_OVERLAY_FILES,
  patchBackground,
  renderLocalConfig,
  unpatchBackground,
} from '../lib/legacy-bridge-overlay.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PINNED_DONOR_REVISION = '7275bfbc1c24dd6baff58f9435f1ce5a50fbb5d4';
const fixture = `import { recoverSignedCourseReadinessRootCheckpoint } from './domains/launch/course-health-journey.js';\n\nif (requiredAuthoritiesReady) {\n  try {\n    setupMessageRouter();\n  } catch (err) {}\n}\n`;

async function overlayDigest() {
  const hash = createHash('sha256');
  for (const filename of LEGACY_BRIDGE_OVERLAY_FILES) {
    const source = await readFile(resolve(ROOT, 'integrations/morrow-legacy/extension', filename), 'utf8');
    const normalized = source.replace(
      /(LEGACY_BRIDGE_OVERLAY_DIGEST\s*=\s*['"])[0-9a-f]{64}(['"])/,
      `$1${'0'.repeat(64)}$2`,
    );
    hash.update(filename).update('\0').update(normalized).update('\0');
  }
  return hash.digest('hex');
}

test('background overlay patches and removes exactly', () => {
  const patched = patchBackground(fixture);
  assert.match(patched, /installMorrowGatewayBridge/);
  assert.equal(patchBackground(patched), patched);
  assert.equal(unpatchBackground(patched), fixture);
  assert.throws(
    () => unpatchBackground(patched.replace('installMorrowGatewayBridge', 'unknownUserFunction')),
    /exact installed blocks/u,
  );
});

test('local config never accepts a remote endpoint', () => {
  assert.throws(() => renderLocalConfig({
    url: 'ws://example.com/morrow-bridge/v1',
    token: 'x'.repeat(40),
    donorRevision: 'revision',
    catalogDigest: 'a'.repeat(64),
  }), /loopback/);
  const rendered = renderLocalConfig({
    url: 'ws://127.0.0.1:32145/morrow-bridge/v1',
    token: 'x'.repeat(40),
    donorRevision: 'revision',
    catalogDigest: 'a'.repeat(64),
  });
  assert.match(rendered, /127\.0\.0\.1/);
});

test('overlay contains only the reviewed module set and no model-callable approval path', async () => {
  assert.deepEqual(LEGACY_BRIDGE_OVERLAY_FILES, [
    'morrow-gateway-bridge.js',
    'morrow-gateway-bridge-bindings.js',
    'morrow-gateway-bridge-protocol.js',
    'morrow-gateway-bridge-runtime.js',
  ]);
  const contents = await Promise.all(LEGACY_BRIDGE_OVERLAY_FILES.map((filename) => (
    readFile(resolve(ROOT, 'integrations/morrow-legacy/extension', filename), 'utf8')
  )));
  const source = contents.join('\n');
  assert.match(source, /stageChatTask/);
  assert.doesNotMatch(source, /runChatTaskAction|approveChatTask|confirmChatTask/);
  assert.match(source, /127\.0\.0\.1/);
  assert.match(source, /runtimeVerified/);
});

test('overlay hello uses the canonical Bridge wire schema', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'morrow-legacy-hello-'));
  try {
    await writeFile(resolve(directory, 'package.json'), '{"type":"module"}\n');
    await copyFile(
      resolve(ROOT, 'integrations/morrow-legacy/extension/morrow-gateway-bridge-protocol.js'),
      resolve(directory, 'morrow-gateway-bridge-protocol.mjs'),
    );
    await writeFile(resolve(directory, 'morrow-gateway-bridge.local.js'), [
      'export const MORROW_GATEWAY_BRIDGE_CONFIG = Object.freeze({',
      '  enabled: true,',
      '  url: "ws://127.0.0.1:32145/morrow-bridge/v1",',
      `  token: "${'t'.repeat(40)}",`,
      '  donorRevision: "revision-1",',
      `  catalogDigest: "${'a'.repeat(64)}"`,
      '});',
      '',
    ].join('\n'));
    const protocol = await import(`${pathToFileURL(resolve(directory, 'morrow-gateway-bridge-protocol.mjs')).href}?test=${Date.now()}`);
    const config = protocol.getMorrowGatewayBridgeConfig();
    const authentication = protocol.bridgeAuthentication({
      config,
      extensionId: 'b'.repeat(32),
      sentAt: 1,
    });
    const emitted = await protocol.bridgeHello({
      config,
      authentication,
      challenge: { serverNonce: 'c'.repeat(64) },
      bindings: [],
      sentAt: 1,
    });

    assert.deepEqual(parseBridgeAuthenticate(authentication), authentication);
    assert.equal(Object.hasOwn(authentication, 'token'), false);
    assert.equal(Object.hasOwn(authentication, 'bindings'), false);
    assert.equal(emitted.runtimeRevision, `revision-1:${protocol.LEGACY_BRIDGE_OVERLAY_DIGEST}`);
    assert.equal(Object.hasOwn(emitted, 'token'), false);
    assert.equal(Object.hasOwn(emitted, 'donorRevision'), false);
    assert.deepEqual(parseBridgeHello(emitted), emitted);
    assert.throws(() => parseBridgeHello({ ...emitted, donorRevision: 'revision-1' }), /invalid schema/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('overlay source bytes and MCP runtime share one content identity', async () => {
  const digest = await overlayDigest();
  const identity = await readFile(resolve(ROOT, 'packages/legacy-bridge-mcp/src/identity.ts'), 'utf8');
  for (const filename of LEGACY_BRIDGE_OVERLAY_FILES) {
    const source = await readFile(resolve(ROOT, 'integrations/morrow-legacy/extension', filename), 'utf8');
    assert.match(source, new RegExp(`LEGACY_BRIDGE_OVERLAY_DIGEST = '${digest}'`), filename);
  }
  assert.match(identity, new RegExp(`LEGACY_BRIDGE_OVERLAY_DIGEST = "${digest}"`));
});

test('legacy startup example uses the exact pinned donor revision', async () => {
  const example = JSON.parse(await readFile(resolve(ROOT, 'morrow.upstreams.with-legacy-bridge.example.json'), 'utf8'));
  const donorManifest = JSON.parse(await readFile(resolve(ROOT, 'docs/sources/donor-manifest.json'), 'utf8'));
  const donor = donorManifest.sources.find((source) => source.id === 'morrow-legacy');
  const legacy = example.upstreams.find((source) => source.id === 'morrow-legacy');
  assert.equal(donor.commit, PINNED_DONOR_REVISION);
  assert.equal(legacy.env.MORROW_LEGACY_EXPECTED_REVISION, PINNED_DONOR_REVISION);
  assert.match(example.disposition, new RegExp(PINNED_DONOR_REVISION));
});

test('legacy binding projection supplies the complete public privacy identity', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'morrow-legacy-binding-'));
  try {
    await mkdir(resolve(directory, 'providers/canvas'), { recursive: true });
    await mkdir(resolve(directory, 'chat-task-manager'), { recursive: true });
    await writeFile(resolve(directory, 'package.json'), '{"type":"module"}\n');
    for (const filename of ['morrow-gateway-bridge-bindings.js', 'morrow-gateway-bridge-protocol.js']) {
      await copyFile(resolve(ROOT, 'integrations/morrow-legacy/extension', filename), resolve(directory, filename));
    }
    await writeFile(resolve(directory, 'morrow-gateway-bridge.local.js'), [
      'export const MORROW_GATEWAY_BRIDGE_CONFIG = Object.freeze({',
      '  enabled: true,',
      '  url: "ws://127.0.0.1:32145/morrow-bridge/v1",',
      `  token: "${'t'.repeat(40)}",`,
      '  donorRevision: "revision-1",',
      `  catalogDigest: "${'a'.repeat(64)}"`,
      '});',
      '',
    ].join('\n'));
    await writeFile(resolve(directory, 'state.js'), [
      'export const state = {};',
      'export function getLiveProviderBindings() { return globalThis.__morrowLegacyBindings || []; }',
      '',
    ].join('\n'));
    await writeFile(resolve(directory, 'execution-runtime.js'), 'export async function buildExecutionRuntimeSnapshot() { return {}; }\n');
    await writeFile(resolve(directory, 'providers/canvas/session-registry.js'), [
      'export function getCanvasSession(id) { return globalThis.__morrowLegacySessions?.get(id) || null; }',
      '',
    ].join('\n'));
    await writeFile(resolve(directory, 'chat-task-manager/helpers.js'), 'export function classifyOperationResult() { return "notStarted"; }\n');
    globalThis.__morrowLegacyBindings = [{
      provider: 'canvas', tabId: 4, bindingId: 'binding-42', sessionId: 'session-42',
      canvasBase: 'https://canvas.example.edu', courseId: '42', courseName: 'Biology',
      runtimeVerified: true, lastBoundAt: 5,
    }, {
      provider: 'canvas', tabId: 5, bindingId: 'binding-incomplete', sessionId: 'session-incomplete',
      canvasBase: 'https://canvas.example.edu', courseId: '43', runtimeVerified: true,
    }];
    globalThis.__morrowLegacySessions = new Map([['session-42', {
      canvasBase: 'https://canvas.example.edu', runtimeVerified: true,
      userProfile: { id: '9123' }, authorityEpoch: 17,
    }]]);
    const module = await import(`${pathToFileURL(resolve(directory, 'morrow-gateway-bridge-bindings.js')).href}?test=${Date.now()}`);
    const bindings = await module.currentMorrowBridgeBindings();
    assert.equal(bindings.length, 1);
    assert.deepEqual(bindings[0], {
      sourceBindingId: 'binding-42',
      provider: 'canvas',
      courseId: '42',
      courseName: 'Biology',
      origin: 'https://canvas.example.edu',
      principalFingerprint: bindings[0].principalFingerprint,
      sessionGeneration: 17,
      catalogDigest: 'a'.repeat(64),
      runtimeVerified: true,
      lastSeenAt: 5,
    });
    assert.match(bindings[0].principalFingerprint, /^[0-9a-f]{64}$/);

    const boundary = new SourceMcpPrivacyBoundary({
      source: 'legacy-bridge-test',
      learnerVaultPath: resolve(directory, 'learners.json'),
      bindings: () => bindings,
      acceptsCourseRequest: () => true,
      loadRoster: async () => [{ id: '100', name: 'Mary Jackson' }],
    });
    const projected = await boundary.invoke(
      'list_users',
      { course_id: '42', _morrow: { source_binding_id: 'binding-42' } },
      {},
      async () => ({ ok: true, users: [{ id: '100', name: 'Mary Jackson' }] }),
    );
    assert.equal(projected.isError, undefined);
    assert.doesNotMatch(JSON.stringify(projected), /Mary Jackson/);
    assert.match(JSON.stringify(projected), /Student A1/);
  } finally {
    delete globalThis.__morrowLegacyBindings;
    delete globalThis.__morrowLegacySessions;
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy connection acknowledges exact cancellation and suppresses late results', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'morrow-legacy-cancel-'));
  const priorWebSocket = globalThis.WebSocket;
  const priorChrome = globalThis.chrome;
  try {
    await writeFile(resolve(directory, 'package.json'), '{"type":"module"}\n');
    for (const filename of ['morrow-gateway-bridge.js', 'morrow-gateway-bridge-protocol.js']) {
      await copyFile(resolve(ROOT, 'integrations/morrow-legacy/extension', filename), resolve(directory, filename));
    }
    const protocolSource = await readFile(resolve(directory, 'morrow-gateway-bridge-protocol.js'), 'utf8');
    const overlayIdentity = /LEGACY_BRIDGE_OVERLAY_DIGEST = '([0-9a-f]{64})'/.exec(protocolSource)?.[1];
    assert.ok(overlayIdentity);
    await writeFile(resolve(directory, 'morrow-gateway-bridge.local.js'), [
      'export const MORROW_GATEWAY_BRIDGE_CONFIG = Object.freeze({',
      '  enabled: true,',
      '  url: "ws://127.0.0.1:32145/morrow-bridge/v1",',
      `  token: "${'t'.repeat(40)}",`,
      '  donorRevision: "revision-1",',
      `  catalogDigest: "${'a'.repeat(64)}"`,
      '});',
      '',
    ].join('\n'));
    await writeFile(resolve(directory, 'morrow-gateway-bridge-bindings.js'), [
      `export const LEGACY_BRIDGE_OVERLAY_DIGEST = '${overlayIdentity}';`,
      'export async function currentMorrowBridgeBindings() { return []; }',
      '',
    ].join('\n'));
    await writeFile(resolve(directory, 'morrow-gateway-bridge-runtime.js'), [
      `export const LEGACY_BRIDGE_OVERLAY_DIGEST = '${overlayIdentity}';`,
      'export async function handleMorrowGatewayBridgeCommand(command, generation, control) {',
      '  return globalThis.__morrowLegacyCommandHandler(command, generation, control);',
      '}',
      '',
    ].join('\n'));

    class FakeWebSocket {
      static OPEN = 1;
      static instances = [];
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.listeners = new Map();
        this.sent = [];
        FakeWebSocket.instances.push(this);
      }
      addEventListener(type, listener) {
        const list = this.listeners.get(type) || [];
        list.push(listener);
        this.listeners.set(type, list);
      }
      emit(type, value = {}) {
        for (const listener of this.listeners.get(type) || []) listener(value);
      }
      send(value) { this.sent.push(JSON.parse(value)); }
      close(code, reason) {
        this.closeCode = code;
        this.closeReason = reason;
        this.readyState = 3;
        this.emit('close');
      }
    }
    globalThis.WebSocket = FakeWebSocket;
    globalThis.chrome = { runtime: { id: 'b'.repeat(32) } };
    const pending = new Map();
    globalThis.__morrowLegacyCommandHandler = (command, _generation, control) => new Promise((resolve) => {
      if (command.kind === 'stage_write') control.markEffectPossible();
      pending.set(command.requestId, { resolve, control });
    });
    const bridge = await import(`${pathToFileURL(resolve(directory, 'morrow-gateway-bridge.js')).href}?test=${Date.now()}`);
    const protocol = await import(pathToFileURL(resolve(directory, 'morrow-gateway-bridge-protocol.js')).href);
    const waitFor = async (predicate) => {
      for (let index = 0; index < 100; index += 1) {
        if (predicate()) return;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
      }
      assert.fail('legacy bridge fixture did not reach the expected state');
    };
    let releaseOld;
    let releaseCurrent;
    const oldBarrier = new Promise((resolvePromise) => { releaseOld = resolvePromise; });
    const currentBarrier = new Promise((resolvePromise) => { releaseCurrent = resolvePromise; });
    assert.equal(bridge.installMorrowGatewayBridge({ readyPromise: oldBarrier }), true);
    bridge.stopMorrowGatewayBridge();
    assert.equal(bridge.installMorrowGatewayBridge({ readyPromise: currentBarrier }), true);
    releaseOld();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    assert.equal(FakeWebSocket.instances.length, 0);
    releaseCurrent();
    await waitFor(() => FakeWebSocket.instances.length === 1);
    const socket = FakeWebSocket.instances[0];
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit('open');
    await waitFor(() => socket.sent.length === 1);
    const authentication = socket.sent[0];
    const serverNonce = 'c'.repeat(64);
    socket.emit('message', { data: JSON.stringify({
      schema: protocol.BRIDGE_SCHEMA.challenge,
      protocolVersion: 1,
      clientNonce: authentication.clientNonce,
      serverNonce,
      serverProof: await protocol.bridgeProof('t'.repeat(40), 'server', authentication, serverNonce),
      issuedAt: Date.now(),
    }) });
    await waitFor(() => socket.sent.some((message) => message.schema === protocol.BRIDGE_SCHEMA.hello));
    socket.emit('message', { data: JSON.stringify({
      schema: protocol.BRIDGE_SCHEMA.ready,
      protocolVersion: 1,
      generation: 9,
      acceptedExtensionId: 'b'.repeat(32),
      catalogDigest: 'a'.repeat(64),
      connectedAt: Date.now(),
    }) });
    await waitFor(() => socket.sent.some((message) => message.schema === protocol.BRIDGE_SCHEMA.bindings));

    const command = (requestId, operationId, kind) => ({
      schema: protocol.BRIDGE_SCHEMA.command,
      protocolVersion: 1,
      requestId,
      operationId,
      kind,
      toolName: kind === 'stage_write' ? 'edit_page' : 'list_pages',
      generation: 9,
      createdAt: Date.now(),
      expiresAt: Date.now() + 10_000,
    });
    const cancel = (requestId, operationId) => ({
      schema: protocol.BRIDGE_SCHEMA.cancel,
      protocolVersion: 1,
      requestId,
      operationId,
      generation: 9,
      cancelledAt: Date.now(),
    });
    const read = command('request:read-1', 'operation:read-1', 'invoke_read');
    socket.emit('message', { data: JSON.stringify(read) });
    await waitFor(() => pending.has(read.requestId));
    socket.emit('message', { data: JSON.stringify(cancel(read.requestId, read.operationId)) });
    await waitFor(() => socket.sent.some((message) => message.requestId === read.requestId));
    assert.equal(pending.get(read.requestId).control.signal.aborted, true);
    assert.equal(socket.sent.find((message) => message.requestId === read.requestId).problem.code, 'request_cancelled_before_dispatch');
    pending.get(read.requestId).resolve({ late: true });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    assert.equal(socket.sent.filter((message) => message.requestId === read.requestId).length, 1);

    const stage = command('request:stage-1', 'operation:stage-1', 'stage_write');
    socket.emit('message', { data: JSON.stringify(stage) });
    await waitFor(() => pending.has(stage.requestId));
    socket.emit('message', { data: JSON.stringify(cancel(stage.requestId, stage.operationId)) });
    await waitFor(() => socket.sent.some((message) => message.requestId === stage.requestId));
    assert.equal(socket.sent.find((message) => message.requestId === stage.requestId).problem.code, 'write_outcome_unknown');
    pending.get(stage.requestId).resolve({ late: true });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    assert.equal(socket.sent.filter((message) => message.requestId === stage.requestId).length, 1);
    bridge.stopMorrowGatewayBridge();
  } finally {
    delete globalThis.__morrowLegacyCommandHandler;
    globalThis.WebSocket = priorWebSocket;
    globalThis.chrome = priorChrome;
    await rm(directory, { recursive: true, force: true });
  }
});
