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

// Accents fold away on both sides, so "Jose Garcia" matches the rostered "José García". Rich-text
// editors and phones write a name's apostrophe or hyphen as another character, so O’Brien matches
// the rostered O'Brien. packages/gateway-core/src/privacy.ts folds the same way, so Morrow Bridge
// and the gateway replace the same names.
const APOSTROPHE_VARIANTS = /[\u2018\u2019\u02bc\uff07\u0060\u00b4]/gu;
const HYPHEN_VARIANTS = /[\u2010-\u2013\ufe63\uff0d]/gu;
// Letters whose stroke or ligature is not a combining mark, so NFKD keeps them: Łukasz, Søren,
// Đorđe, Yıldız, Guðrún, Þór, Lætitia, Cœur, Weiß. People write these names without them.
const LETTER_FOLDS = new Map([
  ["ł", "l"], ["Ł", "L"], ["ø", "o"], ["Ø", "O"], ["đ", "d"], ["Đ", "D"], ["ı", "i"], ["ħ", "h"], ["Ħ", "H"],
  ["ŧ", "t"], ["Ŧ", "T"], ["ð", "d"], ["Ð", "D"], ["þ", "th"], ["Þ", "Th"], ["æ", "ae"], ["Æ", "AE"],
  ["œ", "oe"], ["Œ", "OE"], ["ß", "ss"], ["ẞ", "SS"],
]);
const FOLDED_LETTERS = /[łŁøØđĐıħĦŧŦðÐþÞæÆœŒßẞ]/gu;

function fold(value) {
  return String(value).replace(APOSTROPHE_VARIANTS, "'").replace(HYPHEN_VARIANTS, "-")
    .replace(FOLDED_LETTERS, (letter) => LETTER_FOLDS.get(letter) ?? letter)
    .normalize("NFKD").replace(/\p{M}/gu, "").normalize("NFKC");
}

// NFKC splits a spacing accent written as an apostrophe, as in D´Angelo, into a space and a mark,
// so it becomes an apostrophe first.
function composed(value) {
  return value.replace(/\u00b4/gu, "'").normalize("NFKC");
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

// A generational suffix ends a name but is never the family name.
const NAME_SUFFIX = /^(?:jr|sr|ii|iii|iv|v)\.?$/u;

// A Korean or Chinese roster name is often stored with no space, as 김민준 or 王小明, and a
// Japanese one as 田中太郎. Its family name comes first: one syllable or character, or one of these
// two-letter family names. A Japanese four-character name is two and two.
// packages/gateway-core/src/privacy.ts splits the same way.
const KOREAN_TWO_SYLLABLE_FAMILY_NAMES = new Set(["남궁", "황보", "제갈", "선우", "독고", "사공", "서문", "동방"]);
const HAN_TWO_CHARACTER_FAMILY_NAMES = new Set([
  "欧阳", "歐陽", "司马", "司馬", "上官", "诸葛", "諸葛", "东方", "東方", "皇甫", "尉迟", "尉遲", "公孙", "公孫",
  "慕容", "令狐", "长孙", "長孫", "宇文", "司徒", "夏侯", "轩辕", "軒轅", "端木", "独孤", "獨孤", "南宫", "南宮",
  "西门", "西門", "钟离", "鍾離", "澹台", "澹臺", "呼延", "赫连", "赫連", "百里", "闻人", "聞人", "申屠", "拓跋",
  "单于", "單于",
]);

/** The family name and the given name of a one-word Hangul or Han name, or null for any other name. */
function unspacedNameParts(name) {
  const points = [...name];
  const firstTwo = points.slice(0, 2).join("");
  let familyLength;
  if (/^\p{Script=Hangul}{2,4}$/u.test(name)) {
    familyLength = points.length >= 3 && KOREAN_TWO_SYLLABLE_FAMILY_NAMES.has(firstTwo) ? 2 : 1;
  } else if (/^\p{Script=Han}{3,4}$/u.test(name)) {
    familyLength = points.length === 4 || HAN_TWO_CHARACTER_FAMILY_NAMES.has(firstTwo) ? 2 : 1;
  } else {
    return null;
  }
  return [points.slice(0, familyLength).join(""), points.slice(familyLength).join("")];
}

function learnerNameAliases(identity) {
  const name = normalize(identity.name);
  const aliases = new Set([name]);
  const comma = /^([^,]+),\s*(.+)$/u.exec(name);
  if (comma && !NAME_SUFFIX.test(comma[2])) {
    aliases.add(`${comma[2]} ${comma[1]}`);
    aliases.add(comma[1]);
    aliases.add(comma[2].split(/\s+/u)[0]);
  } else {
    const parts = name.replace(/,/gu, " ").split(" ").filter(Boolean);
    while (parts.length > 1 && NAME_SUFFIX.test(parts.at(-1))) parts.pop();
    if (parts.length > 1) {
      aliases.add(`${parts.at(-1)} ${parts.slice(0, -1).join(" ")}`);
      aliases.add(parts[0]);
      aliases.add(parts.at(-1));
    }
    if (parts.length === 1) for (const part of unspacedNameParts(parts[0]) || []) aliases.add(part);
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

// Scripts that write words with no space between them, or that attach a particle to a name, as
// Korean does in 김민준의. A name written in one has no word edge. A name written in any other
// script still ends where a word of one of these begins, as in 请看Ada Lovelace的作业.
const UNSPACED_SCRIPT = "\\p{scx=Han}\\p{scx=Hiragana}\\p{scx=Katakana}\\p{scx=Hangul}\\p{scx=Thai}\\p{scx=Lao}\\p{scx=Khmer}\\p{scx=Myanmar}";
const UNSPACED_LETTER = new RegExp(`^[${UNSPACED_SCRIPT}]$`, "u");
const SPACED_WORD_CHARACTER = `(?![${UNSPACED_SCRIPT}])[\\p{L}\\p{N}_]`;
const UNSPACED_GAP = new RegExp(`(?<=[${UNSPACED_SCRIPT}]) (?=[${UNSPACED_SCRIPT}])`, "gu");
// Arabic and Hebrew attach a one-letter prefix, such as "to" or "and", to the name that follows.
const PROCLITIC_LETTERS = [
  [/^\p{scx=Arabic}$/u, "وفبكل"],
  [/^\p{scx=Hebrew}$/u, "ובכלמשה"],
];

/**
 * The lookup key of an alias. A space between two letters of an unspaced script is dropped,
 * because people write 佐藤花子 and 佐藤 花子 for one name.
 */
function aliasKey(value) {
  return normalize(value).replace(UNSPACED_GAP, "");
}

function aliasBody(key) {
  const points = [...key];
  let body = "";
  for (const [index, point] of points.entries()) {
    const previous = points[index - 1];
    if (previous !== undefined && UNSPACED_LETTER.test(previous) && UNSPACED_LETTER.test(point)) body += "\\s*";
    body += point === " " ? "\\s+" : escapeRegExp(point);
  }
  return body;
}

/** The word edges an alias key needs on each side to be a whole name. */
function aliasEdges(key) {
  const points = [...key];
  const first = points[0] ?? "";
  const last = points.at(-1) ?? "";
  const edge = `(?<!${SPACED_WORD_CHARACTER})`;
  const proclitic = PROCLITIC_LETTERS.find(([script]) => script.test(first))?.[1];
  const before = UNSPACED_LETTER.test(first) ? "" : proclitic ? `(?:${edge}|(?<=${edge}[${proclitic}]))` : edge;
  const after = UNSPACED_LETTER.test(last) ? "" : `(?!${SPACED_WORD_CHARACTER})`;
  return [before, after];
}

/**
 * One matcher for each kind of word edge, so each edge is tested once at a position rather than
 * once for every alias. Within a matcher the longest alias is tried first.
 */
function aliasMatchers(keys) {
  const groups = new Map();
  for (const key of keys) {
    if (!key) continue;
    const edges = aliasEdges(key);
    const group = groups.get(edges.join("\u0000")) ?? { edges, keys: [] };
    group.keys.push(key);
    groups.set(edges.join("\u0000"), group);
  }
  return [...groups.values()].map(({ edges: [before, after], keys: grouped }) => new RegExp(
    `${before}(?:${grouped.sort((left, right) => right.length - left.length).map(aliasBody).join("|")})${after}`,
    "giu",
  ));
}

/** Every alias the matchers find, leftmost first and the longest where two start together. */
function matchedAliases(text, matchers) {
  const found = matchers.flatMap((matcher) => [...text.matchAll(matcher)].map((match) => ({ index: match.index, text: match[0] })))
    .sort((left, right) => left.index - right.index || right.text.length - left.text.length);
  const output = [];
  let cursor = 0;
  for (const match of found) {
    if (match.index < cursor) continue;
    output.push(match);
    cursor = match.index + match.text.length;
  }
  return output;
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
    .filter((alias) => index.kinds.get(alias) !== "number" || asserted.has(alias));
  if (!candidates.length) return [];
  const output = [];
  for (const match of matchedAliases(view.text, aliasMatchers(candidates))) {
    const key = aliasKey(match.text);
    const kind = index.kinds.get(key);
    const common = (kind === "part" || kind === "name") && key.split(/[\s,]+/u).filter(Boolean).every((word) => COMMON_NAME_WORDS.has(word));
    if (common && !asserted.has(key)) {
      if (!capitalizedWords(match.text)) continue;
      if (kind === "part" && sentenceStart(view.text, match.index)) {
        flagged.push({ at: sourceRange(view, match.index, match.index + match.text.length)[0], text: value.slice(...sourceRange(view, match.index, match.index + match.text.length)) });
        continue;
      }
    }
    const matches = index.aliases.get(key) || [];
    if (matches.length !== 1) fail("protected_request_identifier_ambiguous");
    const [start, end] = sourceRange(view, match.index, match.index + match.text.length);
    output.push({ start, end, entry: matches[0] });
  }
  return output;
}

function replaceAliases(value, index, usedIds, asserted, flagged = []) {
  const text = composed(value);
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
  const numbers = new Map();
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
      const key = aliasKey(value);
      if (!key) continue;
      const matches = aliases.get(key) || [];
      if (!matches.some((candidate) => candidate.identity.id === identity.id)) matches.push(entry);
      aliases.set(key, matches);
      if (!kinds.has(key)) kinds.set(key, aliasKind(value, identity));
    }
    // A student number or a numeric login names a student as surely as the platform id does, so a
    // bare one is replaced whether or not the educator listed it.
    for (const value of [identity.id, identity.loginId, identity.sisUserId, ...identity.aliases]) {
      const key = normalize(value || "");
      if (!/^[0-9]+$/u.test(key)) continue;
      const matches = numbers.get(key) || [];
      if (!matches.some((candidate) => candidate.identity.id === identity.id)) matches.push(entry);
      numbers.set(key, matches);
    }
  });
  return { aliases, kinds, byId, numbers, labelsById };
}

/** The one student a number names, or null. A number that names two students is refused. */
function numberEntry(numbers, value) {
  const matches = numbers.get(value) || [];
  if (matches.length > 1) fail("protected_request_identifier_ambiguous");
  return matches[0] || null;
}

function exactAlias(value, aliases) {
  const matches = aliases.get(aliasKey(value)) || [];
  if (matches.length > 1) fail("protected_request_identifier_ambiguous");
  if (matches.length === 0) fail("protected_request_identifier_unknown");
  return matches[0];
}

function containsAlias(value, alias) {
  return matchedAliases(fold(composed(value)), aliasMatchers([alias])).length > 0;
}

// A number this long in a request is a platform id, not a count or a score. A word
// before it that names a course object says whose id it is. A period that ends the
// sentence still ends the number; one inside a decimal or a file name does not.
const BARE_ID = /(?<![\p{L}\p{N}_/=.#:%&-])([0-9]{5,500})(?![\p{L}\p{N}_/%]|\.[\p{L}\p{N}_])/gu;
const OBJECT_WORD = /\b(?:course|courses|assignment|assignments|quiz|quizzes|module|modules|page|pages|file|files|section|sections|group|groups|item|items|question|questions|rubric|outcome|term|account|attempt|version|order|room|zip|phone|ext)\s*$/iu;

function replaceContextualIds(value, numbers, usedIds) {
  const patterns = [
    /((?:["']?(?:learner|student|user|recipient|enrollment|submission)[_-]?id["']?)\s*[:=]\s*["']?)([0-9]{1,500})/giu,
    /((?:\b(?:learner|student|user|recipient|enrollment|submission|grade)\b\s*(?:id\b\s*)?[#:=]\s*))([0-9]{1,500})\b/giu,
    /((?:\b(?:learners?|students?|users?|recipients?)\b\s*(?:ids?\b\s*)?\s))([0-9]{1,500})\b/giu,
    /(\/(?:users|learners|students)\/)([0-9]{1,500})\b/giu,
  ];
  let output = value;
  for (const pattern of patterns) {
    output = output.replace(pattern, (whole, prefix, id) => {
      const entry = numberEntry(numbers, id);
      if (entry) usedIds.add(entry.identity.id);
      return entry ? `${prefix}${entry.label}` : whole;
    });
  }
  return output.replace(BARE_ID, (whole, id, offset, text) => {
    if (OBJECT_WORD.test(text.slice(Math.max(0, offset - 40), offset))) return whole;
    const entry = numberEntry(numbers, id);
    if (!entry) return whole;
    usedIds.add(entry.identity.id);
    return entry.label;
  });
}

/** Capitalized words that look like a name and matched nobody on the roster. */
function unmatchedNameWords(value) {
  const text = value.replace(/\bStudent A[1-9][0-9]*\b/gu, (label) => "x".padEnd(label.length, " "));
  const word = /(?:\p{Lu}['\u2019\u02bc])?\p{Lu}[\p{Ll}\p{M}]+(?:['\u2019\u02bc\u2010-]\p{Lu}?[\p{Ll}\p{M}]+)*/u;
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
    return replaceContextualIds(replaceAliases(value, index, usedIds, asserted, flagged), index.numbers, usedIds);
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
  // The list names the students the educator wrote. A message that names none, such as a follow-up,
  // lists none; the class list still protects every student detail in its text.
  if (!Array.isArray(input.assertedIdentifiers) || input.assertedIdentifiers.length > 100) {
    fail("protected_request_identifiers_required");
  }
  const roster = input.roster.map(exactIdentity).sort((left, right) => left.id.localeCompare(right.id, "en", { numeric: true }));
  const index = aliasIndex(roster, input.labelsById, input.assignedLabelsById);
  const { aliases, byId, numbers, labelsById } = index;
  const usedIds = new Set();
  const flagged = [];
  const allowedLabels = new Set(Object.values(input.labelsById || {}));
  const suppliedLabels = input.text.normalize("NFKC").match(/\bstudent\s+a[1-9][0-9]*\b/giu) || [];
  if (suppliedLabels.some((label) => {
    const number = /[1-9][0-9]*\b/u.exec(label)?.[0];
    return !number || !allowedLabels.has(`Student A${number}`);
  })) fail("protected_request_existing_label_refused");
  const asserted = input.assertedIdentifiers.map((identifier) => text(identifier, "protected_request_identifier_invalid"));
  const assertedAliases = new Set(asserted.map(aliasKey));
  for (const identifier of asserted) {
    exactAlias(identifier, aliases);
    if (!containsAlias(input.text, aliasKey(identifier))) fail("protected_request_assertion_missing");
  }
  let protectedText;
  if (/^\s*[\[{]/u.test(input.text)) {
    let parsed;
    try { parsed = JSON.parse(input.text); } catch { fail("protected_request_structured_invalid"); }
    protectedText = JSON.stringify(transformStructured(parsed, index, byId, usedIds, assertedAliases, flagged));
  } else {
    protectedText = replaceContextualIds(replaceAliases(input.text, index, usedIds, assertedAliases, flagged), numbers, usedIds);
  }
  if ([...usedIds].some((id) => !byId.get(id)?.label)) fail("protected_request_label_unavailable");
  if (remainingUnknownIdentifier(protectedText)) fail("protected_request_identifier_unknown");
  const leaks = aliasMatches(protectedText, index, assertedAliases, [])
    .some(({ start, end }) => !/^Student A[1-9][0-9]*$/u.test(protectedText.slice(start, end)));
  if (leaks || [...protectedText.matchAll(BARE_ID)].some((match) => numbers.has(match[1])
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
