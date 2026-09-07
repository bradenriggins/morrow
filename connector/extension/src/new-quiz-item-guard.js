// The one rule Morrow follows before it changes a Canvas New Quiz item in
// place. Section 2.2 of
// docs/research/CANVAS-NEW-QUIZZES-ITEM-BANKS-CONTRACT-2026-09-06.md is the
// source.
//
// New Quizzes merges the sub-elements of `interaction_data` by `id`. A PATCH
// that regenerates a choice, question, or blank id therefore does not replace
// the old element. It orphans it into a blank ghost-stub choice, and the stubs
// accumulate on the item.
//
// That behaviour is harvested ExamplePlatform production evidence, dated 1 June 2026,
// when one production item held 10 real choices and 18 blank ones. Morrow has
// not reproduced it on a connected Canvas tenant, so it is live-unverified
// here and is treated as the reason for the rule rather than as a Morrow
// observation.
//
// The rule that follows from it: an in-place PATCH is allowed only when every
// interaction id it found survives the change. The safe structural change is
// delete-then-add, because a clean delete never merges.
//
// Chrome injects connector/extension/src/canvas-content.js as a classic script
// with no module scope, so that file carries its own copy of both functions.
// scripts/test/canvas-new-quiz-item-guard.test.mjs runs this module and the
// in-page copy against the same inputs and fails if they disagree.

// The four member lists a New Quiz item can carry under `interaction_data`.
// `choices` covers choice, multi-answer, and ordering items, `questions` covers
// matching, and `blanks` or `entries` covers rich fill in the blank.
export const NEW_QUIZ_INTERACTION_ID_GROUPS = Object.freeze(["choices", "questions", "blanks", "entries"]);

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// null means "this member carries no id Canvas could merge it by", which is
// never the same as "its id is unchanged".
function memberId(member) {
  if (!plainObject(member)) return null;
  if (typeof member.id === "number" && Number.isSafeInteger(member.id)) return String(member.id);
  return typeof member.id === "string" && member.id.trim() !== "" && member.id.length <= 200 ? member.id : null;
}

/**
 * The interaction ids one New Quiz item holds, read from `item.entry.interaction_data`.
 *
 * Returns one entry per group present as an array, holding that group's member
 * ids as strings in the order the item lists them, with `null` in the place of
 * a member that carries no usable id. A group the item does not carry as an
 * array is absent from the result, so an item with no `interaction_data` at all
 * returns `{}`.
 */
export function newQuizInteractionIds(item) {
  const entry = plainObject(item) ? item.entry : null;
  const interaction = plainObject(entry) ? entry.interaction_data : null;
  const ids = {};
  if (!plainObject(interaction)) return ids;
  for (const group of NEW_QUIZ_INTERACTION_ID_GROUPS) {
    if (Array.isArray(interaction[group])) ids[group] = interaction[group].map(memberId);
  }
  return ids;
}

/**
 * True only when `after` keeps exactly the interaction ids `before` holds.
 *
 * The comparison is by set, not by order: Canvas merges by id, so moving a
 * choice within its list changes nothing Canvas matches on. Every other
 * difference is refused, including a group that appears or disappears, a
 * duplicate id, and a member with no usable id, because none of those can be
 * matched to the element it is meant to replace.
 */
export function newQuizIdsPreserved(before, after) {
  const left = newQuizInteractionIds(before);
  const right = newQuizInteractionIds(after);
  for (const group of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const leftIds = left[group];
    const rightIds = right[group];
    if (!leftIds || !rightIds) return false;
    if (leftIds.includes(null) || rightIds.includes(null)) return false;
    const leftSet = new Set(leftIds);
    const rightSet = new Set(rightIds);
    if (leftSet.size !== leftIds.length || rightSet.size !== rightIds.length) return false;
    if (leftSet.size !== rightSet.size || [...leftSet].some((id) => !rightSet.has(id))) return false;
  }
  return true;
}
