import { canvasGetPaginated } from './providers/canvas/client.js';
import {
  TOOL_DEFINITIONS,
  executeTool,
} from './providers/canvas/tools.js';
import { getCapability } from './providers/capability-registry.js';
import {
  ADMIN_TOOL_DEFINITIONS,
  ADMIN_TOOL_HANDLERS,
  setAdminSignal,
} from './tools/admin-tools.js';
import {
  getHydratedChatTask,
  stageChatTask,
} from './chat-task-manager.js';
import {
  buildMorrowBridgeCommandRuntime,
  buildMorrowBridgeInputPreview,
  currentMorrowBridgeBindings,
  getMorrowBridgeActiveConversation,
  projectMorrowBridgeTask,
  resolveMorrowBridgeBinding,
  resolveMorrowBridgeCourseId,
} from './morrow-gateway-bridge-bindings.js';
import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_SCHEMA,
  bridgeError,
} from './morrow-gateway-bridge-protocol.js';

const TOOL_BY_NAME = new Map(
  [...TOOL_DEFINITIONS, ...ADMIN_TOOL_DEFINITIONS]
    .map((definition) => [String(definition?.name || '').trim(), definition])
    .filter(([name]) => name),
);

function exactCommandInput(command) {
  return command.arguments && typeof command.arguments === 'object' && !Array.isArray(command.arguments)
    ? command.arguments
    : {};
}

function verifiedOuterGrant(command) {
  const grant = command && command.outerGrant;
  const digest = /^[0-9a-f]{64}$/;
  const identifier = /^[A-Za-z0-9_.:@-]{8,160}$/;
  if (
    !grant || typeof grant !== 'object'
    || !digest.test(String(grant.planDigest || ''))
    || !digest.test(String(grant.approvalGrantDigest || ''))
    || !identifier.test(String(grant.effectReceiptId || ''))
    || Number(grant.dispatchAttempt) !== 1
    || !identifier.test(String(grant.gatewayProcessId || ''))
  ) {
    throw bridgeError('bridge_outer_grant_invalid', 'The gateway outer effect grant is invalid.');
  }
  return {
    plan_digest: String(grant.planDigest),
    approval_grant_digest: String(grant.approvalGrantDigest),
    effect_receipt_id: String(grant.effectReceiptId),
    gateway_process_id: String(grant.gatewayProcessId),
  };
}

function admittedCapability(toolName, expectedWrite) {
  const definition = TOOL_BY_NAME.get(toolName);
  const capability = getCapability('canvas', toolName);
  const admitted = definition
    && capability
    && capability.modelVisible === true
    && capability.write === expectedWrite;
  if (!admitted) {
    throw bridgeError(
      expectedWrite ? 'bridge_write_not_admitted' : 'bridge_read_not_admitted',
      `The requested tool is not an admitted ${expectedWrite ? 'write' : 'read'} capability.`,
    );
  }
  return { definition, capability };
}

async function invokeRead(command) {
  const toolName = String(command.toolName || '').trim();
  if (toolName !== 'morrow_legacy_private_roster') admittedCapability(toolName, false);
  const input = exactCommandInput(command);
  const binding = resolveMorrowBridgeBinding(String(command.sourceBindingId || '').trim(), input);
  const { runtime } = await buildMorrowBridgeCommandRuntime(binding);
  if (toolName === 'morrow_legacy_private_roster') {
    if (command.operationKey !== 'legacy:privacy_roster') throw bridgeError('bridge_read_not_admitted', 'The roster read is private.');
    const courseId = resolveMorrowBridgeCourseId(input, binding);
    if (!courseId) throw bridgeError('bridge_course_scope_unavailable', 'An exact course is required.');
    const roster = await canvasGetPaginated(
      `/courses/${courseId}/users?enrollment_type[]=student&enrollment_state[]=active&enrollment_state[]=invited&enrollment_state[]=rejected&enrollment_state[]=completed&enrollment_state[]=inactive&include[]=uuid`,
      runtime.cookieHeader || '', 50, { ...runtime, transientRetryLimit: 0 },
    );
    if (!Array.isArray(roster) || roster._truncated || roster.truncated || roster.incomplete
      || Date.now() >= Number(command.expiresAt)) throw bridgeError('learner_roster_result_incomplete', 'A complete current roster is required.');
    const deletedEnrollments = await canvasGetPaginated(
      `/courses/${courseId}/enrollments?type[]=StudentEnrollment&state[]=deleted`,
      runtime.cookieHeader || '', 50, { ...runtime, transientRetryLimit: 0 },
    );
    if (!Array.isArray(deletedEnrollments) || deletedEnrollments._truncated || deletedEnrollments.truncated || deletedEnrollments.incomplete
      || Date.now() >= Number(command.expiresAt)) throw bridgeError('learner_roster_result_incomplete', 'A complete enrollment history is required.');
    const current = resolveMorrowBridgeBinding(String(command.sourceBindingId || '').trim(), input);
    if (current.sessionId !== binding.sessionId || current.authorityEpoch !== binding.authorityEpoch) {
      throw bridgeError('learner_roster_binding_unavailable', 'The course session changed.');
    }
    return { schema: 'morrow.legacy-course-roster.v1', courseId: String(courseId), sourceBindingId: String(binding.bindingId), complete: true, historyComplete: true, identities: roster, deletedEnrollments };
  }

  const adminHandler = ADMIN_TOOL_HANDLERS[toolName];
  let result;
  if (typeof adminHandler === 'function') {
    setAdminSignal(runtime?.signal || null);
    try {
      result = await adminHandler(input, runtime?.cookieHeader || '', {
        ...runtime,
        source: 'morrow_gateway',
      });
    } finally {
      setAdminSignal(null);
    }
  } else {
    result = await executeTool(toolName, input, runtime);
  }
  return {
    kind: 'read_result',
    sourceBindingId: String(binding.bindingId || '').trim(),
    toolName,
    result: result && typeof result === 'object' ? result : { value: result ?? null },
  };
}

async function stageWrite(command) {
  const toolName = String(command.toolName || '').trim();
  const { definition, capability } = admittedCapability(toolName, true);
  const input = exactCommandInput(command);
  const binding = resolveMorrowBridgeBinding(String(command.sourceBindingId || '').trim(), input);
  const active = await getMorrowBridgeActiveConversation();
  if (!active.conversation || !active.conversationId) {
    throw bridgeError(
      'bridge_active_conversation_required',
      'Open the Morrow side panel and select the intended conversation before staging a gateway write.',
    );
  }
  const canvasUrl = String(binding.canvasBase || binding.canvasUrl || binding.origin || '').trim();
  const courseId = resolveMorrowBridgeCourseId(input, binding);
  const operationId = String(command.operationId || '').trim();
  const outerGrant = verifiedOuterGrant(command);
  const task = await stageChatTask({
    plan: {
      kind: 'morrow_gateway_write',
      title: String(definition.title || definition.name || toolName).trim().slice(0, 300),
      description: 'Requested through the local Morrow MCP gateway. Review the exact target and arguments before approval.',
      riskNote: capability.destructive === true
        ? 'This operation is destructive. Review the exact target and available recovery information before approval.'
        : 'This operation changes Canvas. Review the exact target before approval.',
      previewRows: buildMorrowBridgeInputPreview(input),
      operations: [{
        operationId,
        title: String(definition.title || toolName).trim().slice(0, 300),
        summary: String(definition.description || `Run ${toolName}`).trim().slice(0, 500),
        applyPayload: {
          kind: 'tool',
          tool: toolName,
          input,
        },
      }],
      affectedCount: 1,
      meta: {
        ...(courseId ? { course_id: courseId } : {}),
        operation_type: toolName,
        source: 'morrow_gateway',
        bridge_operation_id: operationId,
        ...outerGrant,
      },
      lineage: courseId ? { course_id: courseId } : {},
    },
    sessionId: binding.sessionId,
    conversationId: active.conversationId,
    projectId: active.projectId,
    canvasUrl,
    timeZone: binding.timeZone || null,
    sourceToolName: toolName,
    provider: 'canvas',
    contextSources: active.conversation.contextSources,
  });
  return {
    kind: 'approval_required',
    sourceBindingId: String(binding.bindingId || '').trim(),
    operationId,
    task: projectMorrowBridgeTask(task),
    note: 'The write was staged only. Approve or deny it in the Morrow approval surface; the MCP client cannot create approval.',
  };
}

async function taskGet(command) {
  const binding = resolveMorrowBridgeBinding(String(command.sourceBindingId || '').trim(), {});
  const courseId = resolveMorrowBridgeCourseId({}, binding);
  const active = await getMorrowBridgeActiveConversation();
  if (!active.conversation || !active.conversationId) {
    throw bridgeError(
      'bridge_active_conversation_required',
      'Open the Morrow side panel and select the intended conversation before inspecting a gateway task.',
    );
  }
  const taskId = String(command.taskId || '').trim();
  if (!taskId) throw bridgeError('bridge_task_id_required', 'taskId is required.');
  const task = await getHydratedChatTask(taskId, { projectId: active.projectId });
  if (!task) {
    throw bridgeError(
      'bridge_task_not_found',
      'The requested task does not exist in the active Morrow project.',
    );
  }
  if (task.conversationId !== active.conversationId) {
    throw bridgeError(
      'bridge_task_scope_mismatch',
      'The requested task belongs to a different Morrow conversation.',
    );
  }
  const origin = new URL(String(binding.canvasBase || binding.canvasUrl || binding.origin)).origin;
  if (String(task.sessionId || '') !== String(binding.sessionId || '') || !Array.isArray(task.operations) || !task.operations.length
    || task.operations.some((operation) => {
      const source = operation?.sourceRef;
      if (source?.provider !== 'canvas' || String(source.locator?.courseId || '') !== String(courseId)) return true;
      try { return new URL(String(source.locator?.canvasBase || '')).origin !== origin; } catch { return true; }
    })) throw bridgeError('bridge_task_scope_mismatch', 'The task does not belong to this exact current course session.');
  return projectMorrowBridgeTask(task);
}

export async function handleMorrowGatewayBridgeCommand(command, generation) {
  if (
    !command
    || command.schema !== BRIDGE_SCHEMA.command
    || command.protocolVersion !== BRIDGE_PROTOCOL_VERSION
    || command.generation !== generation
    || typeof command.requestId !== 'string'
    || typeof command.operationId !== 'string'
  ) {
    throw bridgeError(
      'bridge_command_invalid',
      'The bridge command is invalid for this connection.',
    );
  }
  if (Date.now() > Number(command.expiresAt || 0)) {
    throw bridgeError(
      'bridge_command_expired',
      'The bridge command expired before execution began.',
    );
  }
  if (command.kind === 'invoke_read') return invokeRead(command);
  if (command.kind === 'stage_write') return stageWrite(command);
  if (command.kind === 'task_get') return taskGet(command);
  if (command.kind === 'bindings_get') return { bindings: currentMorrowBridgeBindings() };
  throw bridgeError(
    'bridge_command_unsupported',
    'The bridge command kind is unsupported.',
  );
}
