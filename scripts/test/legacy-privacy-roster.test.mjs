import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../../integrations/example-legacy/extension/morrow-gateway-bridge-runtime.js', import.meta.url), 'utf8');
const executable = source.replace(/^import[\s\S]*?from ['"][^'"]+['"];\n/gm, '').replace(/export /g, '');
function runtime(roster, history = []) {
  const calls = [];
  const binding = { bindingId: 'canvas:42', courseId: '42', sessionId: 'session:1', authorityEpoch: 1 };
  const names = ['canvasGetPaginated', 'TOOL_DEFINITIONS', 'ADMIN_TOOL_DEFINITIONS', 'resolveMorrowBridgeBinding', 'resolveMorrowBridgeCourseId', 'buildMorrowBridgeCommandRuntime', 'bridgeError', 'BRIDGE_SCHEMA', 'BRIDGE_PROTOCOL_VERSION'];
  const values = [async (...args) => { calls.push(args); return args[0].includes("/enrollments?") ? history : roster; }, [], [], () => binding, () => '42', async () => ({ runtime: { cookieHeader: 'local-only' } }), (code) => Object.assign(new Error(code), { code }), { command: 'command' }, 1];
  const handler = new Function(...names, `${executable}\nreturn handleMorrowGatewayBridgeCommand;`)(...values);
  const command = { schema: 'command', protocolVersion: 1, generation: 1, requestId: 'request', operationId: 'operation', sourceBindingId: 'canvas:42', toolName: 'morrow_legacy_private_roster', operationKey: 'legacy:privacy_roster', kind: 'invoke_read', arguments: { course_id: '42' }, expiresAt: Date.now() + 10_000 };
  return { calls, command, handler };
}

test('legacy private roster loads the complete exact-course dictionary without a public tool handler', async () => {
  const state = runtime([{ id: '7', name: 'Michaela Adams', short_name: 'Michaela', login_id: 'madams', sis_user_id: 'SIS7' }]);
  const result = await state.handler(state.command, 1);
  assert.equal(result.complete, true);
  assert.equal(result.historyComplete, true);
  assert.deepEqual(result.deletedEnrollments, []);
  assert.equal(result.courseId, '42');
  assert.equal(result.sourceBindingId, 'canvas:42');
  assert.equal(result.identities[0].short_name, 'Michaela');
  assert.match(state.calls[0][0], /^\/courses\/42\/users\?/);
  assert.match(state.calls[0][0], /enrollment_state\[\]=rejected/);
  assert.equal(state.calls[0][2], 50);
});

test('legacy private roster refuses partial pagination and a forged private operation', async () => {
  const roster = [{ id: '7', name: 'Michaela Adams' }];
  roster._truncated = true;
  const partial = runtime(roster);
  await assert.rejects(partial.handler(partial.command, 1), /learner_roster_result_incomplete/);
  const forged = runtime([]);
  await assert.rejects(forged.handler({ ...forged.command, operationKey: 'legacy:generic_proxy' }, 1), /bridge_read_not_admitted/);
  assert.equal(forged.calls.length, 0);
});


test('legacy private roster refuses an incomplete deleted-enrollment history', async () => {
  const history = [{ course_id: 42, user_id: 7, type: 'StudentEnrollment', enrollment_state: 'deleted', user: { id: 7, name: 'Former Learner' } }];
  history._truncated = true;
  const state = runtime([], history);
  await assert.rejects(state.handler(state.command, 1), /learner_roster_result_incomplete/);
  assert.equal(state.calls.length, 2);
});
