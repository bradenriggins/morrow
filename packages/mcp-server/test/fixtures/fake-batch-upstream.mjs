import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

const source = process.env.FAKE_SOURCE || 'fixture';
const stagedTasks = new Map();
const taskReads = new Map();

function taskProjection(taskId, sourceBindingId) {
  const readCount = (taskReads.get(taskId) || 0) + 1;
  taskReads.set(taskId, readCount);

  if (taskId.includes('failed-effect')) {
    return {
      taskId,
      status: 'failed',
      outcome: 'failed_effect_possible',
      terminal: true,
      verificationStatus: 'unconfirmed',
      resultCounts: {
        done: 1,
        unconfirmed: 0,
        failed: 1,
        rollbackFailed: 0,
        skipped: 0,
        undone: 0,
        notStarted: 0,
      },
      sourceBindingId,
    };
  }

  if (taskId.includes('failed-no-effect')) {
    return {
      taskId,
      status: 'failed',
      outcome: 'failed_no_effect',
      terminal: true,
      verificationStatus: 'not_started',
      resultCounts: {
        done: 0,
        unconfirmed: 0,
        failed: 1,
        rollbackFailed: 0,
        skipped: 0,
        undone: 0,
        notStarted: 1,
      },
      sourceBindingId,
    };
  }

  if (taskId.includes('unconfirmed')) {
    return {
      taskId,
      status: 'completed',
      outcome: 'inspection_required',
      terminal: true,
      verificationStatus: 'unconfirmed',
      resultCounts: {
        done: 0,
        unconfirmed: 1,
        failed: 0,
        rollbackFailed: 0,
        skipped: 0,
        undone: 0,
        notStarted: 0,
      },
      sourceBindingId,
    };
  }

  if (readCount === 1) {
    return {
      taskId,
      status: 'awaiting_confirmation',
      outcome: 'awaiting_approval',
      terminal: false,
      verificationStatus: null,
      resultCounts: {
        done: 0,
        unconfirmed: 0,
        failed: 0,
        rollbackFailed: 0,
        skipped: 0,
        undone: 0,
        notStarted: 1,
      },
      sourceBindingId,
    };
  }

  return {
    taskId,
    status: 'completed',
    outcome: 'succeeded',
    terminal: true,
    verificationStatus: 'verified',
    resultCounts: {
      done: 1,
      unconfirmed: 0,
      failed: 0,
      rollbackFailed: 0,
      skipped: 0,
      undone: 0,
      notStarted: 0,
    },
    sourceBindingId,
  };
}

function createServer() {
  const server = new McpServer({ name: `${source}-batch-fixture`, version: '1.0.0' });
  server.registerTool(
    'canvas_page_get',
    {
      description: 'Read a page fixture.',
      inputSchema: z.object({ course_id: z.string() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ course_id }) => ({
      content: [{ type: 'text', text: `${source}:${course_id}` }],
      structuredContent: { source, course_id },
    }),
  );
  server.registerTool(
    'morrow_batch_create',
    {
      description: 'A donor collision that must remain hidden behind the native batch surface.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => ({ content: [{ type: 'text', text: 'donor-native-collision' }] }),
  );
  if (source === 'example-legacy') {
    server.registerTool(
      'morrow_legacy_task_get',
      {
        description: 'Inspect one staged task fixture without changing it.',
        inputSchema: z.object({
          task_id: z.string(),
          source_binding_id: z.string().optional(),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ task_id, source_binding_id }) => {
        const staged = stagedTasks.get(task_id);
        if (!staged) {
          return {
            content: [{ type: 'text', text: 'task missing' }],
            isError: true,
            structuredContent: {
              schema: 'morrow.legacy-bridge.task.v1',
              ok: false,
              problem: {
                schema: 'morrow.bridge.problem.v1',
                code: 'task_not_found',
                message: 'The staged task does not exist.',
                recoverable: false,
              },
            },
          };
        }
        if (source_binding_id && staged.sourceBindingId !== source_binding_id) {
          return {
            content: [{ type: 'text', text: 'binding mismatch' }],
            isError: true,
            structuredContent: {
              schema: 'morrow.legacy-bridge.task.v1',
              ok: false,
              problem: {
                schema: 'morrow.bridge.problem.v1',
                code: 'task_binding_mismatch',
                message: 'The task belongs to a different source binding.',
                recoverable: false,
              },
            },
          };
        }
        return {
          content: [{ type: 'text', text: `task:${task_id}` }],
          structuredContent: {
            schema: 'morrow.legacy-bridge.task.v1',
            ok: true,
            task: taskProjection(task_id, staged.sourceBindingId),
          },
        };
      },
    );

    server.registerTool(
      'edit_page',
      {
        description: 'Stage a page edit fixture.',
        inputSchema: z.object({
          course_id: z.string(),
          title: z.string().optional(),
          fixture_outcome: z.enum(['normal', 'failed-effect', 'failed-no-effect', 'unconfirmed']).optional(),
          _morrow: z.object({
            operation_id: z.string(),
            source_binding_id: z.string().optional(),
          }).optional(),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ course_id, fixture_outcome, _morrow }) => {
        const suffix = fixture_outcome && fixture_outcome !== 'normal'
          ? `-${fixture_outcome}`
          : '';
        const taskId = `task-${course_id}${suffix}`;
        stagedTasks.set(taskId, {
          taskId,
          sourceBindingId: _morrow?.source_binding_id || null,
          operationId: _morrow?.operation_id || null,
        });
        return {
          content: [{ type: 'text', text: `staged:${course_id}` }],
          structuredContent: {
            schema: 'morrow.legacy-bridge.result.v1',
            ok: true,
            sourceToolName: 'edit_page',
            commandKind: 'stage_write',
            result: {
              approvalRequired: true,
              taskId,
              status: 'awaiting_confirmation',
              operationId: _morrow?.operation_id || null,
            },
          },
        };
      },
    );
  }
  return server;
}

await serveStdio(createServer);
