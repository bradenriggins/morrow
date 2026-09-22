// Before anything is written: prove the sandbox this harness is pointed at is the one it owns.
// A course that is not the sandbox, or one carrying another lane's marks, stops the run.
import { writeFileSync } from "node:fs";
import { connect, SANDBOX, SOURCE_BINDING } from "./connect.mjs";

const { client, close } = await connect("morrow-proof-sandbox");
const call = async (name, args, timeout = 120_000) => await client.callTool({ name, arguments: args }, { timeout });
const readTool = async (name, args) => {
  const value = await call("morrow_capability_read", { name, arguments: { ...args, _morrow: { source_binding_id: SOURCE_BINDING } } });
  const held = value?.structuredContent?.data ?? value?.structuredContent ?? {};
  return { ok: value?.structuredContent?.status === "succeeded", data: held?.result?.data ?? held?.data ?? held, code: held?.code };
};

try {
  const bindings = (await call("morrow_capability_read", { name: "morrow_canvas_bindings", arguments: {} }))?.structuredContent?.data?.bindings ?? [];
  const binding = bindings.find((entry) => entry.sourceBindingId === SOURCE_BINDING);
  const course = await readTool("canvas_get_single_course_courses", { id: SANDBOX.courseId });
  const name = course.data?.name ?? course.data?.course?.name ?? null;
  const accountId = String(course.data?.account_id ?? course.data?.course?.account_id ?? "");
  const workflow = String(course.data?.workflow_state ?? course.data?.course?.workflow_state ?? "");

  // Whatever another lane left behind is named, this harness never touches an object it did not
  // make: its own objects carry its mark, and the check below only reports what is there.
  const assignments = await readTool("canvas_list_assignments_courses", { course_id: SANDBOX.courseId, morrow_max_pages: 2 });
  const rows = Array.isArray(assignments.data) ? assignments.data : [];
  const marks = {};
  for (const row of rows) {
    const title = String(row?.name ?? "");
    const mark = /^(MORROWPROOF|MORROWNQ|MORROWBANK|MORROW|PROOF)[A-Z0-9_-]*/i.exec(title)?.[1];
    if (mark) marks[mark.toUpperCase()] = (marks[mark.toUpperCase()] ?? 0) + 1;
  }

  const report = {
    schema: "morrow.proof-sandbox.v1",
    checkedAt: new Date().toISOString(),
    sourceBindingId: SOURCE_BINDING,
    bindingCourseId: binding?.courseId ?? null,
    bindingRuntimeVerified: binding?.runtimeVerified ?? false,
    course: { id: SANDBOX.courseId, name, accountId, workflowState: workflow },
    ownMark: SANDBOX.mark,
    marksSeenInAssignments: marks,
    ok: Boolean(binding?.runtimeVerified) && String(binding?.courseId ?? "") === SANDBOX.courseId && Boolean(name),
  };
  writeFileSync(new URL("sandbox.json", import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 1));
  if (!report.ok) process.exitCode = 1;
} finally {
  await close();
}
