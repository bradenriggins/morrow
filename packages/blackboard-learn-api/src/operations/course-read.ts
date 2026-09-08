import { blackboardTool, contentScopeInput, scopeInput, type BlackboardOperationModule } from "./definition.js";

/** What every Blackboard REST read reports about itself. `operations/course-contents.ts` states the same. */
export const READ_PROFILES = {
  "private-full": { state: "supported" },
  "public-canvas": { state: "profile_limited", reason: "This action needs a configured Blackboard REST tenant." },
  sandbox: { state: "profile_limited", reason: "This action needs a configured Blackboard REST tenant." },
  "read-only": { state: "private_only", reason: "Blackboard REST credentials remain local to this server." },
} as const;

export const READ_BEHAVIOR = {
  readOnly: true, mutating: false, destructive: false, irreversible: false,
  supportsDryRun: false, supportsReadback: false, supportsUndo: false, supportsBatch: false,
  requiresBrowser: false, requiresLiveCanvas: false,
} as const;

export const READ_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

/**
 * The Blackboard course reads. Each one verifies which Learn account this
 * server credential acts as and that account's membership of the selected
 * course before it reads anything, and redacts learner identities out of every
 * value it returns.
 */
export const blackboardCourseReadModule: BlackboardOperationModule = {
  id: "course-read",
  tools: [
    blackboardTool({
      name: "blackboard_read_course",
      title: "Read one Blackboard course",
      description: "Read one selected Blackboard Learn course after a fresh integration-account and course-membership check.",
      private: false,
      gatewayDispatchOnly: false,
      inputSchema: scopeInput,
      annotations: READ_ANNOTATIONS,
      capability: {
        family: "course-read", provider: "blackboard", sourceExport: "GET /learn/api/public/v3/courses/{course_id}",
        behavior: READ_BEHAVIOR,
        authority: { scopeClass: "tenant-course", approvalClass: "none", dataClass: "course" },
        route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
        profiles: READ_PROFILES,
        evidence: { live: { state: "unknown", reason: "api_configured_live_untested" }, credentialBoundary: { state: "known" } },
      },
      rest: {
        method: "GET",
        pathTemplate: "/learn/api/public/v3/courses/{course_id}?fields=id,courseId,name,description",
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => runtime.readCourse({
        tenantId: input.tenant_id,
        sourceBindingId: input.source_binding_id,
        courseId: input.course_id,
      }, signal),
    }),
    blackboardTool({
      name: "blackboard_list_course_contents",
      title: "List Blackboard course content",
      description: "List content for one selected Blackboard Learn course after a fresh integration-account and course-membership check. Learner identities are redacted before output.",
      private: false,
      gatewayDispatchOnly: false,
      inputSchema: scopeInput,
      annotations: READ_ANNOTATIONS,
      capability: {
        family: "course-read", provider: "blackboard", sourceExport: "GET /learn/api/public/v1/courses/{course_id}/contents?recursive=false",
        behavior: READ_BEHAVIOR,
        authority: { scopeClass: "tenant-course", approvalClass: "none", dataClass: "course" },
        route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
        profiles: READ_PROFILES,
        evidence: { live: { state: "unknown", reason: "api_configured_live_untested" }, credentialBoundary: { state: "known" } },
      },
      rest: {
        method: "GET",
        pathTemplate: "/learn/api/public/v1/courses/{course_id}/contents?recursive=false",
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => runtime.listContents({
        tenantId: input.tenant_id,
        sourceBindingId: input.source_binding_id,
        courseId: input.course_id,
      }, signal),
    }),
    blackboardTool({
      name: "blackboard_read_course_content",
      title: "Read one Blackboard course content item",
      description: "Read one selected Blackboard Learn content item after a fresh integration-account and course-membership check. Learner identities are redacted before output.",
      private: false,
      gatewayDispatchOnly: false,
      inputSchema: contentScopeInput,
      annotations: READ_ANNOTATIONS,
      capability: {
        family: "course-read", provider: "blackboard", sourceExport: "GET /learn/api/public/v1/courses/{course_id}/contents/{content_id}",
        behavior: READ_BEHAVIOR,
        authority: { scopeClass: "tenant-course", approvalClass: "none", dataClass: "course" },
        route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
        profiles: READ_PROFILES,
        evidence: { live: { state: "unknown", reason: "api_configured_live_untested" }, credentialBoundary: { state: "known" } },
      },
      rest: {
        method: "GET",
        pathTemplate: "/learn/api/public/v1/courses/{course_id}/contents/{content_id}",
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => runtime.readContent({
        tenantId: input.tenant_id,
        sourceBindingId: input.source_binding_id,
        courseId: input.course_id,
        contentId: input.content_id,
      }, signal),
    }),
  ],
};
