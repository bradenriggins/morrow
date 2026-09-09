import { timingSafeEqual } from "node:crypto";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import {
  LearnerRoster, LearnerVault, normalizeLearnerIdentity, redactLearnerEgress, resolveLearnerTokens,
  type LearnerIdentity, type LearnerTextRedactionContext,
} from "./privacy.js";

export const INTERNAL_SOURCE_CAPABILITY_META = "io.morrow/internal-source-capability";

export interface SourcePrivacyBinding {
  readonly sourceBindingId: string;
  readonly provider?: string;
  readonly courseId?: string;
  readonly runtimeVerified?: boolean;
  readonly origin?: string;
  readonly siteUrl?: string;
  readonly principalFingerprint?: string;
  readonly accountFingerprint?: string;
  readonly sessionGeneration?: number;
  readonly catalogDigest?: string;
}

export interface SourceMcpPrivacyOptions {
  readonly source: string;
  readonly internalSourceCapability?: string;
  readonly learnerVaultPath?: string;
  readonly bindings: () => readonly SourcePrivacyBinding[];
  readonly acceptsCourseRequest?: (toolName: string, args: Readonly<Record<string, unknown>>, binding: SourcePrivacyBinding) => boolean;
  readonly loadRoster: (binding: SourcePrivacyBinding) => Promise<readonly LearnerIdentity[]>;
}

export function sourcePrivacyRoster(value: unknown): readonly LearnerIdentity[] {
  if (!Array.isArray(value) || value.length > 50_000) throw new Error("privacy_roster_invalid");
  const seen = new Set<string>();
  return value.map((entry) => {
    if (!isJsonObject(entry) || !["string", "number"].includes(typeof entry.id) || !String(entry.id).trim()) {
      throw new Error("privacy_roster_invalid");
    }
    const id = String(entry.id);
    if (seen.has(id)) throw new Error("privacy_roster_duplicate");
    seen.add(id);
    const text = (key: string): string | undefined => {
      const candidate = entry[key];
      if (candidate == null || candidate === "") return undefined;
      if (typeof candidate !== "string" || !candidate.trim() || candidate.length > 500) throw new Error("privacy_roster_invalid");
      return candidate.trim();
    };
    const aliasFields = ["sortable_name", "short_name", "display_name", "full_name", "fullname", "username", "integration_id", "sis_login_id", "idnumber", "first_name", "last_name", "firstname", "lastname", "uuid"];
    if (entry.aliases != null && (!Array.isArray(entry.aliases) || entry.aliases.some((alias) => typeof alias !== "string" || !alias.trim() || alias.length > 500))) {
      throw new Error("privacy_roster_invalid");
    }
    if (!text("name") && !text("fullname")) throw new Error("privacy_roster_name_required");
    return normalizeLearnerIdentity({
      id,
      name: text("name") ?? text("fullname"),
      email: text("email"),
      loginId: text("login_id") ?? text("loginId"),
      sisUserId: text("sis_user_id") ?? text("sisUserId"),
      aliases: [...aliasFields.flatMap((key) => text(key) ? [text(key)!] : []), ...(Array.isArray(entry.aliases) ? entry.aliases as string[] : [])],
    });
  });
}

/** Course enrollment history includes students absent from the current Users roster. */
export function canvasPrivacyRoster(currentUsers: unknown, deletedEnrollments: unknown, courseId: string): readonly LearnerIdentity[] {
  if (!/^[1-9][0-9]*$/u.test(courseId) || !Array.isArray(deletedEnrollments) || deletedEnrollments.length > 50_000) {
    throw new Error("privacy_roster_history_invalid");
  }
  const identities = new Map(sourcePrivacyRoster(currentUsers).map((identity) => [identity.id, identity]));
  for (const enrollment of deletedEnrollments) {
    if (!isJsonObject(enrollment) || String(enrollment.course_id) !== courseId || enrollment.type !== "StudentEnrollment"
      || enrollment.enrollment_state !== "deleted" || !isJsonObject(enrollment.user)
      || !/^[1-9][0-9]*$/u.test(String(enrollment.user_id)) || String(enrollment.user.id) !== String(enrollment.user_id)) {
      throw new Error("privacy_roster_history_mismatch");
    }
    const user = { ...enrollment.user };
    if (enrollment.sis_user_id != null && enrollment.sis_user_id !== "") {
      if (user.sis_user_id != null && user.sis_user_id !== "" && user.sis_user_id !== enrollment.sis_user_id) {
        throw new Error("privacy_roster_history_conflict");
      }
      user.sis_user_id = enrollment.sis_user_id;
    }
    const identity = sourcePrivacyRoster([user])[0]!;
    const current = identities.get(identity.id);
    if (!current) {
      identities.set(identity.id, identity);
      continue;
    }
    for (const field of ["name", "email", "loginId", "sisUserId"] as const) {
      if (current[field] && identity[field] && current[field] !== identity[field]) throw new Error("privacy_roster_history_conflict");
    }
    identities.set(identity.id, normalizeLearnerIdentity({
      id: identity.id,
      name: current.name ?? identity.name,
      email: current.email ?? identity.email,
      loginId: current.loginId ?? identity.loginId,
      sisUserId: current.sisUserId ?? identity.sisUserId,
      aliases: [...new Set([...(current.aliases ?? []), ...(identity.aliases ?? [])])],
    }));
  }
  return [...identities.values()];
}

const MOODLE_CURRENT_ROSTER_READS = new Set([
  "moodle_get_course_participant_roster", "moodle_get_course_participants", "moodle_get_enrolment_methods",
  "moodle_get_participant_enrolment", "moodle_get_course_groups", "moodle_get_course_groupings", "moodle_get_course_dates_report",
]);
const MOODLE_LEARNER_AUTHORED_READS = new Set([
  "moodle_list_glossary_entries", "moodle_get_glossary_entry", "moodle_list_wiki_pages", "moodle_get_wiki_page",
]);

/** Moodle retains visible contributions after unenrolment; its Participants table is not a history dictionary. */
export function moodleSourceHistoryAvailable(toolName: string, dataClass?: string): boolean {
  if (MOODLE_CURRENT_ROSTER_READS.has(toolName)) return true;
  return dataClass !== "learner" && !MOODLE_LEARNER_AUTHORED_READS.has(toolName)
    && !/^moodle_.*(?:submission|assignment_feedback|quiz_attempt|manual_grading_queue|regrade_report|forum_posts|forum_post_target|forum_activity_summary|scorm_learner_report|scorm_attempt_summary|learner_grade_report|grade_report_summary|response_summary|entry_summary|course_activity_report|course_participation_report|course_completion_report|course_log_summary|message|conversation|history)/u.test(toolName);
}

/** Extend only learner identifier positions; course and object identifiers retain their contract. */
export function sourcePrivacyInputSchema(schema: JsonObject): JsonObject {
  const walk = (value: unknown, key = ""): unknown => {
    if (Array.isArray(value)) return value.map((entry) => walk(entry, key));
    if (!isJsonObject(value)) return value;
    const output = Object.fromEntries(Object.entries(value).map(([field, child]) => [field,
      field === "properties" && isJsonObject(child)
        ? Object.fromEntries(Object.entries(child).map(([name, definition]) => [name, walk(definition, name)]))
        : walk(child, key)]));
    if (/^(?:user|student|learner|recipient|author|participant)(?:s|_?ids?)?$/iu.test(key)
      && value.type !== "array" && (value.type === "number" || value.type === "integer" || value.type === "string")) {
      return { anyOf: [output, { type: "string", pattern: "^Student A[1-9][0-9]*$" }],
        description: "Use the course learner pseudonym returned by Morrow." };
    }
    return output;
  };
  return walk(schema) as JsonObject;
}

function failure(): JsonObject {
  return {
    isError: true,
    content: [{ type: "text", text: "Morrow refused this source request because its course privacy boundary could not be verified." }],
    structuredContent: { schema: "morrow.problem.v1", ok: false, code: "privacy_source_boundary_refused", recoverable: false },
  };
}

function bindingIdentity(binding: SourcePrivacyBinding): string {
  return JSON.stringify([binding.sourceBindingId, binding.provider, binding.courseId, binding.origin, binding.siteUrl,
    binding.principalFingerprint, binding.accountFingerprint, binding.sessionGeneration, binding.catalogDigest, binding.runtimeVerified]);
}

/** The raw lane is a process capability, never a tool argument or catalog option. */
export class SourceMcpPrivacyBoundary {
  private readonly vault: LearnerVault;
  private readonly capability: Buffer | undefined;

  constructor(private readonly options: SourceMcpPrivacyOptions) {
    if (options.internalSourceCapability !== undefined && !/^[a-f0-9]{64}$/.test(options.internalSourceCapability)) {
      throw new Error("privacy_source_capability_invalid");
    }
    this.vault = new LearnerVault(options.learnerVaultPath);
    this.capability = options.internalSourceCapability === undefined ? undefined : Buffer.from(options.internalSourceCapability, "hex");
  }

  private authenticated(meta: unknown): boolean {
    const supplied = isJsonObject(meta) ? meta[INTERNAL_SOURCE_CAPABILITY_META] : undefined;
    return Boolean(this.capability && typeof supplied === "string" && /^[a-f0-9]{64}$/.test(supplied)
      && timingSafeEqual(this.capability, Buffer.from(supplied, "hex")));
  }

  private async context(binding: SourcePrivacyBinding): Promise<LearnerTextRedactionContext> {
    if (!binding.runtimeVerified || !binding.courseId || !binding.origin || !binding.principalFingerprint
      || !Number.isSafeInteger(binding.sessionGeneration) || !binding.catalogDigest) throw new Error("privacy_binding_invalid");
    const origin = new URL(binding.origin).origin;
    if (origin !== binding.origin || !/^https?:$/.test(new URL(origin).protocol)) throw new Error("privacy_binding_invalid");
    const learnerScope = {
      canvasOrigin: origin,
      account: binding.accountFingerprint || `${this.options.source}:${binding.provider}:${origin}`,
      course: binding.courseId,
      principal: binding.principalFingerprint,
      profile: `source:${this.options.source}`,
    };
    const learnerRoster = new LearnerRoster();
    learnerRoster.register(learnerScope, await this.options.loadRoster(binding));
    this.assertCurrent(binding);
    return { learnerRoster, learnerVault: this.vault, learnerScope };
  }

  private assertCurrent(binding: SourcePrivacyBinding): void {
    const current = this.options.bindings().filter((candidate) => candidate.sourceBindingId === binding.sourceBindingId);
    if (current.length !== 1 || bindingIdentity(current[0]!) !== bindingIdentity(binding)) throw new Error("privacy_binding_changed");
  }

  async invoke(
    toolName: string,
    args: Readonly<Record<string, unknown>>,
    meta: unknown,
    handler: (resolved: Record<string, unknown>) => Promise<unknown>,
  ): Promise<JsonObject> {
    try {
      if (this.authenticated(meta)) {
        const result = await handler({ ...args });
        return isJsonObject(result) ? result : failure();
      }
      if (isJsonObject(meta) && INTERNAL_SOURCE_CAPABILITY_META in meta) return failure();
      if (toolName.endsWith("_health")) {
        return { content: [{ type: "text", text: "Morrow source is available. Course reads require a verified course connection and complete roster." }],
          structuredContent: { ok: true, schema: "morrow.source-public-health.v1" } };
      }
      if (["morrow_canvas_bindings", "morrow_browser_bindings", "morrow_legacy_bindings"].includes(toolName)) {
        const bindings: JsonObject[] = [];
        for (const binding of this.options.bindings()) {
          const context = await this.context(binding);
          const projected = redactLearnerEgress({ sourceBindingId: binding.sourceBindingId, provider: binding.provider, courseId: binding.courseId,
            origin: binding.origin, runtimeVerified: true }, context);
          if (!isJsonObject(projected)) throw new Error("privacy_binding_invalid");
          bindings.push(projected);
        }
        return { content: [{ type: "text", text: "Morrow checked the course connections." }], structuredContent: { ok: true, bindings, count: bindings.length } };
      }
      // These controls take raw private payloads or manage more than one course.
      if (/^(?:morrow_private_|canvas_send_private_|canvas_transfer_course_file|canvas_create_new_quiz_hot_spot|morrow_bridge_maintenance|morrow_browser_edit_policy_set)/.test(toolName)) return failure();
      const controls = isJsonObject(args._morrow) ? args._morrow : {};
      const bindingId = controls.source_binding_id ?? args.source_binding_id;
      const matches = this.options.bindings().filter((binding) => binding.sourceBindingId === bindingId);
      if (matches.length !== 1) return failure();
      const binding = { ...matches[0]! };
      const requestedCourse = args.course_id ?? args.courseId;
      if (requestedCourse != null && String(requestedCourse) !== binding.courseId) return failure();
      if (this.options.acceptsCourseRequest && !this.options.acceptsCourseRequest(toolName, args, binding)) return failure();
      const context = await this.context(binding);
      const resolved = resolveLearnerTokens(args, this.vault, context.learnerScope, context.learnerRoster);
      const result = await handler(resolved);
      this.assertCurrent(binding);
      // Legacy donor tokens have no identity proof in this source vault.
      if (/\bStudent_[A-Za-z0-9_-]+\b/.test(JSON.stringify(result))) return failure();
      const projected = redactLearnerEgress(result, context);
      return isJsonObject(projected) && !JSON.stringify(projected).includes("[learner]") ? projected : failure();
    } catch {
      // Never copy an upstream exception into an MCP error, including raw-lane errors.
      return failure();
    }
  }
}
