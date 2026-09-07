import { blackboardAnnouncementsModule } from "./announcements.js";
import { blackboardAssignmentsModule } from "./assignments.js";
import { blackboardContentPatchModule } from "./content-patch.js";
import { blackboardCourseContentsModule } from "./course-contents.js";
import { blackboardCourseLifecycleModule } from "./course-lifecycle.js";
import { blackboardCourseReadModule } from "./course-read.js";
import { blackboardEffectReceiptsModule } from "./effect-receipts.js";
import { blackboardFilesModule } from "./files.js";
import { blackboardGradebookModule } from "./gradebook.js";
import { blackboardGroupsModule } from "./groups.js";
import { blackboardHealthModule } from "./health.js";
import { blackboardMembershipsModule } from "./memberships.js";
import type { BlackboardOperationModule, BlackboardToolDefinition } from "./definition.js";

export {
  blackboardTool,
  contentScopeInput,
  effectGrantInput,
  patchInput,
  scopeInput,
  type BlackboardOperationModule,
  type BlackboardRestRoute,
  type BlackboardToolDefinition,
} from "./definition.js";

/** Every Blackboard operation domain this server serves, in registration order. */
export const BLACKBOARD_OPERATION_MODULES: readonly BlackboardOperationModule[] = Object.freeze([
  blackboardHealthModule,
  blackboardCourseReadModule,
  blackboardCourseContentsModule,
  blackboardMembershipsModule,
  blackboardGradebookModule,
  blackboardFilesModule,
  blackboardAssignmentsModule,
  blackboardAnnouncementsModule,
  blackboardGroupsModule,
  blackboardCourseLifecycleModule,
  blackboardContentPatchModule,
  blackboardEffectReceiptsModule,
]);

/**
 * Every registered tool. `src/server.ts` registers this list in order, and
 * `scripts/blackboard-catalog.mjs` writes one catalog row for each entry.
 */
export const BLACKBOARD_TOOL_DEFINITIONS: readonly BlackboardToolDefinition[] = Object.freeze(
  BLACKBOARD_OPERATION_MODULES.flatMap((module) => [...module.tools]),
);
