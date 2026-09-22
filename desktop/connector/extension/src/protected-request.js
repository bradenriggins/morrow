const MAX_REQUEST_CHARS = 100_000;
const MAX_IDENTITIES = 50_000;
const ROSTER_MAX_AGE_MS = 60_000;
const IDENTITY_KEY = /^(?:learner|student|user|recipient|author|participant)(?:_?(?:name|email|login|login_id|sis_user_id|school_id|id)|s|_?ids?)$/iu;

function fail(code) {
  throw new Error(code);
}

function text(value, code) {
  if (typeof value !== "string") fail(code);
  const output = value.trim();
  if (!output || output.length > 500 || /[\u0000-\u001f\u007f]/u.test(output)) fail(code);
  return output;
}

function optionalText(value, code) {
  if (value === undefined || value === null || value === "") return undefined;
  return text(value, code);
}

// Accents fold away on both sides, so "Jose Garcia" matches the rostered "José García".
function fold(value) {
  return String(value).normalize("NFKD").replace(/\p{M}/gu, "").normalize("NFKC");
}

function normalize(value) {
  return fold(value).trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

// Given names and family names that are also everyday English words. One of these
// alone names a student only where it is written as a name.
const COMMON_NAME_WORDS = new Set(("will grant rose mark bill faith hope joy may june april august grace brook dean frank "
  + "iris jack lane long young white black brown green gray grey king hunter rich sky summer winter autumn ray amber dawn "
  + "eve holly ivy lily pat rob sue sunny wade chase cash drew glen heath penny ruby sage star storm stone wolf fox bird "
  + "bush ford hall hill wood park rice cook baker miller carter mason porter turner walker ward price bell banks marsh "
  + "moss reed rush sharp short strong swift bond best love hart page cross field fields gold house north south west east "
  + "early day knight noble major miles hunt gene art don max jean rusty dusty honey cherry melody harmony destiny "
  + "trinity justice liberty journey river ocean forest rain snow case bay lake key law lord story rivers faith hazel "
  + "olive pearl violet willow jade crystal sterling cole lee may summers love bishop chance dale dell doll free golden "
  + "grant hardy hope lamb ladd little lucky mercy new nice ransom read royal sly smart spring sweet tender true").split(" "));

// Capitalized words in a request that are almost never a person's name.
const NOT_NAME_WORDS = new Set(("monday tuesday wednesday thursday friday saturday sunday january february march april "
  + "may june july august september october november december canvas moodle blackboard morrow chrome google zoom teams "
  + "english spanish french german math mathematics algebra calculus biology chemistry physics history science art music "
  + "student students course courses module modules unit units chapter week weeks quiz quizzes exam exams test tests "
  + "assignment assignments discussion discussions page pages section sections lab labs final finals midterm project "
  + "projects essay essays grade grades gradebook rubric syllabus announcement announcements mr mrs ms mx dr professor "
  + "prof i ok ta am pm yes no thanks thank hi hello dear please the a an and but or if so then also this that these "
  + "those what why how when where who which can could would should did does do is are was were has have had let make "
  + "show list find review compare check ask tell send give email message help note new my our their his her it we they "
  + "you your he she today tomorrow yesterday morning afternoon evening spring summer fall winter autumn semester term "
  + "part question questions answer answers extra credit late due draft group groups team teams for on in at by to from "
  + "with about after before during all any each every some most more less first second third last next").split(" "));

function learnerNameAliases(identity) {
  const name = normalize(identity.name);
  const aliases = new Set([name]);
  const comma = /^([^,]+),\s*(.+)$/u.exec(name);
  if (comma) {
    aliases.add(`${comma[2]} ${comma[1]}`);
    aliases.add(comma[1]);
    aliases.add(comma[2].split(/\s+/u)[0]);
  } else {
    const parts = name.split(" ");
    if (parts.length > 1) {
      aliases.add(`${parts.at(-1)} ${parts.slice(0, -1).join(" ")}`);
      aliases.add(parts[0]);
      aliases.add(parts.at(-1));
    }
  }
  return [...aliases].filter((alias) => (alias.match(/\p{L}/gu)?.length || 0) >= 2);
}

function exactIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("protected_request_roster_invalid");
  const id = text(String(value.id ?? ""), "protected_request_roster_invalid");
  const name = optionalText(value.name ?? value.fullname, "protected_request_roster_invalid");
  if (!name) fail("protected_request_roster_incomplete");
  const aliases = value.aliases === undefined ? [] : value.aliases;
  if (!Array.isArray(aliases) || aliases.length > 100
    || aliases.some((alias) => typeof alias !== "string" || !alias.trim() || alias.length > 500)) {
    fail("protected_request_roster_invalid");
  }
  return {
    id,
    name,
    ...(optionalText(value.email, "protected_request_roster_invalid") ? { email: value.email.trim() } : {}),
    ...(optionalText(value.loginId ?? value.login_id, "protected_request_roster_invalid") ? { loginId: (value.loginId ?? value.login_id).trim() } : {}),
    ...(optionalText(value.sisUserId ?? value.sis_user_id, "protected_request_roster_invalid") ? { sisUserId: (value.sisUserId ?? value.sis_user_id).trim() } : {}),
    aliases: [...new Set(aliases.map((alias) => alias.trim()))],
  };
}

export function sourceProtectedRoster(value) {
  if (!Array.isArray(value) || value.length > MAX_IDENTITIES) fail("protected_request_roster_invalid");
  const seen = new Set();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("protected_request_roster_invalid");
    const aliasFields = ["sortable_name", "short_name", "display_name", "full_name", "username", "integration_id", "sis_login_id", "idnumber", "first_name", "last_name", "firstname", "lastname", "uuid"];
    const aliases = aliasFields.flatMap((key) => entry[key] === undefined || entry[key] === null || entry[key] === ""
      ? [] : [text(entry[key], "protected_request_roster_invalid")]);
    if (entry.aliases !== undefined) {
      if (!Array.isArray(entry.aliases)) fail("protected_request_roster_invalid");
      aliases.push(...entry.aliases);
    }
    const identity = exactIdentity({
      id: entry.id,
      name: entry.name ?? entry.fullname,
      email: entry.email,
      loginId: entry.login_id ?? entry.loginId,
      sisUserId: entry.sis_user_id ?? entry.sisUserId,
      aliases,
    });
    if (seen.has(identity.id)) fail("protected_request_roster_duplicate");
    seen.add(identity.id);
    return identity;
  });
}

export function canvasProtectedRoster(currentUsers, deletedEnrollments, courseId) {
  if (!/^[1-9][0-9]*$/u.test(String(courseId)) || !Array.isArray(deletedEnrollments)
    || deletedEnrollments.length > MAX_IDENTITIES) fail("protected_request_roster_history_invalid");
  const identities = new Map(sourceProtectedRoster(currentUsers).map((identity) => [identity.id, identity]));
  for (const enrollment of deletedEnrollments) {
    if (!enrollment || typeof enrollment !== "object" || Array.isArray(enrollment)
      || String(enrollment.course_id) !== String(courseId) || enrollment.type !== "StudentEnrollment"
      || enrollment.enrollment_state !== "deleted" || !enrollment.user || typeof enrollment.user !== "object"
      || String(enrollment.user_id) !== String(enrollment.user.id)) {
      fail("protected_request_roster_history_mismatch");
    }
    const user = { ...enrollment.user, sis_user_id: enrollment.user.sis_user_id ?? enrollment.sis_user_id };
    const identity = sourceProtectedRoster([user])[0];
    const prior = identities.get(identity.id);
    if (!prior) {
      identities.set(identity.id, identity);
      continue;
    }
    for (const field of ["name", "email", "loginId", "sisUserId"]) {
      if (prior[field] && identity[field] && normalize(prior[field]) !== normalize(identity[field])) {
        fail("protected_request_roster_history_conflict");
      }
    }
    identities.set(identity.id, exactIdentity({
      id: identity.id,
      name: prior.name ?? identity.name,
      email: prior.email ?? identity.email,
      loginId: prior.loginId ?? identity.loginId,
      sisUserId: prior.sisUserId ?? identity.sisUserId,
      aliases: [...new Set([...(prior.aliases || []), ...(identity.aliases || [])])],
    }));
  }
  return [...identities.values()];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function aliasPattern(alias) {
  return escapeRegExp(alias).replace(/ /gu, "\\s+");
}

function boundaryPattern(alias, flags = "giu") {
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${aliasPattern(alias)})(?![\\p{L}\\p{N}_])`, flags);
}

/** A folded copy of the text whose every UTF-16 unit remembers its source range. */
function foldedView(value) {
  let text = "";
  const spans = [];
  let offset = 0;
  for (const point of value) {
    const folded = fold(point);
    for (let index = 0; index < folded.length; index += 1) spans.push([offset, offset + point.length]);
    text += folded;
    offset += point.length;
  }
  return { text, spans };
}

function sourceRange(view, start, end) {
  return [view.spans[start][0], view.spans[end - 1][1]];
}

function sentenceStart(text, index) {
  const before = text.slice(0, index).replace(/[ \t"“‘(\[]+$/u, "");
  return !before || /[.!?\n…]["”’)\]]?$/u.test(before);
}

function capitalizedWords(text) {
  return text.split(/\s+/u).every((word) => /^\p{Lu}/u.test(word));
}

function aliasKind(value, identity) {
  const key = normalize(value);
  if (/^student a[1-9][0-9]*$/u.test(key)) return "label";
  if (/^[0-9]+$/u.test(key)) return "number";
  const nameKeys = new Set([identity.name, ...learnerNameAliases(identity)].map(normalize));
  const nameLike = nameKeys.has(key) || /^[\p{L}' ,.-]+$/u.test(key) && ![identity.email, identity.loginId, identity.sisUserId]
    .filter(Boolean).map(normalize).includes(key);
  if (!nameLike) return "other";
  return /^[\p{L}'-]+$/u.test(key) ? "part" : "name";
}

/**
 * Every roster reference in the text that names one student. A name made only of
 * everyday words, such as "Will Grant", counts only where it is written as a name,
 * so "will get a grant" stays as written. A lone everyday name word at the start of
 * a sentence could be either, so it is reported instead of replaced.
 */
function aliasMatches(value, index, asserted, flagged) {
  const view = foldedView(value);
  const candidates = [...index.aliases.keys()]
    .filter((alias) => index.kinds.get(alias) !== "number" || asserted.has(alias))
    .sort((left, right) => right.length - left.length);
  if (!candidates.length) return [];
  const matcher = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${candidates.map(aliasPattern).join("|")})(?![\\p{L}\\p{N}_])`, "giu");
  const output = [];
  for (const match of view.text.matchAll(matcher)) {
    const key = normalize(match[0]);
    const kind = index.kinds.get(key);
    const common = (kind === "part" || kind === "name") && key.split(/[\s,]+/u).filter(Boolean).every((word) => COMMON_NAME_WORDS.has(word));
    if (common && !asserted.has(key)) {
      if (!capitalizedWords(match[0])) continue;
      if (kind === "part" && sentenceStart(view.text, match.index)) {
        flagged.push({ at: sourceRange(view, match.index, match.index + match[0].length)[0], text: value.slice(...sourceRange(view, match.index, match.index + match[0].length)) });
        continue;
      }
    }
    const matches = index.aliases.get(key) || [];
    if (matches.length !== 1) fail("protected_request_identifier_ambiguous");
    const [start, end] = sourceRange(view, match.index, match.index + match[0].length);
    output.push({ start, end, entry: matches[0] });
  }
  return output;
}

function replaceAliases(value, index, usedIds, asserted, flagged = []) {
  const text = value.normalize("NFKC");
  let output = "";
  let cursor = 0;
  for (const { start, end, entry } of aliasMatches(text, index, asserted, flagged)) {
    usedIds.add(entry.identity.id);
    output += text.slice(cursor, start) + entry.label;
    cursor = end;
  }
  return output + text.slice(cursor);
}

function labelMap(value, code) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length > MAX_IDENTITIES
    || Object.entries(value).some(([id, label]) => !id || id.length > 500 || typeof label !== "string" || !/^Student A[1-9][0-9]*$/u.test(label))
    || new Set(Object.values(value)).size !== Object.keys(value).length) {
    fail(code);
  }
  return value;
}

/**
 * The roster lookup for one request. When the gateway supplied its course labels,
 * each student keeps that one label, the same one every tool result shows.
 */
function aliasIndex(roster, priorLabels, assignedLabels) {
  priorLabels = labelMap(priorLabels, "protected_request_label_map_invalid");
  const assigned = assignedLabels === undefined ? null : labelMap(assignedLabels, "protected_request_label_map_invalid");
  const aliases = new Map();
  const kinds = new Map();
  const byId = new Map();
  const labelsById = { ...priorLabels };
  let nextLabel = Math.max(0, ...Object.values(labelsById).map((label) => Number(label.slice("Student A".length)))) + 1;
  roster.forEach((raw) => {
    const identity = exactIdentity(raw);
    if (byId.has(identity.id)) fail("protected_request_roster_duplicate");
    if (assigned && priorLabels[identity.id] && assigned[identity.id] && priorLabels[identity.id] !== assigned[identity.id]) {
      fail("protected_request_label_changed");
    }
    const label = assigned
      ? assigned[identity.id] || priorLabels[identity.id] || null
      : labelsById[identity.id] || `Student A${nextLabel++}`;
    if (label) labelsById[identity.id] = label;
    const entry = { identity, label: label || "" };
    byId.set(identity.id, entry);
    const values = [label, identity.id, identity.name, identity.email, identity.loginId, identity.sisUserId,
      ...identity.aliases, ...learnerNameAliases(identity)].filter(Boolean);
    for (const value of values) {
      const key = normalize(value);
      if (!key) continue;
      const matches = aliases.get(key) || [];
      if (!matches.some((candidate) => candidate.identity.id === identity.id)) matches.push(entry);
      aliases.set(key, matches);
      if (!kinds.has(key)) kinds.set(key, aliasKind(value, identity));
    }
  });
  return { aliases, kinds, byId, labelsById };
}

function exactAlias(value, aliases) {
  const matches = aliases.get(normalize(value)) || [];
  if (matches.length > 1) fail("protected_request_identifier_ambiguous");
  if (matches.length === 0) fail("protected_request_identifier_unknown");
  return matches[0];
}

function containsAlias(value, alias) {
  return boundaryPattern(alias).test(fold(value.normalize("NFKC")));
}

// A number this long in a request is a platform id, not a count or a score. A word
// before it that names a course object says whose id it is.
const BARE_ID = /(?<![\p{L}\p{N}_/=.#:%&-])([0-9]{5,500})(?![\p{L}\p{N}_/.%])/gu;
const OBJECT_WORD = /\b(?:course|courses|assignment|assignments|quiz|quizzes|module|modules|page|pages|file|files|section|sections|group|groups|item|items|question|questions|rubric|outcome|term|account|attempt|version|order|room|zip|phone|ext)\s*$/iu;

function replaceContextualIds(value, byId, usedIds) {
  const patterns = [
    /((?:["']?(?:learner|student|user|recipient|enrollment|submission)[_-]?id["']?)\s*[:=]\s*["']?)([0-9]{1,500})/giu,
    /((?:\b(?:learner|student|user|recipient|enrollment|submission|grade)\b\s*(?:id\b\s*)?[#:=]\s*))([0-9]{1,500})\b/giu,
    /((?:\b(?:learners?|students?|users?|recipients?)\b\s*(?:ids?\b\s*)?\s))([0-9]{1,500})\b/giu,
    /(\/(?:users|learners|students)\/)([0-9]{1,500})\b/giu,
  ];
  let output = value;
  for (const pattern of patterns) {
    output = output.replace(pattern, (whole, prefix, id) => {
      const entry = byId.get(id);
      if (entry) usedIds.add(entry.identity.id);
      return entry ? `${prefix}${entry.label}` : whole;
    });
  }
  return output.replace(BARE_ID, (whole, id, offset, text) => {
    const entry = byId.get(id);
    if (!entry || OBJECT_WORD.test(text.slice(Math.max(0, offset - 40), offset))) return whole;
    usedIds.add(entry.identity.id);
    return entry.label;
  });
}

/** Capitalized words that look like a name and matched nobody on the roster. */
function unmatchedNameWords(value) {
  const text = value.replace(/\bStudent A[1-9][0-9]*\b/gu, (label) => "x".padEnd(label.length, " "));
  const word = /\p{Lu}[\p{Ll}\p{M}]+(?:['’-]\p{Lu}?[\p{Ll}\p{M}]+)*/u;
  const found = [];
  for (const run of text.matchAll(new RegExp(`${word.source}(?:[ \\t]+${word.source})*`, "gu"))) {
    const words = run[0].split(/[ \t]+/u);
    let start = run.index;
    let group = [];
    const flush = () => {
      if (group.length && !(group.length === 1 && group[0].start === run.index && sentenceStart(text, run.index))) {
        found.push({ at: group[0].start, text: group.map((entry) => entry.word).join(" ") });
      }
      group = [];
    };
    for (const entry of words) {
      if (NOT_NAME_WORDS.has(normalize(entry))) flush();
      else group.push({ word: entry, start });
      start += entry.length + 1;
    }
    flush();
  }
  return found;
}

function transformStructured(value, index, byId, usedIds, asserted, flagged, key = "", depth = 0) {
  if (depth > 20) fail("protected_request_too_deep");
  if (typeof value === "string") {
    if (IDENTITY_KEY.test(key)) {
      const entry = exactAlias(value, index.aliases);
      usedIds.add(entry.identity.id);
      return entry.label;
    }
    return replaceContextualIds(replaceAliases(value, index, usedIds, asserted, flagged), byId, usedIds);
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && IDENTITY_KEY.test(key)) {
    const entry = byId.get(String(value));
    if (!entry) fail("protected_request_identifier_unknown");
    usedIds.add(entry.identity.id);
    return entry.label;
  }
  if (Array.isArray(value)) return value.map((entry) => transformStructured(entry, index, byId, usedIds, asserted, flagged, key, depth + 1));
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [field, child] of Object.entries(value)) {
    const protectedField = replaceAliases(field, index, usedIds, asserted, flagged);
    if (Object.hasOwn(output, protectedField)) fail("protected_request_key_collision");
    output[protectedField] = transformStructured(child, index, byId, usedIds, asserted, flagged, field, depth + 1);
  }
  return output;
}

function remainingUnknownIdentifier(value) {
  const withoutProtectedLabels = value.replace(/\bStudent A[1-9][0-9]*\b/gu, "[learner]");
  return /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(withoutProtectedLabels)
    || /(?:\b(?:learner|student|user|recipient|enrollment|submission)\b\s*(?:id\b\s*)?[#:=]\s*|["']?(?:learner|student|user|recipient|enrollment|submission)[_-]?id["']?\s*[:=]\s*["']?)[A-Za-z0-9][A-Za-z0-9_.:@-]*/iu.test(withoutProtectedLabels);
}

export function protectLocalRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("protected_request_invalid");
  if (typeof input.sourceBindingId !== "string" || !input.sourceBindingId
    || typeof input.courseId !== "string" || !/^[1-9][0-9]*$/u.test(input.courseId)) {
    fail("protected_request_course_missing");
  }
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  if (!Number.isFinite(input.rosterFreshAt) || input.rosterFreshAt > now || now - input.rosterFreshAt > ROSTER_MAX_AGE_MS) {
    fail("protected_request_roster_stale");
  }
  if (input.rosterComplete !== true || !Array.isArray(input.roster) || input.roster.length === 0) {
    fail("protected_request_roster_incomplete");
  }
  if (typeof input.text !== "string" || !input.text.trim() || input.text.length > MAX_REQUEST_CHARS) {
    fail("protected_request_text_invalid");
  }
  if (!Array.isArray(input.assertedIdentifiers) || input.assertedIdentifiers.length === 0 || input.assertedIdentifiers.length > 100) {
    fail("protected_request_identifiers_required");
  }
  const roster = input.roster.map(exactIdentity).sort((left, right) => left.id.localeCompare(right.id, "en", { numeric: true }));
  const index = aliasIndex(roster, input.labelsById, input.assignedLabelsById);
  const { aliases, byId, labelsById } = index;
  const usedIds = new Set();
  const flagged = [];
  const allowedLabels = new Set(Object.values(input.labelsById || {}));
  const suppliedLabels = input.text.normalize("NFKC").match(/\bstudent\s+a[1-9][0-9]*\b/giu) || [];
  if (suppliedLabels.some((label) => {
    const number = /[1-9][0-9]*\b/u.exec(label)?.[0];
    return !number || !allowedLabels.has(`Student A${number}`);
  })) fail("protected_request_existing_label_refused");
  const asserted = input.assertedIdentifiers.map((identifier) => text(identifier, "protected_request_identifier_invalid"));
  const assertedAliases = new Set(asserted.map(normalize));
  for (const identifier of asserted) {
    exactAlias(identifier, aliases);
    if (!containsAlias(input.text, normalize(identifier))) fail("protected_request_assertion_missing");
  }
  let protectedText;
  if (/^\s*[\[{]/u.test(input.text)) {
    let parsed;
    try { parsed = JSON.parse(input.text); } catch { fail("protected_request_structured_invalid"); }
    protectedText = JSON.stringify(transformStructured(parsed, index, byId, usedIds, assertedAliases, flagged));
  } else {
    protectedText = replaceContextualIds(replaceAliases(input.text, index, usedIds, assertedAliases, flagged), byId, usedIds);
  }
  if ([...usedIds].some((id) => !byId.get(id)?.label)) fail("protected_request_label_unavailable");
  if (remainingUnknownIdentifier(protectedText)) fail("protected_request_identifier_unknown");
  const leaks = aliasMatches(protectedText, index, assertedAliases, [])
    .some(({ start, end }) => !/^Student A[1-9][0-9]*$/u.test(protectedText.slice(start, end)));
  if (leaks || [...protectedText.matchAll(BARE_ID)].some((match) => byId.has(match[1])
    && !OBJECT_WORD.test(protectedText.slice(Math.max(0, match.index - 40), match.index)))) {
    fail("protected_request_identity_leak_refused");
  }
  const retainedLabels = { ...(input.labelsById || {}) };
  for (const id of usedIds) retainedLabels[id] = labelsById[id];
  const seen = new Set();
  const unmatchedNames = [...flagged, ...unmatchedNameWords(protectedText).map((entry) => ({ ...entry, at: entry.at + 0.5 }))]
    .sort((left, right) => left.at - right.at)
    .map((entry) => entry.text)
    .filter((name) => !seen.has(name) && seen.add(name));
  return Object.freeze({
    protectedText,
    labelsById: Object.freeze(retainedLabels),
    usedIds: Object.freeze([...usedIds]),
    unmatchedNames: Object.freeze(unmatchedNames),
  });
}
