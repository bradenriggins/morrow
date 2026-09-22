import { isJsonObject, type JsonObject } from "@morrow/contracts";
import { BLACKBOARD_ID, BlackboardApiError } from "./types.js";

/**
 * The Blackboard response facts Morrow depends on. This mirrors the checked
 * contract artifact and keeps provider vocabulary out of operation modules.
 */
export const BLACKBOARD_PROVIDER_CONTRACT = Object.freeze({
  schema: "morrow.blackboard.provider-contract.v1",
  source: Object.freeze({
    url: "https://devportal-docstore.s3.amazonaws.com/learn-swagger.json",
    version: "4000.21.0",
    sha256: "303fd4f8323ddee7b72d49b17deb8022752a67f52dcf0e4c2f35518fdcd9cf31",
  }),
  groupMembership: Object.freeze({ identityField: "userId", fields: Object.freeze(["userId", "user"]) }),
  content: Object.freeze({ identityField: "id", pathScoped: true, courseIdField: null }),
  assignmentCreate: Object.freeze({
    contentIdField: "contentId",
    gradeColumnIdField: "gradeColumnId",
    optionalAssessmentIdField: "assessmentId",
  }),
  announcementDuration: Object.freeze({
    provider: Object.freeze(["Permanent", "Restricted"]),
    public: Object.freeze(["Continuous", "DateRange"]),
  }),
  grade: Object.freeze({
    displayField: "displayGrade",
    displayFields: Object.freeze(["score", "possible", "scaleType", "text"]),
    overrideFields: Object.freeze(["score", "text"]),
  }),
});

export type BlackboardCollectionIdentityField = "id" | "userId";
export const BLACKBOARD_GROUP_MEMBERSHIP_IDENTITY_FIELD: BlackboardCollectionIdentityField = "userId";

/** A Content record is scoped by its exact request path and returned identity. */
export function pathScopedContentMatches(record: JsonObject, courseId: string, contentId: string): boolean {
  return record.id === contentId && BLACKBOARD_ID.test(contentId)
    && (record.courseId === undefined || record.courseId === courseId);
}

/** Refuses a Content record that conflicts with the exact course path that returned it. */
export function assertPathScopedContent(record: JsonObject, courseId: string, contentId: string): void {
  if (record.id !== contentId || !BLACKBOARD_ID.test(contentId)) {
    throw new BlackboardApiError("blackboard_content_mismatch", "Blackboard returned a different content item than the one Morrow asked for.");
  }
  if (record.courseId !== undefined && record.courseId !== courseId) {
    throw new BlackboardApiError("blackboard_scope_binding_mismatch", "Blackboard returned a content item that conflicts with the selected course path.");
  }
}

/** The exact provider identities returned by Ultra assignment creation. */
export function assignmentCreateIdentity(record: JsonObject | null): {
  readonly contentId: string | null;
  readonly gradeColumnId: string | null;
  readonly assessmentId: string | null;
} {
  const exact = (value: unknown): string | null => typeof value === "string" && BLACKBOARD_ID.test(value) ? value : null;
  return {
    contentId: exact(record?.contentId),
    gradeColumnId: exact(record?.gradeColumnId),
    assessmentId: exact(record?.assessmentId),
  };
}

export type BlackboardPublicAnnouncementDuration = "Continuous" | "DateRange";
export type BlackboardProviderAnnouncementDuration = "Permanent" | "Restricted";

export function providerAnnouncementDuration(value: BlackboardPublicAnnouncementDuration): BlackboardProviderAnnouncementDuration {
  return value === "Continuous" ? "Permanent" : "Restricted";
}

export function publicAnnouncementDuration(value: unknown): BlackboardPublicAnnouncementDuration | null {
  if (value === "Permanent") return "Continuous";
  if (value === "Restricted") return "DateRange";
  return null;
}

export interface BlackboardDisplayGrade {
  readonly score?: number;
  readonly possible?: number;
  readonly scaleType?: "Percent" | "Score" | "Tabular" | "Text" | "CompleteIncomplete";
  readonly text?: string;
}

const DISPLAY_SCALE_TYPES = new Set(["Percent", "Score", "Tabular", "Text", "CompleteIncomplete"]);

/** Parses only the normal displayed grade. Top-level score and text are overrides. */
export function displayGrade(record: JsonObject): BlackboardDisplayGrade | null {
  const value = record.displayGrade;
  if (value === undefined || value === null) return null;
  if (!isJsonObject(value)) {
    throw new BlackboardApiError("blackboard_response_invalid", "Blackboard returned an invalid displayed grade.");
  }
  const output: { score?: number; possible?: number; scaleType?: BlackboardDisplayGrade["scaleType"]; text?: string } = {};
  for (const field of ["score", "possible"] as const) {
    const candidate = value[field];
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
      throw new BlackboardApiError("blackboard_response_invalid", `Blackboard returned an invalid displayed grade ${field}.`);
    }
    output[field] = candidate;
  }
  if (value.scaleType !== undefined && value.scaleType !== null) {
    if (typeof value.scaleType !== "string" || !DISPLAY_SCALE_TYPES.has(value.scaleType)) {
      throw new BlackboardApiError("blackboard_response_invalid", "Blackboard returned an invalid displayed grade scale type.");
    }
    output.scaleType = value.scaleType as BlackboardDisplayGrade["scaleType"];
  }
  if (value.text !== undefined && value.text !== null) {
    if (typeof value.text !== "string") {
      throw new BlackboardApiError("blackboard_response_invalid", "Blackboard returned invalid displayed grade text.");
    }
    output.text = value.text;
  }
  return output;
}
