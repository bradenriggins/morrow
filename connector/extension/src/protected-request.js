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

function normalize(value) {
  return String(value).normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

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

function aliasIndex(roster, priorLabels) {
  if (priorLabels === undefined) priorLabels = {};
  if (!priorLabels || typeof priorLabels !== "object" || Array.isArray(priorLabels)
    || Object.keys(priorLabels).length > MAX_IDENTITIES
    || Object.entries(priorLabels).some(([id, label]) => !id || id.length > 500 || typeof label !== "string" || !/^Student A[1-9][0-9]*$/u.test(label))
    || new Set(Object.values(priorLabels)).size !== Object.keys(priorLabels).length) {
    fail("protected_request_label_map_invalid");
  }
  const aliases = new Map();
  const byId = new Map();
  const labelsById = { ...priorLabels };
  let nextLabel = Math.max(0, ...Object.values(labelsById).map((label) => Number(label.slice("Student A".length)))) + 1;
  roster.forEach((raw) => {
    const identity = exactIdentity(raw);
    if (byId.has(identity.id)) fail("protected_request_roster_duplicate");
    const label = labelsById[identity.id] || `Student A${nextLabel++}`;
    labelsById[identity.id] = label;
    const entry = { identity, label };
    byId.set(identity.id, entry);
    const values = [label, identity.id, identity.name, identity.email, identity.loginId, identity.sisUserId,
      ...identity.aliases, ...learnerNameAliases(identity)].filter(Boolean);
    for (const value of values) {
      const key = normalize(value);
      if (!key) continue;
      const matches = aliases.get(key) || [];
      if (!matches.some((candidate) => candidate.identity.id === identity.id)) matches.push(entry);
      aliases.set(key, matches);
    }
  });
  return { aliases, byId, labelsById };
}

function exactAlias(value, aliases) {
  const matches = aliases.get(normalize(value)) || [];
  if (matches.length > 1) fail("protected_request_identifier_ambiguous");
  if (matches.length === 0) fail("protected_request_identifier_unknown");
  return matches[0];
}

function containsAlias(value, alias) {
  return boundaryPattern(alias).test(value.normalize("NFKC"));
}

function replaceAliases(value, aliases, usedIds) {
  let output = value.normalize("NFKC");
  const ordered = [...aliases.entries()].sort((left, right) => right[0].length - left[0].length);
  for (const [alias, matches] of ordered) {
    const matcher = boundaryPattern(alias);
    if (!matcher.test(output)) continue;
    if (matches.length !== 1) fail("protected_request_identifier_ambiguous");
    usedIds.add(matches[0].identity.id);
    output = output.replace(boundaryPattern(alias), matches[0].label);
  }
  return output;
}

function replaceContextualIds(value, byId, usedIds) {
  const patterns = [
    /((?:["']?(?:learner|student|user|recipient|enrollment|submission)[_-]?id["']?)\s*[:=]\s*["']?)([0-9]{1,500})/giu,
    /((?:\b(?:learner|student|user|recipient|enrollment|submission|grade)\b\s*(?:id\b\s*)?[#:=]\s*))([0-9]{1,500})\b/giu,
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
  return output;
}

function transformStructured(value, aliases, byId, usedIds, key = "", depth = 0) {
  if (depth > 20) fail("protected_request_too_deep");
  if (typeof value === "string") {
    if (IDENTITY_KEY.test(key)) {
      const entry = exactAlias(value, aliases);
      usedIds.add(entry.identity.id);
      return entry.label;
    }
    return replaceContextualIds(replaceAliases(value, aliases, usedIds), byId, usedIds);
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && IDENTITY_KEY.test(key)) {
    const entry = byId.get(String(value));
    if (!entry) fail("protected_request_identifier_unknown");
    usedIds.add(entry.identity.id);
    return entry.label;
  }
  if (Array.isArray(value)) return value.map((entry) => transformStructured(entry, aliases, byId, usedIds, key, depth + 1));
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [field, child] of Object.entries(value)) {
    const protectedField = replaceAliases(field, aliases, usedIds);
    if (Object.hasOwn(output, protectedField)) fail("protected_request_key_collision");
    output[protectedField] = transformStructured(child, aliases, byId, usedIds, field, depth + 1);
  }
  return output;
}

function remainingUnknownIdentifier(value) {
  const withoutProtectedLabels = value.replace(/\bStudent A[1-9][0-9]*\b/gu, "");
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
  const { aliases, byId, labelsById } = aliasIndex(roster, input.labelsById);
  const usedIds = new Set();
  const allowedLabels = new Set(Object.values(input.labelsById || {}));
  const suppliedLabels = input.text.normalize("NFKC").match(/\bstudent\s+a[1-9][0-9]*\b/giu) || [];
  if (suppliedLabels.some((label) => {
    const number = /[1-9][0-9]*\b/u.exec(label)?.[0];
    return !number || !allowedLabels.has(`Student A${number}`);
  })) fail("protected_request_existing_label_refused");
  const asserted = input.assertedIdentifiers.map((identifier) => text(identifier, "protected_request_identifier_invalid"));
  for (const identifier of asserted) {
    exactAlias(identifier, aliases);
    if (!containsAlias(input.text, normalize(identifier))) fail("protected_request_assertion_missing");
  }
  let protectedText;
  if (/^\s*[\[{]/u.test(input.text)) {
    let parsed;
    try { parsed = JSON.parse(input.text); } catch { fail("protected_request_structured_invalid"); }
    protectedText = JSON.stringify(transformStructured(parsed, aliases, byId, usedIds));
  } else {
    protectedText = replaceContextualIds(replaceAliases(input.text, aliases, usedIds), byId, usedIds);
  }
  if (remainingUnknownIdentifier(protectedText)) fail("protected_request_identifier_unknown");
  for (const alias of aliases.keys()) {
    if (/^student a[1-9][0-9]*$/u.test(alias)) continue;
    if (boundaryPattern(alias).test(protectedText)) fail("protected_request_identity_leak_refused");
  }
  const retainedLabels = { ...(input.labelsById || {}) };
  for (const id of usedIds) retainedLabels[id] = labelsById[id];
  return Object.freeze({ protectedText, labelsById: Object.freeze(retainedLabels) });
}
