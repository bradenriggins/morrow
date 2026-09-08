import { McpServer } from "@modelcontextprotocol/server";
import type { JsonObject } from "@morrow/contracts";
import { BlackboardApiError } from "./types.js";
import { BLACKBOARD_TOOL_DEFINITIONS } from "./operations/index.js";
import type { BlackboardLearnRuntime } from "./runtime.js";

function resultSummary(value: JsonObject): string {
  if (value.ok === false) return "Morrow could not complete the Blackboard request.";
  if (value.schema === "morrow.blackboard.unresolved-effects.v1") {
    return value.count === 0
      ? "Morrow has no record of a Blackboard change it sent and could not confirm."
      : "Morrow sent these Blackboard changes and could not confirm them. Open each item in Blackboard and check it. Do not repeat the change.";
  }
  if (value.schema === "morrow.blackboard.health.v1") return "Morrow found Blackboard REST configuration. Live Blackboard access has not been tested.";
  if (value.schema === "morrow.blackboard.course.v1") return "Morrow read the selected Blackboard course through the configured REST API.";
  if (value.schema === "morrow.blackboard.contents.v1") return "Morrow read the selected Blackboard course content through the configured REST API.";
  if (value.schema === "morrow.blackboard.content.v1") return "Morrow read the selected Blackboard course content item through the configured REST API.";
  if (value.schema === "morrow.blackboard.roster-summary.v1") return "Morrow created protected learner references for the selected Blackboard course.";
  if (value.schema === "morrow.blackboard.courses.v1") {
    return value.complete === true
      ? "Morrow listed the Blackboard courses this connection's integration account is enrolled in."
      : "Morrow listed part of the Blackboard courses this connection's integration account is enrolled in. The result names every course it left out.";
  }
  if (value.schema === "morrow.blackboard.content-children.v1") return "Morrow read one level of the selected Blackboard content item through the configured REST API.";
  if (value.schema === "morrow.blackboard.course-availability.v1") return "Morrow read the selected Blackboard course's availability through the configured REST API.";
  if (value.schema === "morrow.blackboard.content-inventory.v1") {
    return value.complete === true
      ? "Morrow mapped the content of the selected Blackboard course."
      : "Morrow mapped part of the content of the selected Blackboard course. The result names every item it did not read.";
  }
  if (value.schema === "morrow.blackboard.content-attachments.v1") return "Morrow read the files on the selected Blackboard content item.";
  if (value.schema === "morrow.blackboard.content-attachment.v1") return "Morrow read one file's details on the selected Blackboard content item.";
  if (value.schema === "morrow.blackboard.content-attachment.plan.v1") return "Morrow prepared one Blackboard file attachment for review. No file was staged and none was attached.";
  if (value.schema === "morrow.blackboard.content-attachment.readback.v1") {
    return "Morrow attached the reviewed file to the selected Blackboard item and read it back by name and size. It did not read the file's bytes back.";
  }
  if (value.schema === "morrow.blackboard.content-attachment.comparator.v1") return "Morrow re-read the files on the selected Blackboard content item.";
  if (value.schema === "morrow.blackboard.gradebook-columns.v1") return "Morrow read the gradebook columns of the selected Blackboard course.";
  if (value.schema === "morrow.blackboard.gradebook-column.v1") return "Morrow read one gradebook column of the selected Blackboard course.";
  if (value.schema === "morrow.blackboard.gradebook-attempts.v1") {
    return value.complete === true
      ? "Morrow read the attempts in the selected Blackboard gradebook column."
      : "Morrow read part of the attempts in the selected Blackboard gradebook column. The result names every attempt it left out.";
  }
  if (value.schema === "morrow.blackboard.gradebook-attempt.v1") return "Morrow read one attempt in the selected Blackboard gradebook column.";
  if (value.schema === "morrow.blackboard.gradebook-grade.v1") return "Morrow read one person's grade in the selected Blackboard gradebook column.";
  if (value.schema === "morrow.blackboard.gradebook-column-patch.plan.v1") return "Morrow prepared one Blackboard gradebook column change for review. Nothing in the course was changed.";
  if (value.schema === "morrow.blackboard.gradebook-column-patch.readback.v1") {
    return "Morrow changed the reviewed Blackboard gradebook column and read its values back.";
  }
  if (value.schema === "morrow.blackboard.gradebook-column-patch.comparator.v1") return "Morrow re-read the selected Blackboard gradebook column.";
  if (value.schema === "morrow.blackboard.gradebook-grade-patch.plan.v1") return "Morrow prepared one Blackboard grade change for review. No grade was changed.";
  if (value.schema === "morrow.blackboard.gradebook-grade-patch.readback.v1") {
    return "Morrow changed the reviewed Blackboard grade and read the saved score and grade text back.";
  }
  if (value.schema === "morrow.blackboard.gradebook-grade-patch.comparator.v1") return "Morrow re-read the selected Blackboard grade.";
  if (value.schema === "morrow.blackboard.course-assessment.v1") return "Morrow read the selected Blackboard test or assignment and the gradebook column that grades it. Morrow cannot read or write the questions inside it.";
  if (value.schema === "morrow.blackboard.ultra-assignment.plan.v1") return "Morrow prepared one Blackboard Ultra assignment for review. Nothing was created in the course.";
  if (value.schema === "morrow.blackboard.ultra-assignment.readback.v1") {
    return "Morrow created the reviewed Blackboard assignment and read the created item and its gradebook column back by the ids Blackboard returned.";
  }
  if (value.schema === "morrow.blackboard.ultra-assignment.comparator.v1") return "Morrow re-read the gradebook of the selected Blackboard course.";
  if (value.schema === "morrow.blackboard.course-membership.v1") return "Morrow read one person's membership of the selected Blackboard course.";
  if (value.schema === "morrow.blackboard.integration-account.v1") return "Morrow read the Blackboard account this connection's server credential acts as.";
  if (value.schema === "morrow.blackboard.membership-patch.plan.v1") return "Morrow prepared one Blackboard course membership change for review. Nothing in the course was changed.";
  if (value.schema === "morrow.blackboard.membership-patch.readback.v1") {
    return "Morrow changed the reviewed Blackboard course membership and read the course role and availability back.";
  }
  if (value.schema === "morrow.blackboard.membership-patch.comparator.v1") return "Morrow re-read the selected Blackboard course membership.";
  if (value.schema === "morrow.blackboard.course-announcements.v1") return "Morrow read the announcements of the selected Blackboard course.";
  if (value.schema === "morrow.blackboard.course-announcement.v1") return "Morrow read one announcement of the selected Blackboard course.";
  if (value.schema === "morrow.blackboard.course-announcement.plan.v1") return "Morrow prepared one Blackboard course announcement for review. Nothing was posted.";
  if (value.schema === "morrow.blackboard.course-announcement.readback.v1") {
    return "Morrow posted the reviewed Blackboard course announcement and read it back by the id Blackboard returned. Morrow cannot recall a sent announcement.";
  }
  if (value.schema === "morrow.blackboard.course-announcement.comparator.v1") return "Morrow re-read the announcements of the selected Blackboard course.";
  if (value.schema === "morrow.blackboard.course-announcement-patch.plan.v1") return "Morrow prepared one Blackboard course announcement change for review. Nothing in the course was changed.";
  if (value.schema === "morrow.blackboard.course-announcement-patch.readback.v1") {
    return "Morrow changed the reviewed Blackboard course announcement and read it back. The announcement learners already received is unchanged.";
  }
  if (value.schema === "morrow.blackboard.course-announcement-patch.comparator.v1") return "Morrow re-read the selected Blackboard course announcement.";
  if (value.schema === "morrow.blackboard.course-groups.v1") return "Morrow read the groups of the selected Blackboard course.";
  if (value.schema === "morrow.blackboard.course-group-sets.v1") return "Morrow read the group sets of the selected Blackboard course.";
  if (value.schema === "morrow.blackboard.course-group.v1") return "Morrow read one group of the selected Blackboard course.";
  if (value.schema === "morrow.blackboard.group-members.v1") return "Morrow read the people in one group of the selected Blackboard course.";
  if (value.schema === "morrow.blackboard.course-group.plan.v1") return "Morrow prepared one new Blackboard course group for review. Nothing was created.";
  if (value.schema === "morrow.blackboard.course-group.readback.v1") {
    return "Morrow created the reviewed Blackboard course group and read it back by the id Blackboard returned.";
  }
  if (value.schema === "morrow.blackboard.course-group.comparator.v1") return "Morrow re-read the groups of the selected Blackboard course.";
  if (value.schema === "morrow.blackboard.course-group-patch.plan.v1") return "Morrow prepared one Blackboard course group change for review. Nothing in the course was changed.";
  if (value.schema === "morrow.blackboard.course-group-patch.readback.v1") {
    return "Morrow changed the reviewed Blackboard course group and read its values back.";
  }
  if (value.schema === "morrow.blackboard.course-group-patch.comparator.v1") return "Morrow re-read the selected Blackboard course group.";
  if (value.schema === "morrow.blackboard.group-membership.plan.v1") return "Morrow prepared putting one person into a Blackboard group for review. Nobody was moved.";
  if (value.schema === "morrow.blackboard.group-membership.readback.v1") {
    return "Morrow put the reviewed person into the Blackboard group and read the group and everyone in it back.";
  }
  if (value.schema === "morrow.blackboard.group-membership.comparator.v1") return "Morrow re-read the people in the selected Blackboard group.";
  if (value.schema === "morrow.blackboard.group-membership-removal.plan.v1") return "Morrow prepared taking one person out of a Blackboard group for review. Nobody was moved.";
  if (value.schema === "morrow.blackboard.group-membership-removal.readback.v1") {
    return "Morrow took the reviewed person out of the Blackboard group and read the group and everyone in it back.";
  }
  if (value.schema === "morrow.blackboard.group-membership-removal.comparator.v1") return "Morrow re-read the people in the selected Blackboard group.";
  if (value.schema === "morrow.blackboard.course-availability-patch.plan.v1") return "Morrow prepared one Blackboard course availability change for review. Nothing in the course was changed.";
  if (value.schema === "morrow.blackboard.course-availability-patch.readback.v1") {
    return "Morrow changed the reviewed Blackboard course availability and read the course back. The result names every frozen value it did not compare.";
  }
  if (value.schema === "morrow.blackboard.course-availability-patch.comparator.v1") return "Morrow re-read the selected Blackboard course's availability.";
  if (value.schema === "morrow.blackboard.content-dates.plan.v1") return "Morrow prepared one Blackboard dated-visibility change for review. Nothing in the course was changed.";
  if (value.schema === "morrow.blackboard.content-dates.readback.v1") {
    return "Morrow changed when learners see the reviewed Blackboard item and read both dates back.";
  }
  if (value.schema === "morrow.blackboard.content-dates.comparator.v1") return "Morrow re-read when learners see the selected Blackboard content item.";
  if (value.schema === "morrow.blackboard.course-copy.plan.v1") return "Morrow prepared one Blackboard course copy for review. Nothing was copied.";
  if (value.schema === "morrow.blackboard.course-copy.readback.v1") {
    return "Morrow copied the reviewed Blackboard course through its Learn task and read the copied course back from the completed task's location.";
  }
  if (value.schema === "morrow.blackboard.course-copy.comparator.v1") return "Morrow re-read the copied Blackboard course by its reviewed Course ID.";
  return "Morrow checked the Blackboard REST connection.";
}

function toolResult(value: JsonObject) {
  return {
    content: [{ type: "text" as const, text: resultSummary(value) }],
    structuredContent: value,
    ...(value.ok === false ? { isError: true } : {}),
  };
}

/** The one Blackboard payload written after a PATCH request has left Morrow. */
const CONTENT_PATCH_READBACK_SCHEMA = "morrow.blackboard.content-patch.readback.v1";

async function execute(action: () => Promise<JsonObject>) {
  try {
    const value = await action();
    // Morrow's operation journal takes the first execution-state marker it finds
    // on a result and otherwise falls back to `status`, which on these payloads
    // is an evidence label ("api_configured_live_untested"), not a record of what
    // reached Blackboard. The readback written after a sent PATCH therefore
    // states its own execution state. The read payloads keep `status` as it is:
    // they send no provider change, and the Gateway freezes the exact
    // verification comparator payload when it plans the operation, so a new
    // field there would break that frozen comparison.
    return toolResult(value.schema === CONTENT_PATCH_READBACK_SCHEMA ? { ...value, resultState: "applied" } : value);
  }
  catch (error) {
    const known = error instanceof BlackboardApiError;
    return toolResult({
      schema: "morrow.blackboard.result.v1",
      ok: false,
      // Morrow's operation journal reads this marker to decide whether a failed
      // Blackboard call may have changed the course. A failure Morrow cannot
      // classify carries no marker, so the Gateway keeps its safe assumption
      // that the change may have landed.
      ...(known ? { resultState: error.dispatchState } : {}),
      problem: {
        code: known ? error.code : "blackboard_request_failed",
        message: known ? error.message : "Morrow could not complete the Blackboard request.",
        ...(known && error.status ? { status: error.status } : {}),
        ...(known && error.diagnostics ? { diagnostics: error.diagnostics } : {}),
      },
    });
  }
}

export function createBlackboardLearnMcpServer(
  runtime: BlackboardLearnRuntime,
  options: { readonly includePrivateDispatch?: boolean } = {},
): McpServer {
  const server = new McpServer({ name: "morrow-blackboard-learn-api", version: "1.0.0" });
  for (const tool of BLACKBOARD_TOOL_DEFINITIONS) {
    // The source-private dispatch routes are excluded from Morrow's public
    // catalog. GatewayRuntime starts this server with them only after it holds
    // a durable reservation, and then adds a signed, one-use effect grant.
    if (tool.gatewayDispatchOnly && !options.includePrivateDispatch) continue;
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      ...(tool.capability ? { _meta: { "io.morrow/capability": tool.capability } } : {}),
    }, async (input, context) => execute(() => tool.run(runtime, input, context.mcpReq.signal)));
  }
  return server;
}
