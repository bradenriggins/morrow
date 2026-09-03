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
  admittedCapability(toolName, false);
  const input = exactCommandInput(command);
  const binding = resolveMorrowBridgeBinding(String(command.sourceBindingId || '').trim(), input);
  const { runtime } = await buildMorrowBridgeCommandRuntime(binding);
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
