// The two rules Morrow follows for a write on the Canvas New Quizzes surface
// (`/api/quiz/v1/...`). Sections 2 and 2.1 of
// docs/research/CANVAS-NEW-QUIZZES-ITEM-BANKS-CONTRACT-2026-09-06.md are the
// source for both.
//
// Chrome injects connector/extension/src/canvas-content.js as a classic script
// with no module scope, so that file carries its own copy of both rules.
// scripts/test/canvas-new-quiz-write-contract.test.mjs runs this module and the
// in-page copy against the same inputs and fails if they disagree.

// Rule 1: request encoding.
//
// New Quizzes is a separate service from the Canvas Rails API. The harvested
// client sends a JSON body for every `/api/quiz/v1` write it makes, and nothing
// in the harvest shows that the service parses Rails-style bracketed form
// parameters. Morrow therefore sends JSON for every POST and PATCH on that
// surface, not only for the two item routes.
//
// This is live-unverified in both directions. No Morrow-connected Canvas tenant
// has run a New Quizzes write with either encoding, so the harvested client is
// the only evidence there is. The whole rule is this one function, so one edit
// reverses it.
export function newQuizUsesJsonBody(operation) {
  return operation?.family === "new-quizzes"
    && typeof operation.path === "string" && operation.path.startsWith("/quiz/v1/")
    && ["POST", "PATCH"].includes(operation.method);
}

// Rule 2: the quiz_settings merge.
//
// A partial `quiz_settings` PATCH can replace the whole block instead of
// merging into it, so a change to one setting can delete every setting nobody
// asked to change. Losing `result_view_settings` on a published quiz changes
// what learners see of their own results. Whether the service merges or
// replaces is live-unverified, which is exactly why Morrow never sends a
// partial block: it reads the current settings, merges the requested change
// into them, and sends the complete block.
//
// These three groups nest one level below `quiz_settings` in the Canvas
// definition. A change inside one of them merges at the leaf, so changing
// `result_view_settings.display_items` keeps the other result-view settings.
export const NEW_QUIZ_SETTINGS_MERGE_GROUPS = Object.freeze(["filters", "multiple_attempts", "result_view_settings"]);

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Merges `requested` into `current` at the leaf level and names what was kept.
 *
 * `merged` is the complete settings block to send. `preserved` is the sorted
 * list of keys whose value came from `current`, written as `group.leaf` inside
 * a nested group, so a person can read exactly which settings Morrow carried
 * over rather than trusting that it carried them.
 */
export function mergeQuizSettings(current, requested) {
  const base = plainObject(current) ? current : {};
  const change = plainObject(requested) ? requested : {};
  const merged = { ...base, ...change };
  const preserved = [];
  for (const key of Object.keys(base)) {
    const grouped = NEW_QUIZ_SETTINGS_MERGE_GROUPS.includes(key) && plainObject(base[key]);
    if (grouped && plainObject(change[key])) {
      merged[key] = { ...base[key], ...change[key] };
      for (const leaf of Object.keys(base[key])) {
        if (!Object.hasOwn(change[key], leaf)) preserved.push(`${key}.${leaf}`);
      }
    } else if (Object.hasOwn(change, key)) {
      // The caller replaced the whole value, group or not, so nothing here was kept.
    } else if (grouped) {
      for (const leaf of Object.keys(base[key])) preserved.push(`${key}.${leaf}`);
    } else {
      preserved.push(key);
    }
  }
  return { merged, preserved: preserved.sort() };
}

// Copied from connector/extension/src/edit-policy.js. Both copies must produce
// the same bytes for the same value.
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * The exact string the settings guard digest is taken over.
 *
 * A caller that wants to change New Quiz settings reads the quiz, takes
 * SHA-256 over this string in lowercase hex, and sends it as
 * `morrow_new_quiz_settings_guard.current_quiz_settings_sha256`. The connector
 * reads the quiz again immediately before dispatch and refuses the change when
 * the two do not match, so a settings block that moved between the caller's
 * read and the send is never merged into.
 */
export function newQuizSettingsDigestSource(quizSettings) {
  return stable(plainObject(quizSettings) ? quizSettings : {});
}
