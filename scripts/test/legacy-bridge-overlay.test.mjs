import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  LEGACY_BRIDGE_OVERLAY_FILES,
  patchBackground,
  renderLocalConfig,
  unpatchBackground,
} from '../lib/legacy-bridge-overlay.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const fixture = `import { recoverSignedCourseReadinessRootCheckpoint } from './domains/launch/course-health-journey.js';\n\nif (requiredAuthoritiesReady) {\n  try {\n    setupMessageRouter();\n  } catch (err) {}\n}\n`;

test('background overlay patches and removes exactly', () => {
  const patched = patchBackground(fixture);
  assert.match(patched, /installMorrowGatewayBridge/);
  assert.equal(patchBackground(patched), patched);
  assert.equal(unpatchBackground(patched), fixture);
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
