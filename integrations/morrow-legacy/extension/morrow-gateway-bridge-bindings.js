import {
  state,
  getLiveProviderBindings,
} from './state.js';
import { buildExecutionRuntimeSnapshot } from './execution-runtime.js';
import { bridgeError } from './morrow-gateway-bridge-protocol.js';

export function normalizeMorrowBridgeExactId(value) {
  const text = String(value ?? '').trim();
  return /^[1-9][0-9]{0,18}$/.test(text) ? text : null;
}

function canonicalOrigin(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    return parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

function bindingCourseId(binding) {
  return normalizeMorrowBridgeExactId(
    binding?.courseId
    ?? binding?.canvasContext?.courseId
    ?? binding?.canvasContext?.course_id,
  );
}

function bindingProjection(binding) {
  const sourceBindingId = String(binding?.bindingId || '').trim();
  if (!sourceBindingId || binding?.runtimeVerified !== true) return null;
  const courseId = bindingCourseId(binding);
  const origin = canonicalOrigin(binding?.canvasBase || binding?.canvasUrl || binding?.origin);
  return {
    sourceBindingId,
    provider: 'canvas',
    ...(courseId ? { courseId } : {}),
    ...(typeof binding?.courseName === 'string' && binding.courseName.trim()
      ? { courseName: binding.courseName.trim().slice(0, 300) }
      : {}),
    ...(origin ? { origin } : {}),
    runtimeVerified: true,
    ...(Number.isFinite(Number(binding?.lastBoundAt || binding?.lastSeenAt))
      ? { lastSeenAt: Number(binding.lastBoundAt || binding.lastSeenAt) }
      : {}),
  };
}

export function currentMorrowBridgeBindings() {
  return getLiveProviderBindings('canvas')
    .map(bindingProjection)
    .filter(Boolean)
    .sort((left, right) => (
      left.sourceBindingId < right.sourceBindingId ? -1 : left.sourceBindingId > right.sourceBindingId ? 1 : 0
    ));
}

function courseIdsFromArguments(input = {}) {
  const fields = [
    'course_id',
    'courseId',
    'destination_course_id',
    'source_course_id',
    'blueprint_course_id',
  ];
  return [...new Set(fields
    .map((field) => normalizeMorrowBridgeExactId(input?.[field]))
    .filter(Boolean))];
}

export function resolveMorrowBridgeBinding(sourceBindingId, input = {}) {
  const live = getLiveProviderBindings('canvas').filter((binding) => binding?.runtimeVerified === true);
  if (sourceBindingId) {
    const exact = live.filter((binding) => String(binding?.bindingId || '').trim() === sourceBindingId);
    if (exact.length !== 1) {
      throw bridgeError(
        'bridge_source_binding_unavailable',
        'The requested Morrow source binding is unavailable or no longer unique.',
      );
    }
    return exact[0];
  }
  const courseIds = courseIdsFromArguments(input);
  if (courseIds.length === 1) {
    const byCourse = live.filter((binding) => bindingCourseId(binding) === courseIds[0]);
    if (byCourse.length === 1) return byCourse[0];
  }
  if (live.length === 1) return live[0];
  throw bridgeError(
    live.length === 0 ? 'bridge_no_live_binding' : 'bridge_binding_ambiguous',
    live.length === 0
      ? 'No runtime-verified Canvas source is currently connected to Morrow.'
      : 'More than one Canvas source is connected. Call morrow_legacy_bindings, then pass _morrow.source_binding_id.',
  );
}

export async function getMorrowBridgeActiveConversation() {
  const active = state?.activeChatContext;
  const conversationId = String(active?.conversationId || '').trim();
  const projectId = typeof active?.projectId === 'string' && active.projectId.trim()
    ? active.projectId.trim()
    : null;
  if (!conversationId || typeof globalThis.CoreEngineDB?.getConversation !== 'function') {
    return { conversation: null, conversationId: null, projectId };
  }
  const conversation = await globalThis.CoreEngineDB
    .getConversation(conversationId, { projectId })
    .catch(() => null);
  return { conversation, conversationId, projectId };
}

export async function buildMorrowBridgeCommandRuntime(binding) {
  const active = await getMorrowBridgeActiveConversation();
  const runtime = await buildExecutionRuntimeSnapshot({
    provider: 'canvas',
    conversation: active.conversation,
    bindingId: binding.bindingId,
    sessionId: binding.sessionId,
    allowFallback: false,
  });
  if (!runtime?.providers?.canvas) {
    throw bridgeError(
      'bridge_runtime_unavailable',
      'The selected Canvas binding could not produce a current execution runtime.',
    );
  }
  return { ...active, runtime };
}

export function projectMorrowBridgeTask(task) {
  if (!task || typeof task !== 'object') return null;
  return {
    taskId: String(task.taskId || task.id || '').trim() || null,
    status: String(task.status || '').trim() || 'unknown',
    title: String(task.title || task.planSummary?.title || '').trim().slice(0, 300),
    description: String(task.description || task.planSummary?.description || '').trim().slice(0, 500),
    affectedCount: Number(task.planSummary?.affectedCount || task.operations?.length || 0),
    currentIndex: Number(task.currentIndex || 0),
    lastProgressNote: String(task.lastProgressNote || '').trim().slice(0, 1000),
    approvalRequired: task.approvalState?.required !== false,
    approvalRecorded: Boolean(task.approvalState?.confirmedAt),
    destructive: task.completedRuntimeMetadata?.destructive === true,
    riskTier: String(task.completedRuntimeMetadata?.riskTier || '').trim() || null,
  };
}

export function buildMorrowBridgeInputPreview(input = {}) {
  const rows = [];
  for (const [key, value] of Object.entries(input)) {
    if (rows.length >= 20) break;
    if (/token|cookie|secret|password|authorization|csrf/i.test(key)) continue;
    let shown;
    if (typeof value === 'string') shown = value.length > 180 ? `${value.slice(0, 177)}...` : value;
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) shown = String(value);
    else if (Array.isArray(value)) shown = `[${value.length} items]`;
    else shown = '[object]';
    rows.push({ item: key, change: shown });
  }
  return rows;
}

export function resolveMorrowBridgeCourseId(input, binding) {
  return courseIdsFromArguments(input)[0] || bindingCourseId(binding);
}
