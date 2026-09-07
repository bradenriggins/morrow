// In-place updates retain every interaction id. Morrow has not verified
// how structural edits merge on a live tenant, so structural changes use
// separate reviewed delete and create operations.
// Chrome injects canvas-content.js as a classic script, so that file keeps
// a second copy. canvas-new-quiz-item-guard.test.mjs checks both copies.

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
