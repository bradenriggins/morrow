export async function executeItemBankInPage(input) {
  const MAX_BYTES = 2 * 1024 * 1024;
  const hostPattern = /^[^.]+\.quiz-(?:lti|api)(?:-[^.]+)*\.instructure\.com$/i;
  const apiHostPattern = /^[^.]+\.quiz-api(?:-[^.]+)*\.instructure\.com$/i;
  const id = (value) => /^[1-9][0-9]*$/.test(String(value || "")) ? String(value) : "";
  const json = (storage, key) => {
    try { return JSON.parse(storage.getItem(key) || "null"); } catch { return null; }
  };
  const currentUser = json(sessionStorage, "current_user") || json(localStorage, "current_user");
  const principalId = id(currentUser?.current_user?.id ?? currentUser?.id ?? globalThis.ENV?.current_user_id);
  if (!principalId || principalId !== input.principalId) return { matched: false };
  const token = sessionStorage.getItem("banks.build_token") || "";
  if (token.length < 51 || token.length > 8192) return { matched: false };
  const currentHost = location.hostname.toLowerCase();
  let apiHost = hostPattern.test(currentHost) ? currentHost.replace(".quiz-lti", ".quiz-api") : "";
  if (!apiHost) {
    const backend = sessionStorage.getItem("backend_url") || localStorage.getItem("backend_url") || "";
    try {
      const host = new URL(backend).hostname.toLowerCase();
      apiHost = hostPattern.test(host) ? host.replace(".quiz-lti", ".quiz-api") : "";
    } catch {}
  }
  if (!apiHostPattern.test(apiHost)) return { matched: false };
  let canvasUrl;
  let referrerUrl;
  try {
    canvasUrl = new URL(input.canvasOrigin);
    referrerUrl = new URL(document.referrer || "");
  } catch {
    return { matched: false };
  }
  if (canvasUrl.protocol !== "https:" || canvasUrl.origin !== input.canvasOrigin || referrerUrl.origin !== canvasUrl.origin) return { matched: false };
  const canvasHost = canvasUrl.hostname.toLowerCase();
  const standardTenant = canvasHost.match(/^([^.]+)(?:\.(?:beta|test))?\.instructure\.com$/i)?.[1]?.toLowerCase();
  if (standardTenant && apiHost.split(".")[0] !== standardTenant) return { matched: false };
  const courseClaims = [];
  const referrerCourse = referrerUrl.pathname.match(/\/courses\/([1-9][0-9]*)(?:\/|$)/)?.[1];
  if (referrerCourse) courseClaims.push(referrerCourse);
  const scope = json(sessionStorage, "item_banks_scope") || json(localStorage, "item_banks_scope");
  for (const key of ["course_id", "courseId", "context_id", "contextId"]) {
    const claim = id(scope?.[key]);
    if (claim) courseClaims.push(claim);
  }
  if (!input.courseId || courseClaims.length === 0 || courseClaims.some((value) => value !== input.courseId)) return { matched: false };
  const operation = input.operation;
  if (!operation || operation.service !== "item_bank" || !["GET", "POST", "PATCH", "DELETE"].includes(operation.method)) return { matched: false };
  // The frame probe carries the binding and the operation shape, never the
  // arguments, so nothing above this line may read input.arguments. A probe
  // that needed the payload would disclose it to every candidate frame before
  // one frame was chosen.
  if (input.contextOnly === true) return { matched: true, ok: true, sent: false };
  const itemBankGuard = input.arguments?.morrow_item_bank_guard;
  const guardedUpdate = itemBankGuard !== undefined && operation.nickname === "update_item";
  // A guard on any other route would be carried and never checked, and an
  // unchecked guard is an approval nobody honoured, so it is refused.
  if (itemBankGuard !== undefined && !guardedUpdate) return { matched: true, ok: false, sent: false, error: "item_bank_guard_refused" };
  if (operation.nickname === "list_banks" && input.arguments?.course_id !== undefined) {
    const requestedCourse = id(input.arguments.course_id);
    if (!requestedCourse || requestedCourse !== input.courseId) {
      return { matched: true, ok: false, sent: false, error: "item_bank_course_mismatch" };
    }
  }
  let path = operation.path;
  const query = new URLSearchParams();
  const formValues = {};
  for (const parameter of operation.parameters) {
    // A guarded repair never carries a question payload. The one it sends is
    // built below from the question this frame reads back from the bank.
    if (guardedUpdate && parameter.inputName === "item") continue;
    const value = input.arguments?.[parameter.inputName];
    if (value === undefined || value === null || value === "") {
      if (parameter.required) return { matched: true, ok: false, sent: false, error: `${parameter.inputName} is required` };
      continue;
    }
    if (parameter.location === "path") path = path.replace(`{${parameter.wireName}}`, encodeURIComponent(String(value)));
    else if (parameter.location === "query" || operation.method === "GET") query.append(parameter.wireName, String(value));
    else formValues[parameter.wireName] = value;
  }
  if (!/^\/api\/banks(?:[/?#]|$)/.test(path) || path.includes("://") || path.split(/[?#]/)[0].split("/").includes("..") || /\{[^}]+\}/.test(path)) {
    return { matched: true, ok: false, sent: false, error: "item_bank_path_refused" };
  }
  let body;
  if (operation.nickname === "create_bank") body = { bank: { title: String(formValues.title), language: "en" } };
  else if (operation.nickname === "attach_item") body = { bank_entry: { bank_id: String(input.arguments.bank_id), entry_type: "Item", entry_id: String(formValues.item_id) } };
  else if (operation.nickname === "share_bank") {
    // Only a course share with read permission is established. Every other
    // scope is unverified, so Morrow refuses it instead of sending it.
    if (String(formValues.entity_type) !== "course") return { matched: true, ok: false, sent: false, error: "item_bank_share_scope_unsupported" };
    body = { shared_bank: { entity_id: String(formValues.entity_id), entityType: String(formValues.entity_type), bank_id: String(input.arguments.bank_id), permission: "read" } };
  }
  else if (!guardedUpdate && (operation.nickname === "create_item" || operation.nickname === "update_item")) {
    body = formValues.item && typeof formValues.item === "object" && !Array.isArray(formValues.item) && Object.hasOwn(formValues.item, "item")
      ? formValues.item
      : { item: formValues.item };
    // A bank question is shared machinery: a malformed one reaches every course
    // that draws from the bank, and a picture with no alternative text reaches
    // every learner who cannot see it. Four interaction shapes are checked and
    // every other type passes through to Canvas, which is the authority on its
    // own schema. The guarded repair above is deliberately not checked here: it
    // sends the question the bank already holds with one alt attribute added,
    // so a defect that question already carries would block the accessibility
    // fix without changing anything.
    //
    // Every rule below is copied from
    // connector/extension/src/quiz-item-payload.js, because Chrome injects this
    // function without its module scope.
    // scripts/test/canvas-quiz-item-payload.test.mjs runs both copies over the
    // same payloads and fails if one of them disagrees.
    const payloadReason = (() => {
      const MEDIA_ELEMENTS = ["img", "audio", "video"];
      const MEDIA_SRC_PREFIXES = ["https://", "/courses/", "/api/v1/files/"];
      const CHOICE_SLUGS = ["choice", "multiple_choice"];
      const CHOICE_INTERACTION_TYPE_ID = 1;
      const RICH_FILL_SLUGS = ["rich_fill_blank", "rich_fill", "rich_fill_in_the_blank"];
      const BLANK_KINDS = { openentry: "openEntry", dropdown: "TextInChoices", textinchoices: "TextInChoices", wordbank: "wordbank" };
      const INTERACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
      const TAG = /<!--[\s\S]*?-->|<(?:"[^"]*"|'[^']*'|[^'">])*>/g;
      const TAG_NAME = /^<\s*(\/?)\s*([a-zA-Z][^\s/>]*)/;
      const ATTRIBUTE = /^\s+([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/;
      const RAW_TEXT = ["script", "style", "iframe", "object", "embed", "textarea", "title"];
      const MEDIA_TAG = /<\s*(?:img|audio|video)\b/i;
      const BLANK_MARKER = /id\s*=\s*(?:"blank_([^"]*)"|'blank_([^']*)')/g;
      const MAX_DEPTH = 32;

      const plainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
      const scalar = (value) => typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
      const asText = (value) => scalar(value) ? String(value) : "";
      const normalizeSlug = (value) => typeof value === "string" ? value.trim().toLowerCase().replaceAll(/[\s-]+/g, "_") : "";

      const mediaElements = (value) => {
        const elements = [];
        let rawText = "";
        for (const match of value.matchAll(TAG)) {
          const tag = match[0];
          if (tag.startsWith("<!--")) continue;
          const parsed = TAG_NAME.exec(tag);
          if (!parsed) continue;
          const closing = parsed[1] === "/";
          const name = parsed[2].toLowerCase();
          if (rawText) {
            if (closing && name === rawText) rawText = "";
            continue;
          }
          if (RAW_TEXT.includes(name)) {
            if (!closing && !tag.endsWith("/>")) rawText = name;
            continue;
          }
          if (closing || !MEDIA_ELEMENTS.includes(name)) continue;
          elements.push({ name, tag });
        }
        return { elements, open: rawText !== "" };
      };

      const tagAttributes = (tag) => {
        const open = TAG_NAME.exec(tag);
        if (!open || open[1] === "/" || !tag.endsWith(">")) return null;
        let rest = tag.slice(open[0].length, tag.length - (tag.endsWith("/>") ? 2 : 1));
        const attributes = new Map();
        while (rest.trim().length > 0) {
          const match = ATTRIBUTE.exec(rest);
          if (!match) return null;
          const name = match[1].toLowerCase();
          if (attributes.has(name)) return null;
          attributes.set(name, match[2] ?? match[3] ?? match[4] ?? "");
          rest = rest.slice(match[0].length);
        }
        return attributes;
      };

      const stringMediaReason = (value) => {
        if (!MEDIA_TAG.test(value)) return null;
        const scan = mediaElements(value);
        if (scan.open) return "media_markup_unreadable";
        for (const element of scan.elements) {
          const attributes = tagAttributes(element.tag);
          if (!attributes) return "media_markup_unreadable";
          if (element.name === "img" && !attributes.has("alt")) return "media_image_alt_missing";
          const source = attributes.get("src");
          if (source !== undefined && !MEDIA_SRC_PREFIXES.some((prefix) => source.startsWith(prefix))) return "media_src_unsupported";
        }
        return null;
      };

      const mediaReason = (value, depth) => {
        if (depth > MAX_DEPTH) return "payload_too_deep";
        if (typeof value === "string") return stringMediaReason(value);
        if (Array.isArray(value)) {
          for (const member of value) {
            const reason = mediaReason(member, depth + 1);
            if (reason) return reason;
          }
          return null;
        }
        if (plainObject(value)) {
          for (const child of Object.values(value)) {
            const reason = mediaReason(child, depth + 1);
            if (reason) return reason;
          }
        }
        return null;
      };

      const interactionKind = (entry, payload) => {
        const slug = normalizeSlug(entry.interaction_type_slug ?? payload.interaction_type_slug);
        const typeId = entry.interaction_type_id ?? payload.interaction_type_id;
        if (CHOICE_SLUGS.includes(slug)) return "choice";
        if (slug === "matching") return "matching";
        if (slug === "numeric") return "numeric";
        if (RICH_FILL_SLUGS.includes(slug)) return "rich_fill";
        if (!slug && Number(typeId) === CHOICE_INTERACTION_TYPE_ID) return "choice";
        return "";
      };

      const hasContent = (value) => {
        if (!scalar(value)) return false;
        const text = String(value);
        return text.replaceAll(TAG, "").replaceAll("&nbsp;", " ").trim() !== "" || MEDIA_TAG.test(text);
      };

      const memberIds = (rows, invalid, duplicate) => {
        const ids = [];
        for (const row of rows) {
          if (!plainObject(row)) return invalid;
          const memberId = asText(row.id);
          if (!INTERACTION_ID.test(memberId)) return invalid;
          if (ids.includes(memberId)) return duplicate;
          ids.push(memberId);
        }
        return ids;
      };

      const sameIdSet = (left, right) => left.length === right.length && left.every((value) => right.includes(value));

      const choiceReason = (interaction, scoring) => {
        if (!plainObject(interaction) || !Array.isArray(interaction.choices)) return "choice_list_missing";
        if (interaction.choices.length < 2) return "choice_too_few";
        const ids = memberIds(interaction.choices, "choice_id_invalid", "choice_id_duplicate");
        if (!Array.isArray(ids)) return ids;
        for (const choice of interaction.choices) {
          if (!hasContent(choice.item_body ?? choice.body)) return "choice_body_blank";
        }
        const value = plainObject(scoring) ? scoring.value : undefined;
        if (value === undefined || value === null) return null;
        const members = Array.isArray(value) ? value : [value];
        if (members.length === 0) return "choice_scoring_value_not_a_choice_id";
        for (const member of members) {
          if (!ids.includes(asText(member))) return "choice_scoring_value_not_a_choice_id";
        }
        return null;
      };

      const matchingReason = (interaction, scoring) => {
        if (!plainObject(interaction) || !Array.isArray(interaction.questions) || interaction.questions.length === 0) return "matching_questions_missing";
        const ids = memberIds(interaction.questions, "matching_question_id_invalid", "matching_question_id_duplicate");
        if (!Array.isArray(ids)) return ids;
        if (!plainObject(scoring)) return null;
        if (!plainObject(scoring.value)) return "matching_scoring_value_not_an_object";
        if (!sameIdSet(Object.keys(scoring.value), ids)) return "matching_scoring_value_keys_mismatch";
        if (!plainObject(scoring.edit_data) || !Array.isArray(scoring.edit_data.matches)) return "matching_edit_data_matches_missing";
        const matched = [];
        for (const match of scoring.edit_data.matches) {
          if (!plainObject(match)) return "matching_edit_data_matches_mismatch";
          const questionId = asText(match.question_id ?? match.id);
          if (!questionId || matched.includes(questionId)) return "matching_edit_data_matches_mismatch";
          matched.push(questionId);
        }
        return sameIdSet(matched, ids) ? null : "matching_edit_data_matches_mismatch";
      };

      const numericReason = (interaction, scoring) => {
        const value = plainObject(scoring) ? scoring.value : undefined;
        if (Array.isArray(value)) {
          // The public New Quiz item contract uses a list of typed numeric responses.
          const ids = memberIds(value, "numeric_response_invalid", "numeric_response_invalid");
          if (!Array.isArray(ids) || ids.length === 0) return "numeric_response_invalid";
          const numeric = (number) => (typeof number === "number" || (typeof number === "string" && number.trim() !== ""))
            && Number.isFinite(Number(number));
          for (const response of value) {
            if (response.type === "withinARange") {
              if (!numeric(response.start) || !numeric(response.end) || Number(response.start) > Number(response.end)) return "numeric_response_invalid";
            } else {
              if (!numeric(response.value)) return "numeric_response_invalid";
              if (response.type === "marginOfError") {
                if (!numeric(response.margin) || Number(response.margin) < 0 || !["percent", "absolute"].includes(response.margin_type)) return "numeric_response_invalid";
              } else if (response.type === "preciseResponse") {
                if (!numeric(response.precision) || !Number.isInteger(Number(response.precision)) || Number(response.precision) < 0
                  || !["decimals", "significantDigits"].includes(response.precision_type)) return "numeric_response_invalid";
              } else if (response.type !== "exactResponse") return "numeric_response_invalid";
            }
          }
        } else if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value))) return "numeric_scoring_value_not_a_number";
        if (!plainObject(interaction)) return null;
        const units = interaction.units;
        if (units !== undefined && units !== null && !(typeof units === "string" && units.trim() !== "")) return "numeric_units_blank";
        const dimensions = interaction.dimensions;
        if (dimensions === undefined || dimensions === null) return null;
        if (!plainObject(dimensions) || Object.keys(dimensions).length === 0) return "numeric_dimensions_invalid";
        for (const bound of ["min", "max", "step"]) {
          const held = dimensions[bound];
          if (held === undefined || held === null) continue;
          if (typeof held !== "number" || !Number.isFinite(held)) return "numeric_dimensions_invalid";
        }
        if (typeof dimensions.min === "number" && typeof dimensions.max === "number" && dimensions.min > dimensions.max) return "numeric_dimensions_min_above_max";
        return null;
      };

      const scoringRow = (scoring, blankId) => {
        const rows = plainObject(scoring) && Array.isArray(scoring.value) ? scoring.value : [];
        return rows.find((row) => plainObject(row) && asText(row.id) === blankId) ?? null;
      };

      const rowAnswer = (row) => plainObject(row?.scoring_data) ? row.scoring_data : plainObject(row) ? row : null;

      const blankKind = (blank, row) => {
        const named = normalizeSlug(blank.answer_type ?? blank.blank_type ?? blank.type ?? row?.scoring_algorithm);
        return BLANK_KINDS[named.replaceAll("_", "")] ?? "";
      };

      const choiceTokens = (choice) => {
        if (scalar(choice)) return [String(choice)];
        if (!plainObject(choice)) return [];
        return [choice.id, choice.item_body ?? choice.body ?? choice.value ?? choice.text].filter(scalar).map(String);
      };

      const openEntryReason = (blank, row) => {
        const answer = blank.answers ?? rowAnswer(row)?.value;
        const answers = Array.isArray(answer) ? answer : answer === undefined || answer === null ? [] : [answer];
        if (answers.length === 0 || !answers.every((value) => scalar(value) && String(value).trim() !== "")) return "rich_fill_open_entry_answers_missing";
        return null;
      };

      const textInChoicesReason = (blank, row) => {
        const listed = blank.choices ?? rowAnswer(row)?.choices;
        if (!Array.isArray(listed) || listed.length < 2) return "rich_fill_text_in_choices_too_few";
        const tokens = listed.flatMap(choiceTokens);
        const correct = asText(blank.value ?? rowAnswer(row)?.value);
        return correct !== "" && tokens.includes(correct) ? null : "rich_fill_text_in_choices_value_not_listed";
      };

      const wordBankReason = (interaction, scoring, itemBody, ids, wordBankIds) => {
        if (!Array.isArray(interaction.word_bank_choices) || interaction.word_bank_choices.length < 2) return "rich_fill_word_bank_choices_too_few";
        const choiceIds = memberIds(interaction.word_bank_choices, "rich_fill_word_bank_choice_id_invalid", "rich_fill_word_bank_choice_id_duplicate");
        if (!Array.isArray(choiceIds)) return choiceIds;
        if (!plainObject(scoring) || !Array.isArray(scoring.value)) return "rich_fill_scoring_ids_mismatch";
        const scoredIds = memberIds(scoring.value, "rich_fill_scoring_ids_mismatch", "rich_fill_scoring_ids_mismatch");
        if (!Array.isArray(scoredIds) || !sameIdSet(scoredIds, ids)) return "rich_fill_scoring_ids_mismatch";
        const answers = [];
        for (const blankId of ids) {
          const answer = rowAnswer(scoringRow(scoring, blankId));
          const value = asText(answer?.value);
          if (wordBankIds.includes(blankId)) {
            if (value.trim() === "") return "rich_fill_blank_answer_missing";
            // A word-bank blank must point at the same answer that it reveals.
            if (asText(answer.blank_text) !== value) return "rich_fill_blank_text_mismatch";
            if (!choiceIds.includes(asText(answer.choice_id))) return "rich_fill_choice_id_unknown";
          }
          answers.push(asText(answer?.blank_text) || value);
        }
        const markers = [...String(itemBody ?? "").matchAll(BLANK_MARKER)].map((match) => match[1] ?? match[2]);
        if (!sameIdSet([...new Set(markers)], ids)) return "rich_fill_body_blank_markers_mismatch";
        // The working body is the authoring copy: every answer appears in backticks
        // where its blank sits, so the order carries the pairing.
        const working = typeof scoring.working_item_body === "string" ? scoring.working_item_body : "";
        let cursor = 0;
        for (const answer of answers) {
          const found = working.indexOf(`\`${answer}\``, cursor);
          if (found < 0) return "rich_fill_working_item_body_answers_out_of_order";
          cursor = found + answer.length + 2;
        }
        return null;
      };

      const richFillReason = (interaction, scoring, itemBody) => {
        const blanks = plainObject(interaction)
          ? Array.isArray(interaction.blanks) ? interaction.blanks : Array.isArray(interaction.entries) ? interaction.entries : null
          : null;
        if (!blanks || blanks.length === 0) return "rich_fill_blanks_missing";
        const ids = memberIds(blanks, "rich_fill_blank_id_invalid", "rich_fill_blank_id_duplicate");
        if (!Array.isArray(ids)) return ids;
        const kinds = blanks.map((blank, index) => blankKind(blank, scoringRow(scoring, ids[index])));
        if (kinds.includes("")) return "rich_fill_blank_kind_unreadable";
        const wordBankIds = ids.filter((_, index) => kinds[index] === "wordbank");
        if (wordBankIds.length > 0) {
          const reason = wordBankReason(interaction, scoring, itemBody, ids, wordBankIds);
          if (reason) return reason;
        }
        for (const [index, blank] of blanks.entries()) {
          if (kinds[index] === "wordbank") continue;
          const row = scoringRow(scoring, ids[index]);
          const reason = kinds[index] === "openEntry" ? openEntryReason(blank, row) : textInChoicesReason(blank, row);
          if (reason) return reason;
        }
        return null;
      };

      const payload = body.item;
      if (!plainObject(payload)) return "payload_not_an_object";
      const entry = plainObject(payload.entry) ? payload.entry : payload;
      const media = mediaReason(payload, 0);
      if (media) return media;
      const kind = interactionKind(entry, payload);
      if (!kind) return null;
      const interaction = entry.interaction_data;
      const scoring = entry.scoring_data;
      if ((interaction === undefined || interaction === null) && (scoring === undefined || scoring === null)) return null;
      if (kind === "choice") return choiceReason(interaction, scoring);
      if (kind === "matching") return matchingReason(interaction, scoring);
      if (kind === "numeric") return numericReason(interaction, scoring);
      return richFillReason(interaction, scoring, entry.item_body);
    })();
    if (payloadReason) return { matched: true, ok: false, sent: false, error: `item_bank_payload_${payloadReason}` };
  }
  else if (Object.keys(formValues).length) body = formValues;
  const headers = { Accept: "application/json", Authorization: token, AuthType: "Signature" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  // A dispatched write with no clear provider answer may still have been
  // applied, so it must never be repeated. Only a 4xx other than 408 and 429
  // proves the provider refused; 408, 429, and every 5xx stay uncertain. A read
  // has no effect to be uncertain about. See section 7.1 of
  // docs/research/CANVAS-NEW-QUIZZES-ITEM-BANKS-CONTRACT-2026-09-06.md. This is
  // the one Canvas write-outcome rule from src/canvas-write-outcome.js, copied
  // here because Chrome injects this function without its module scope.
  const itemBankOutcomeUnknown = (method, httpStatus) => method !== "GET"
    && !(Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408 && httpStatus !== 429);
  const boundedResponseText = async (response) => {
    const declared = response?.headers?.get?.("content-length");
    if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_BYTES)) return { oversize: true };
    if (!response?.body || typeof response.body.getReader !== "function") return { text: "" };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = "";
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (!(next.value instanceof Uint8Array) || (size += next.value.byteLength) > MAX_BYTES) {
          await reader.cancel();
          return { oversize: true };
        }
        text += decoder.decode(next.value, { stream: true });
      }
      return { text: text + decoder.decode() };
    } catch {
      try { await reader.cancel(); } catch {}
      return { unreadable: true };
    }
  };
  const sanitize = (value, depth = 0) => {
    if (depth > 24) return null;
    if (Array.isArray(value)) return value.slice(0, 10_000).map((entry) => sanitize(entry, depth + 1));
    if (!value || typeof value !== "object") return typeof value === "string" ? value.split(token).join("[redacted]") : value;
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      // The guard carries the approved alternative text and the fan-out record
      // of every course this bank reaches. It is evidence for the change, not
      // part of the answer, so it never travels back in a result.
      if (/(?:authorization|bearer|token|secret|credential|cookie|csrf)/i.test(key) || /^morrow_.*guard$/i.test(key)) continue;
      output[key] = sanitize(child, depth + 1);
    }
    return output;
  };
  if (guardedUpdate) {
    // One guarded Item Bank question repair: read the question, change one
    // image's alternative text, send exactly one PATCH, read the question
    // again. Nothing is sent until every check below passes, and nothing is
    // ever sent twice — a repeat on a shared bank would reach every course
    // that draws from it.
    //
    // Every rule here is copied from connector/extension/src/item-bank-guard.js
    // and connector/extension/src/item-bank-fan-out.js, because Chrome injects
    // this function without its module scope.
    // scripts/test/canvas-item-bank-guard.test.mjs executes both copies over
    // the same fixtures and fails if one of them disagrees.
    const GUARD_KIND = "item_bank_entry_image_alt";
    const GUARD_FIELDS = ["kind", "course_id", "bank_id", "bank_entry_id", "item_id", "entry_type", "item_sha256", "protected_state_sha256", "image_index", "image_src_sha256", "alt_text", "fan_out", "acknowledged_course_ids"];
    const MAX_ITEM_BODY = 200_000;
    const FAN_OUT_SCHEMA = "morrow.canvas.item-bank.fan-out.v1";
    const FAN_OUT_SOURCES = ["bank_entries", "shared_banks", "quiz_uses"];
    const FAN_OUT_MAX_AGE_MS = 60 * 60 * 1_000;
    const COURSE_ID = /^[1-9][0-9]*$/;
    const ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
    const ENTITY_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
    const INTERACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
    const SHA256 = /^[0-9a-f]{64}$/;
    const TIMEZONE = /(?:Z|[+-][0-9]{2}:?[0-9]{2})$/i;
    const TAG = /<!--[\s\S]*?-->|<(?:"[^"]*"|'[^']*'|[^'">])*>/g;
    const TAG_NAME = /^<\s*(\/?)\s*([a-zA-Z][^\s/>]*)/;
    const ATTRIBUTE = /^\s+([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/;
    const RAW_TEXT = ["script", "style", "iframe", "object", "embed", "textarea", "title"];
    const IMAGELESS_SUBTREE = ["svg", "math"];
    const INTERACTION_ID_GROUPS = ["choices", "questions", "blanks", "entries"];

    const plain = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
    const decimal = (value) => typeof value === "string" && COURSE_ID.test(value);
    const identifier = (value) => typeof value === "string" && ENTITY_ID.test(value);
    const hex = (value) => typeof value === "string" && SHA256.test(value);
    const asText = (value) => typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
    const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
    const compareCourseIds = (a, b) => a.length === b.length ? compareText(a, b) : a.length - b.length;
    const compareConsumers = (a, b) => compareCourseIds(a.course_id, b.course_id) || compareText(a.entity_type, b.entity_type) || compareText(a.entity_id, b.entity_id);
    const sameList = (value, expected) => Array.isArray(value) && value.length === expected.length && expected.every((entry, index) => value[index] === entry);
    const externalCourseIds = (consumers, course) => [...new Set(consumers.map((consumer) => consumer.course_id))].filter((value) => value !== course).sort(compareCourseIds);
    const stable = (value) => Array.isArray(value)
      ? `[${value.map(stable).join(",")}]`
      : value && typeof value === "object"
        ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
        : JSON.stringify(value === undefined ? null : value);
    const digest = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const escapeAlt = (value) => value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

    const validGuard = (guard) => {
      if (!plain(guard)) return false;
      const keys = Object.keys(guard);
      if (keys.length !== GUARD_FIELDS.length || GUARD_FIELDS.some((field) => !keys.includes(field))) return false;
      const acknowledged = guard.acknowledged_course_ids;
      return guard.kind === GUARD_KIND && guard.entry_type === "Item"
        && decimal(guard.course_id)
        && identifier(guard.bank_id) && identifier(guard.bank_entry_id) && identifier(guard.item_id)
        && hex(guard.item_sha256) && hex(guard.protected_state_sha256)
        && Number.isSafeInteger(guard.image_index) && guard.image_index >= 1
        && hex(guard.image_src_sha256)
        && typeof guard.alt_text === "string" && guard.alt_text.trim().length > 0 && guard.alt_text.length <= 500
        && plain(guard.fan_out)
        && Array.isArray(acknowledged) && acknowledged.every(decimal) && new Set(acknowledged).size === acknowledged.length;
    };

    const normalizeConsumers = (values) => {
      if (!Array.isArray(values)) return null;
      const rows = [];
      const seen = new Set();
      for (const value of values) {
        if (!plain(value)) return null;
        const consumer = { course_id: asText(value.course_id), entity_type: asText(value.entity_type), entity_id: asText(value.entity_id) };
        if (!COURSE_ID.test(consumer.course_id) || !ENTITY_TYPE.test(consumer.entity_type) || !ENTITY_ID.test(consumer.entity_id)) return null;
        const key = `${consumer.course_id} ${consumer.entity_type} ${consumer.entity_id}`;
        if (seen.has(key)) return null;
        seen.add(key);
        rows.push(consumer);
      }
      return rows.sort(compareConsumers);
    };

    const unreadSources = (record) => {
      const exhausted = new Map();
      for (const row of Array.isArray(record.sources) ? record.sources : []) {
        const name = asText(row?.name);
        exhausted.set(name, exhausted.has(name) ? false : row?.exhausted === true);
      }
      const declared = Array.isArray(record.unreachable) ? record.unreachable.map(asText) : [...FAN_OUT_SOURCES];
      return [...new Set([...declared, ...FAN_OUT_SOURCES.filter((name) => exhausted.get(name) !== true)])];
    };

    const validFanOut = async (record, bank, course, acknowledged, now) => {
      if (!plain(record)) return "missing_record";
      if (record.schema !== FAN_OUT_SCHEMA) return "wrong_schema";
      if (record.bank_id !== bank) return "bank_mismatch";
      if (record.course_id !== course) return "course_mismatch";
      if (record.complete !== true || unreadSources(record).length > 0) return "incomplete_unread_source_is_not_an_empty_fan_out";
      const consumers = normalizeConsumers(record.consumers);
      if (consumers === null) return "consumers_invalid";
      if (record.consumer_count !== consumers.length) return "consumer_count_mismatch";
      if (!hex(asText(record.consumers_sha256)) || record.consumers_sha256 !== await digest(stable(consumers))) return "consumers_digest_mismatch";
      if (typeof record.established_at !== "string" || !TIMEZONE.test(record.established_at) || !Number.isFinite(Date.parse(record.established_at))) return "established_at_unreadable";
      if (!Number.isFinite(now)) return "record_age_unknown";
      if (Date.parse(record.established_at) > now) return "record_from_future";
      if (now - Date.parse(record.established_at) > FAN_OUT_MAX_AGE_MS) return "record_too_old";
      const external = externalCourseIds(consumers, course);
      if (!sameList(record.external_course_ids, external)) return "external_course_ids_mismatch";
      if (!Array.isArray(acknowledged) || !sameList([...acknowledged].map(asText).sort(compareCourseIds), external)) return "acknowledgement_mismatch";
      return null;
    };

    const protectedState = (item) => {
      if (!plain(item) || !plain(item.entry) || typeof item.entry.item_body !== "string") return null;
      const state = structuredClone(item);
      delete state.entry.item_body;
      delete state.entry.updated_at;
      delete state.updated_at;
      return state;
    };

    const interactionIds = (item) => {
      if (!plain(item) || !plain(item.entry)) return null;
      const interaction = item.entry.interaction_data;
      if (interaction === undefined || interaction === null) return [];
      if (!plain(interaction)) return null;
      const ids = [];
      for (const group of INTERACTION_ID_GROUPS) {
        const rows = interaction[group];
        if (rows === undefined || rows === null) continue;
        if (!Array.isArray(rows)) return null;
        for (const row of rows) {
          if (!plain(row) || typeof row.id !== "string" || !INTERACTION_ID.test(row.id)) return null;
          ids.push(`${group}:${row.id}`);
        }
      }
      return new Set(ids).size === ids.length ? ids.sort(compareText) : null;
    };

    const entryLinksItem = (entry, itemId) => {
      if (!plain(entry) || entry.entry_type !== "Item") return false;
      if (typeof entry.entry_id === "string" && entry.entry_id === itemId) return true;
      for (const key of ["item", "entry", "current_version", "data"]) {
        const value = entry[key];
        if (!plain(value)) continue;
        if (typeof value.id === "string" && value.id === itemId) return true;
        for (const nested of ["item", "data"]) {
          const inner = value[nested];
          if (plain(inner) && typeof inner.id === "string" && inner.id === itemId) return true;
        }
      }
      return false;
    };

    const contentImages = (value) => {
      const images = [];
      let rawText = "";
      let imagelessDepth = 0;
      for (const match of value.matchAll(TAG)) {
        const tag = match[0];
        if (tag.startsWith("<!--")) continue;
        const parsed = TAG_NAME.exec(tag);
        if (!parsed) continue;
        const closing = parsed[1] === "/";
        const element = parsed[2].toLowerCase();
        if (rawText) {
          if (closing && element === rawText) rawText = "";
          continue;
        }
        if (RAW_TEXT.includes(element)) {
          if (!closing && !tag.endsWith("/>")) rawText = element;
          continue;
        }
        if (IMAGELESS_SUBTREE.includes(element)) {
          if (closing) imagelessDepth = Math.max(0, imagelessDepth - 1);
          else if (!tag.endsWith("/>")) imagelessDepth += 1;
          continue;
        }
        if (element !== "img" || closing || imagelessDepth > 0) continue;
        images.push({ start: match.index, end: match.index + tag.length - 1, tag });
      }
      return { images, open: rawText !== "" || imagelessDepth > 0 };
    };

    const imageAttributes = (tag) => {
      const open = /^<\s*img/i.exec(tag);
      if (!open || !tag.endsWith(">")) return null;
      let rest = tag.slice(open[0].length, tag.length - (tag.endsWith("/>") ? 2 : 1));
      const attributes = new Map();
      while (rest.trim().length > 0) {
        const match = ATTRIBUTE.exec(rest);
        if (!match) return null;
        const name = match[1].toLowerCase();
        if (attributes.has(name)) return null;
        attributes.set(name, match[2] ?? match[3] ?? "");
        rest = rest.slice(match[0].length);
      }
      return attributes;
    };

    const applyImageAlt = async (value, guard) => {
      if (typeof value !== "string" || value.length === 0 || value.length > MAX_ITEM_BODY) return { error: "item_bank_image_alt_body_unusable" };
      const before = contentImages(value);
      if (before.open) return { error: "item_bank_image_alt_markup_unreadable" };
      const selected = before.images[guard.image_index - 1];
      if (!selected) return { error: "item_bank_image_alt_target_missing" };
      const attributes = imageAttributes(selected.tag);
      if (!attributes) return { error: "item_bank_image_alt_markup_unreadable" };
      const source = attributes.get("src");
      if (typeof source !== "string" || source.length === 0 || await digest(source) !== guard.image_src_sha256) return { error: "item_bank_image_alt_target_changed" };
      if (attributes.has("alt")) return { error: "item_bank_image_alt_already_present" };
      let matches = 0;
      for (const image of before.images) {
        const other = imageAttributes(image.tag);
        if (!other) return { error: "item_bank_image_alt_markup_unreadable" };
        if (typeof other.get("src") === "string" && await digest(other.get("src")) === guard.image_src_sha256) matches += 1;
      }
      if (matches !== 1) return { error: "item_bank_image_alt_ambiguous" };
      const suffix = selected.tag.endsWith("/>") ? "/>" : ">";
      const alt = escapeAlt(guard.alt_text);
      const tag = `${selected.tag.slice(0, selected.tag.length - suffix.length)} alt="${alt}"${suffix}`;
      const next = `${value.slice(0, selected.start)}${tag}${value.slice(selected.end + 1)}`;
      const after = contentImages(next);
      const changed = after.images[guard.image_index - 1];
      const changedAttributes = changed ? imageAttributes(changed.tag) : null;
      if (after.open || after.images.length !== before.images.length || !changedAttributes
        || changedAttributes.size !== attributes.size + 1
        || changedAttributes.get("alt") !== alt
        || [...attributes].some(([name, held]) => changedAttributes.get(name) !== held)
        || after.images.some((image, index) => index !== guard.image_index - 1 && image.tag !== before.images[index].tag)) {
        return { error: "item_bank_image_alt_body_mismatch" };
      }
      return { body: next };
    };

    const imageAltPresent = async (value, guard) => {
      if (typeof value !== "string" || value.length > MAX_ITEM_BODY) return false;
      const scan = contentImages(value);
      if (scan.open) return false;
      const image = scan.images[guard.image_index - 1];
      const attributes = image ? imageAttributes(image.tag) : null;
      if (!attributes || attributes.get("alt") !== escapeAlt(guard.alt_text)) return false;
      const source = attributes.get("src");
      return typeof source === "string" && await digest(source) === guard.image_src_sha256;
    };

    const refuse = (error) => ({ matched: true, ok: false, sent: false, error });
    const guard = itemBankGuard;
    const args = input.arguments || {};
    const argumentKeys = Object.keys(args);
    if (!validGuard(guard) || guard.course_id !== input.courseId
      || guard.bank_id !== String(args.bank_id) || guard.item_id !== String(args.item_id)
      || argumentKeys.length !== 3 || argumentKeys.some((key) => !["bank_id", "item_id", "morrow_item_bank_guard"].includes(key))) {
      return refuse("item_bank_guard_invalid");
    }
    const fanOutReason = await validFanOut(guard.fan_out, guard.bank_id, guard.course_id, guard.acknowledged_course_ids, Date.now());
    if (fanOutReason) return refuse(`item_bank_fan_out_${fanOutReason}`);
    const entryPath = `/api/banks/${encodeURIComponent(guard.bank_id)}/bank_entries/${encodeURIComponent(guard.bank_entry_id)}`;
    if (!/^\/api\/banks(?:[/?#]|$)/.test(entryPath) || entryPath.includes("://") || entryPath.split("/").includes("..")) return refuse("item_bank_path_refused");

    const request = async (method, requestPath, requestBody) => {
      let response;
      try {
        response = await fetch(`https://${apiHost}${requestPath}`, {
          method,
          headers: requestBody === undefined ? headers : { ...headers, "Content-Type": "application/json" },
          credentials: "omit",
          redirect: "error",
          ...(requestBody === undefined ? {} : { body: JSON.stringify(requestBody) }),
        });
      } catch {
        return { transport: true };
      }
      const read = await boundedResponseText(response);
      if (read.unreadable) {
        return { transport: true, status: response.status };
      }
      if (read.oversize) return { oversize: true, status: response.status };
      const payload = read.text;
      let data = null;
      let parsed = true;
      try { data = payload ? JSON.parse(payload) : null; } catch { data = payload.slice(0, MAX_BYTES); parsed = false; }
      return { ok: response.ok, status: response.status, data, parsed };
    };
    const readable = (result) => Boolean(result?.ok) && result.parsed === true && plain(result.data);

    // Fresh read before. The digest pins the whole question, so every offset,
    // id and protected field below is taken from the bytes the repair was
    // planned against.
    const readItem = await request("GET", path);
    if (!readable(readItem)) return refuse("item_bank_source_unavailable");
    const current = readItem.data;
    if (await digest(stable(current)) !== guard.item_sha256) return refuse("item_bank_source_changed");
    if (current.entry_type !== "Item" || String(current.id) !== guard.item_id
      || !plain(current.entry) || typeof current.entry.item_body !== "string") return refuse("item_bank_item_shape_unsupported");

    // Resolve the bank entry itself. A list row is not an item, so the entry is
    // read whole and must name this exact question.
    const readEntry = await request("GET", entryPath);
    if (!readable(readEntry) || !entryLinksItem(readEntry.data, guard.item_id)) return refuse("item_bank_entry_unresolved");

    const applied = await applyImageAlt(current.entry.item_body, guard);
    if (applied.error) return refuse(applied.error);
    const proposed = structuredClone(current);
    proposed.entry.item_body = applied.body;

    // New Quizzes merges interaction elements by id, so a write that changes an
    // id leaves the old element behind as a blank ghost stub. The proposal is
    // the question this frame read with one image body replaced, and this check
    // keeps it that way.
    const currentIds = interactionIds(current);
    const proposedIds = interactionIds(proposed);
    if (currentIds === null || proposedIds === null) return refuse("item_bank_interaction_ids_unreadable");
    if (!sameList(currentIds, proposedIds)) return refuse("item_bank_interaction_ids_changed");

    const proposedProtected = protectedState(proposed);
    if (proposedProtected === null || await digest(stable(proposedProtected)) !== guard.protected_state_sha256) return refuse("item_bank_protected_state_changed");

    // One dispatch. No loop, no in-frame retry: a repeat could apply the change
    // twice to a bank other courses draw from.
    const written = await request("PATCH", path, { item: proposed });
    if (written.oversize) return { matched: true, ok: false, sent: true, status: written.status, outcomeUnknown: itemBankOutcomeUnknown(operation.method, written.status), error: "item_bank_response_too_large" };
    if (written.transport) return { matched: true, ok: false, sent: true, outcomeUnknown: true, error: "item_bank_request_failed" };
    if (!written.ok) return { matched: true, ok: false, sent: true, status: written.status, data: sanitize(written.data), apiHost, outcomeUnknown: itemBankOutcomeUnknown(operation.method, written.status) };

    // Fresh read after. "mismatch" is the word the gateway accepts for a
    // readback that did not match; a status outside verified, mismatch and
    // unconfirmed is dropped on the way back and would leave the write with no
    // verification at all.
    const base = { schema: "morrow.browser-verification.v1", strategy: "item-bank-item-readback" };
    const verify = async () => {
      try {
        return await compare();
      } catch {
        // The write is already made. Anything that stops the check after it
        // leaves the outcome unknown, never failed and never verified.
        return { ...base, status: "unconfirmed", reason: "item_bank_readback_unavailable" };
      }
    };
    const compare = async () => {
      const readback = await request("GET", path);
      if (!readable(readback)) return { ...base, status: "unconfirmed", reason: "item_bank_readback_unavailable" };
      const saved = readback.data;
      const savedBody = plain(saved.entry) && typeof saved.entry.item_body === "string" ? saved.entry.item_body : "";
      const expectedBodySha256 = await digest(applied.body);
      const savedBodySha256 = await digest(savedBody);
      const mismatch = (reason) => ({ ...base, status: "mismatch", reason, expectedBodySha256, savedBodySha256 });
      if (saved.entry_type !== "Item" || String(saved.id) !== guard.item_id || !plain(saved.entry) || typeof saved.entry.item_body !== "string") return mismatch("saved_item_did_not_match_target");
      const savedIds = interactionIds(saved);
      if (savedIds === null || !sameList(savedIds, proposedIds)) return mismatch("item_bank_interaction_ids_changed");
      const savedProtected = protectedState(saved);
      if (savedProtected === null || await digest(stable(savedProtected)) !== guard.protected_state_sha256) return mismatch("saved_protected_state_did_not_match");
      if (savedBodySha256 !== expectedBodySha256) return mismatch("saved_item_body_did_not_match");
      if (!await imageAltPresent(savedBody, guard)) return mismatch("saved_image_alt_reaudit_did_not_match");
      return { ...base, status: "verified", evidence: "item_body_and_protected_state_reread_after_write" };
    };
    // A frame that is gone, or a read that does not answer, leaves the outcome
    // unknown. Morrow does not fall back to a server-side call here: the
    // credential never leaves this frame.
    const verification = await verify();
    // An accepted repair answers with what happened, not with the question. The
    // provider echoes the whole saved question, including the image source and
    // the approved alternative text, and the verification above already proves
    // the outcome, so none of that content travels back out of the frame.
    return {
      matched: true,
      ok: true,
      sent: true,
      status: written.status,
      apiHost,
      outcomeUnknown: verification.status === "unconfirmed",
      verification,
    };
  }
  const pageParameter = operation.method === "GET" && ["list_banks", "list_entries", "list_shares"].includes(operation.nickname)
    ? operation.parameters.find((parameter) => parameter.inputName === "page")
    : null;
  const requestedStartPage = Number(query.get(pageParameter?.wireName || "") || 1);
  const startPage = Number.isInteger(requestedStartPage) && requestedStartPage > 0 ? requestedStartPage : 1;
  const requestedMaxPages = Number(input.arguments?.morrow_max_pages || 25);
  const maxPages = pageParameter
    ? Math.max(1, Math.min(Number.isInteger(requestedMaxPages) ? requestedMaxPages : 25, 50))
    : 1;
  const pages = [];
  let truncated = false;
  let status = 0;
  for (let offset = 0; offset < maxPages; offset += 1) {
    const requestQuery = new URLSearchParams(query);
    if (pageParameter) requestQuery.set(pageParameter.wireName, String(startPage + offset));
    const requestPath = requestQuery.size ? `${path}${path.includes("?") ? "&" : "?"}${requestQuery}` : path;
    let response;
    try {
      response = await fetch(`https://${apiHost}${requestPath}`, {
        method: operation.method,
        headers,
        credentials: "omit",
        redirect: "error",
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      return { matched: true, ok: false, sent: operation.method !== "GET", outcomeUnknown: operation.method !== "GET", error: "item_bank_request_failed" };
    }
    status = response.status;
    const read = await boundedResponseText(response);
    if (read.unreadable) return { matched: true, ok: false, sent: true, outcomeUnknown: operation.method !== "GET", status, error: "item_bank_response_unreadable" };
    if (read.oversize) return { matched: true, ok: false, sent: true, status, outcomeUnknown: itemBankOutcomeUnknown(operation.method, status), error: "item_bank_response_too_large" };
    const text = read.text;
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text.slice(0, MAX_BYTES); }
    if (!response.ok) return { matched: true, ok: false, sent: true, status: response.status, data: sanitize(data), apiHost, outcomeUnknown: itemBankOutcomeUnknown(operation.method, response.status) };
    pages.push(data);
    if (!pageParameter || !Array.isArray(data) || data.length === 0) break;
    truncated = offset + 1 === maxPages;
  }
  const collection = pages.length === 1 ? pages[0] : pages.flatMap((page) => Array.isArray(page) ? page : [page]);
  const collectionRead = operation.method === "GET" && ["list_banks", "list_entries", "list_shares"].includes(operation.nickname);
  const dataTruncated = collectionRead && Array.isArray(collection) && collection.length > 10_000;
  const collectionShapeUnknown = collectionRead && pages.some((page) => !Array.isArray(page));
  return {
    matched: true,
    ok: true,
    sent: true,
    status,
    data: sanitize(collection),
    apiHost,
    outcomeUnknown: false,
    ...(collectionRead ? {
      ...(pageParameter ? { pageCount: pages.length } : {}),
      truncated: truncated || dataTruncated || collectionShapeUnknown,
    } : {}),
  };
}
