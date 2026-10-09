import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const extension = dirname(new URL(import.meta.url).pathname);

async function loadRuntime() {
  const directory = await mkdtemp(resolve(tmpdir(), "morrow-legacy-course-"));
  await mkdir(resolve(directory, "providers/canvas"), { recursive: true });
  await mkdir(resolve(directory, "tools"), { recursive: true });
  await mkdir(resolve(directory, "chat-task-manager"), { recursive: true });
  await writeFile(resolve(directory, "package.json"), '{"type":"module"}\n');
  for (const filename of ["morrow-gateway-bridge-bindings.js", "morrow-gateway-bridge-protocol.js", "morrow-gateway-bridge-runtime.js"]) {
    await writeFile(resolve(directory, filename), await readFile(resolve(extension, filename)));
  }
  await writeFile(resolve(directory, "morrow-gateway-bridge.local.js"), [
    "export const MORROW_GATEWAY_BRIDGE_CONFIG = Object.freeze({",
    "  enabled: true,",
    '  url: "ws://127.0.0.1:32145/morrow-bridge/v1",',
    `  token: "${"t".repeat(40)}",`,
    '  donorRevision: "revision-1",',
    `  catalogDigest: "${"a".repeat(64)}"`,
    "});",
    "",
  ].join("\n"));
  await writeFile(resolve(directory, "state.js"), [
    "export const state = {};",
    "export function getLiveProviderBindings() { return globalThis.__morrowCourseBindings || []; }",
    "",
  ].join("\n"));
  await writeFile(resolve(directory, "execution-runtime.js"), "export async function buildExecutionRuntimeSnapshot() { return { providers: { canvas: { ready: true } } }; }\n");
  await writeFile(resolve(directory, "providers/canvas/session-registry.js"), "export function getCanvasSession() { return null; }\n");
  await writeFile(resolve(directory, "providers/canvas/client.js"), "export async function canvasGetPaginated() { return []; }\n");
  await writeFile(resolve(directory, "chat-task-manager/helpers.js"), "export function classifyOperationResult() { return 'notStarted'; }\n");
  await writeFile(resolve(directory, "chat-task-manager.js"), "export async function getHydratedChatTask() { return null; }\nexport async function stageChatTask() { return null; }\n");
  await writeFile(resolve(directory, "tools/admin-tools.js"), "export const ADMIN_TOOL_DEFINITIONS = [];\nexport const ADMIN_TOOL_HANDLERS = {};\nexport function setAdminSignal() {}\n");
  await writeFile(resolve(directory, "providers/capability-registry.js"), "export function getCapability() { return { modelVisible: true, write: false }; }\n");
  await writeFile(resolve(directory, "providers/canvas/tools.js"), [
    "export const TOOL_DEFINITIONS = [{ name: 'canvas_list_pages_courses' }];",
    "export async function executeTool(name, input) { globalThis.__morrowCourseReads.push({ name, input }); return { ok: true }; }",
    "",
  ].join("\n"));
  globalThis.__morrowCourseBindings = [{
    bindingId: "binding-42",
    runtimeVerified: true,
    courseId: "42",
    sessionId: "session-42",
    canvasBase: "https://canvas.example.edu",
  }];
  globalThis.__morrowCourseReads = [];
  const runtime = await import(`${pathToFileURL(resolve(directory, "morrow-gateway-bridge-runtime.js")).href}?test=${Date.now()}`);
  const protocol = await import(pathToFileURL(resolve(directory, "morrow-gateway-bridge-protocol.js")).href);
  return { directory, runtime, protocol };
}

function command(protocol, courseId) {
  return {
    schema: protocol.BRIDGE_SCHEMA.command,
    protocolVersion: protocol.BRIDGE_PROTOCOL_VERSION,
    generation: 1,
    requestId: "request-1",
    operationId: "operation-1",
    kind: "invoke_read",
    toolName: "canvas_list_pages_courses",
    arguments: { course_id: courseId },
    expiresAt: Date.now() + 60_000,
  };
}

test("invoke_read rejects a course id that does not match the only live binding", async () => {
  const loaded = await loadRuntime();
  try {
    await assert.rejects(
      loaded.runtime.handleMorrowGatewayBridgeCommand(command(loaded.protocol, "99"), 1),
      (error) => error?.code === "bridge_course_scope_mismatch",
    );
    assert.equal(globalThis.__morrowCourseReads.length, 0);
  } finally {
    delete globalThis.__morrowCourseBindings;
    delete globalThis.__morrowCourseReads;
    await rm(loaded.directory, { recursive: true, force: true });
  }
});

test("invoke_read still reads the one course the binding names", async () => {
  const loaded = await loadRuntime();
  try {
    const result = await loaded.runtime.handleMorrowGatewayBridgeCommand(command(loaded.protocol, "42"), 1);
    assert.equal(result.toolName, "canvas_list_pages_courses");
    assert.equal(globalThis.__morrowCourseReads.length, 1);
    assert.equal(globalThis.__morrowCourseReads[0].input.course_id, "42");
  } finally {
    delete globalThis.__morrowCourseBindings;
    delete globalThis.__morrowCourseReads;
    await rm(loaded.directory, { recursive: true, force: true });
  }
});
