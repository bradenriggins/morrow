import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

const source = process.env.FAKE_SOURCE || 'fixture';

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
      'edit_page',
      {
        description: 'Stage a page edit fixture.',
        inputSchema: z.object({
          course_id: z.string(),
          _morrow: z.object({
            operation_id: z.string(),
            source_binding_id: z.string().optional(),
          }).optional(),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ course_id, _morrow }) => ({
        content: [{ type: 'text', text: `staged:${course_id}` }],
        structuredContent: {
          schema: 'morrow.legacy-bridge.result.v1',
          ok: true,
          sourceToolName: 'edit_page',
          commandKind: 'stage_write',
          result: {
            approvalRequired: true,
            taskId: `task-${course_id}`,
            status: 'awaiting_confirmation',
            operationId: _morrow?.operation_id || null,
          },
        },
      }),
    );
  }
  return server;
}

await serveStdio(createServer);
