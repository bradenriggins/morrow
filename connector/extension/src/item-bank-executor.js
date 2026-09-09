export async function executeItemBankInPage(input) {
  const MAX_BYTES = 2 * 1024 * 1024;
  const hostPattern = /^[^.]+\.quiz-(?:lti|api)(?:-[^.]+)*\.instructure\.com$/i;
  const apiHostPattern = /^[^.]+\.quiz-api(?:-[^.]+)*\.instructure\.com$/i;
  const id = (value) => /^[1-9][0-9]{0,18}$/.test(String(value || "")) ? String(value) : "";
  const json = (storage, key) => {
    try { return JSON.parse(storage.getItem(key) || "null"); } catch { return null; }
  };
  const currentUser = json(sessionStorage, "current_user") || json(localStorage, "current_user");
  const principalId = id(currentUser?.current_user?.id ?? currentUser?.id ?? globalThis.ENV?.current_user_id);
  if (!principalId || principalId !== input.principalId) return { matched: false };
  const currentHost = location.hostname.toLowerCase();
  const apiHost = hostPattern.test(currentHost) ? currentHost.replace(".quiz-lti", ".quiz-api") : "";
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
  const referrerCourse = referrerUrl.pathname.match(/^\/courses\/([1-9][0-9]*)\/external_tools\/54065\/?$/)?.[1];
  if (!input.courseId || referrerCourse !== input.courseId) return { matched: false };
  const operation = input.operation;
  if (!operation || operation.service !== "item_bank" || !["GET", "POST", "PATCH", "DELETE"].includes(operation.method)) return { matched: false };
  const operationContracts = {
    list_banks: ["GET", "/api/banks"],
    get_bank: ["GET", "/api/banks/{bank_id}"],
    list_entries: ["GET", "/api/banks/{bank_id}/bank_entries"],
    get_entry: ["GET", "/api/banks/{bank_id}/bank_entries/{bank_entry_id}"],
    list_shares: ["GET", "/api/banks/{bank_id}/shared_banks"],
    create_bank: ["POST", "/api/banks"],
    rename_bank: ["PATCH", "/api/banks/{bank_id}"],
    archive_bank: ["DELETE", "/api/banks/{bank_id}"],
    attach_item: ["POST", "/api/banks/{bank_id}/bank_entries"],
    create_item: ["POST", "/api/banks/{bank_id}/items"],
    get_item: ["GET", "/api/banks/{bank_id}/items/{item_id}"],
    update_item: ["PATCH", "/api/banks/{bank_id}/items/{item_id}"],
    delete_entry: ["DELETE", "/api/banks/{bank_id}/bank_entries/{bank_entry_id}"],
    share_bank: ["POST", "/api/banks/{bank_id}/shared_banks"],
  };
  const contract = operationContracts[operation.nickname];
  if (!contract || operation.method !== contract[0] || operation.path !== contract[1]) {
    return { matched: true, ok: false, sent: false, error: "item_bank_operation_contract_mismatch" };
  }
  // The frame probe carries the binding and the operation shape, never the
  // arguments, so nothing above this line may read input.arguments. A probe
  // that needed the payload would disclose it to every candidate frame before
  // one frame was chosen.
  if (input.contextOnly === true) return { matched: true, ok: true, sent: false };
  const itemBankGuard = input.arguments?.morrow_item_bank_guard;
  const guardedUpdate = itemBankGuard !== undefined && operation.nickname === "update_item";
  if (itemBankGuard !== undefined && !guardedUpdate) return { matched: true, ok: false, sent: false, error: "item_bank_guard_refused" };
  const credential = input.credential;
  const token = typeof credential?.token === "string" ? credential.token : "";
  const contextUuid = typeof credential?.contextUuid === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(credential.contextUuid)
    ? credential.contextUuid : "";
  const launchedAt = Number(credential?.launchedAt);
  const capturedAt = Number(credential?.capturedAt);
  if (!credential || credential.apiOrigin !== `https://${apiHost}` || credential.authType !== "Signature"
    || credential.canvasLocalContextId !== input.courseId || credential.launchUrl !== referrerUrl.href
    || typeof credential.launchNonce !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(credential.launchNonce)
    || token.length < 51 || token.length > 8192 || !contextUuid
    || !Number.isFinite(launchedAt) || !Number.isFinite(capturedAt) || capturedAt < launchedAt
    || capturedAt - launchedAt > 45_000 || capturedAt > Date.now() || Date.now() - capturedAt > 10 * 60 * 1_000) {
    return { matched: true, ok: false, sent: false, error: "item_bank_credential_unavailable" };
  }
  const requestedCourse = id(input.arguments?.course_id ?? itemBankGuard?.course_id);
  if (!requestedCourse) return { matched: true, ok: false, sent: false, error: "course_id is required" };
  if (requestedCourse !== input.courseId) {
    return { matched: true, ok: false, sent: false, error: "item_bank_course_mismatch" };
  }
  let path = operation.path;
  const query = new URLSearchParams();
  const formValues = {};
  for (const parameter of operation.parameters) {
    // A legacy guarded request carries its question, its snapshots and its
    // observed-reach disclosure inside the frozen guard, never as separate
    // arguments. The guard check below refuses any top-level argument other
    // than the two target ids and the guard itself.
    if (guardedUpdate && ["item", "expected_snapshot", "fan_out", "fan_out_receipt", "acknowledged_course_ids"].includes(parameter.inputName)) continue;
    const value = guardedUpdate && parameter.inputName === "course_id"
      ? itemBankGuard.course_id
      : input.arguments?.[parameter.inputName];
    if (value === undefined || value === null || value === "") {
      if (parameter.required) return { matched: true, ok: false, sent: false, error: `${parameter.inputName} is required` };
      continue;
    }
    if (parameter.location === "path") path = path.replace(`{${parameter.wireName}}`, encodeURIComponent(String(value)));
    else if (parameter.location === "control") continue;
    else if (parameter.location === "query" || operation.method === "GET") {
      query.append(parameter.wireName, operation.nickname === "list_banks" && parameter.inputName === "course_id" ? contextUuid : String(value));
    }
    else formValues[parameter.wireName] = value;
  }
  if (!/^\/api\/banks(?:[/?#]|$)/.test(path) || path.includes("://") || path.split(/[?#]/)[0].split("/").includes("..") || /\{[^}]+\}/.test(path)) {
    return { matched: true, ok: false, sent: false, error: "item_bank_path_refused" };
  }
  // The media rule, over every string the payload carries. It reports every
  // offending element with the exact tag that carries it, not just the first
  // reason, so an update can be judged against the question already stored:
  // repairing one image must never be refused because a different image in the
  // same question still needs work. A finding with no tag names no element, so
  // it can never be matched against a stored one and always refuses.
  const MEDIA_ELEMENTS = ["img", "audio", "video"];
  const MEDIA_SRC_PREFIXES = ["https://", "/courses/", "/api/v1/files/"];
  const MEDIA_TAG = /<\s*(?:img|audio|video)\b/i;
  const TAG = /<!--[\s\S]*?-->|<(?:"[^"]*"|'[^']*'|[^'">])*>/g;
  const TAG_NAME = /^<\s*(\/?)\s*([a-zA-Z][^\s/>]*)/;
  const ATTRIBUTE = /^\s+([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/;
  const RAW_TEXT = ["script", "style", "iframe", "object", "embed", "textarea", "title"];
  const MAX_DEPTH = 32;
  const plainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
  const stringMediaFindings = (value, findings) => {
    if (!MEDIA_TAG.test(value)) return;
    const scan = mediaElements(value);
    // Markup this scan could not read names no element, so it can never be
    // matched against a stored one and always refuses.
    if (scan.open) {
      findings.push({ reason: "media_markup_unreadable", tag: "" });
      return;
    }
    for (const element of scan.elements) {
      const attributes = tagAttributes(element.tag);
      if (!attributes) {
        findings.push({ reason: "media_markup_unreadable", tag: "" });
        continue;
      }
      // Presence, not content: alt="" is how a decorative image is marked, and
      // it is the author's answer rather than a missing one. The finding names
      // the exact element that carries it, so a problem the question already
      // has can never excuse a second one or a different one.
      if (element.name === "img" && !attributes.has("alt")) findings.push({ reason: "media_image_alt_missing", tag: element.tag });
      const source = attributes.get("src");
      if (source !== undefined && !MEDIA_SRC_PREFIXES.some((prefix) => source.startsWith(prefix))) {
        findings.push({ reason: "media_src_unsupported", tag: element.tag });
      }
    }
  };
  const mediaFindings = (value, depth, findings) => {
    if (depth > MAX_DEPTH) {
      // Depth is a property of the payload, not of one element, so it names
      // nothing a stored question could already carry.
      findings.push({ reason: "payload_too_deep", tag: "" });
      return findings;
    }
    if (typeof value === "string") stringMediaFindings(value, findings);
    else if (Array.isArray(value)) for (const member of value) mediaFindings(member, depth + 1, findings);
    else if (plainObject(value)) for (const child of Object.values(value)) mediaFindings(child, depth + 1, findings);
    return findings;
  };
  // The first media problem the proposed question carries that the stored
  // question does not already carry. The match is per element and counted,
  // never per code: one undescribed image in the stored question excuses that
  // one image and nothing else, so a second copy of it and any different
  // undescribed image are both refused.
  const newMediaReason = (proposed, stored) => {
    const held = new Map();
    for (const finding of mediaFindings(stored, 0, [])) {
      if (!finding.tag) continue;
      const key = `${finding.reason}\u0000${finding.tag}`;
      held.set(key, (held.get(key) || 0) + 1);
    }
    for (const finding of mediaFindings(proposed, 0, [])) {
      const key = `${finding.reason}\u0000${finding.tag}`;
      const count = finding.tag ? held.get(key) || 0 : 0;
      if (count === 0) return finding.reason;
      held.set(key, count - 1);
    }
    return null;
  };
  let updateMediaCheck = false;
  let body;
  if (operation.nickname === "create_bank") body = { bank: { title: String(formValues.title), language: String(formValues.language || "en") } };
  else if (operation.nickname === "rename_bank") body = { bank: { title: String(formValues.title) } };
  else if (operation.nickname === "attach_item") body = { bank_entry: { bank_id: String(input.arguments.bank_id), entry_type: "Item", entry_id: String(formValues.item_id) } };
  else if (operation.nickname === "share_bank") {
    // Only a course share with read permission is established. Every other
    // scope is unverified, so Morrow refuses it instead of sending it.
    if (String(formValues.entity_type) !== "course") return { matched: true, ok: false, sent: false, error: "item_bank_share_scope_unsupported" };
    if (formValues.permission !== undefined && String(formValues.permission) !== "read") return { matched: true, ok: false, sent: false, error: "item_bank_share_permission_unsupported" };
    body = { shared_bank: { entity_id: String(formValues.entity_id), entityType: String(formValues.entity_type), bank_id: String(input.arguments.bank_id), permission: "read" } };
  }
  else if (!guardedUpdate && (operation.nickname === "create_item" || operation.nickname === "update_item")) {
    body = formValues.item && typeof formValues.item === "object" && !Array.isArray(formValues.item) && Object.hasOwn(formValues.item, "item")
      ? formValues.item
      : { item: formValues.item };
    // The service worker validates all supported question shapes before it opens
    // this frame. It issues payloadContractSha256 for that exact outer item.
    // The checks below add in-frame defense for the four most complex shapes.
    // The digest check after them is the trust boundary for every supported
    // shape and rejects a missing, changed, or caller-supplied certificate.
    const payloadReason = (() => {
      const CHOICE_SLUGS = ["choice", "multiple_choice"];
      const CHOICE_INTERACTION_TYPE_ID = 1;
      const RICH_FILL_SLUGS = ["rich_fill_blank", "rich_fill", "rich_fill_in_the_blank"];
      const BLANK_KINDS = { openentry: "openEntry", dropdown: "TextInChoices", textinchoices: "TextInChoices", wordbank: "wordbank" };
      const INTERACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
      const BLANK_MARKER = /id\s*=\s*(?:"blank_([^"]*)"|'blank_([^']*)')/g;
      const scalar = (value) => typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
      const asText = (value) => scalar(value) ? String(value) : "";
      const normalizeSlug = (value) => typeof value === "string" ? value.trim().toLowerCase().replaceAll(/[\s-]+/g, "_") : "";

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
    // A create has no stored question to compare against, so every media
    // finding refuses here. An update is judged after the fresh pre-write read
    // below, against the exact question Canvas holds right now.
    const findings = mediaFindings(body.item, 0, []);
    const absolute = operation.nickname === "create_item" ? findings[0] : findings.find((finding) => !finding.tag);
    if (absolute) return { matched: true, ok: false, sent: false, error: `item_bank_payload_${absolute.reason}` };
    if (payloadReason) return { matched: true, ok: false, sent: false, error: `item_bank_payload_${payloadReason}` };
    updateMediaCheck = operation.nickname === "update_item" && findings.length > 0;
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
  // Two private values reach this frame from the captured launch rather than
  // from the person: the credential token and the LTI context UUID. Neither may
  // travel back inside provider data. The context UUID is sent as the
  // `course_id` query claim on every bank list read, so a tenant that echoes the
  // request back into a bank row would return it. No fixture pins what Canvas
  // echoes and no live run has settled it, so this is not conditional on having
  // seen the leak. Both values are non-empty here: an unusable credential
  // returned `item_bank_credential_unavailable` above.
  const privateText = (value) => value.split(token).join("[redacted]").split(contextUuid).join("[redacted]");
  const sanitize = (value, depth = 0) => {
    if (depth > 24) return null;
    if (Array.isArray(value)) return value.slice(0, 10_000).map((entry) => sanitize(entry, depth + 1));
    if (!value || typeof value !== "object") return typeof value === "string" ? privateText(value) : value;
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      // A legacy guard is private control data, so it never travels back in a result.
      if (/(?:authorization|bearer|token|secret|credential|cookie|csrf)/i.test(key) || /^morrow_.*guard$/i.test(key)) continue;
      output[key] = sanitize(child, depth + 1);
    }
    return output;
  };
  const stable = (value) => Array.isArray(value)
    ? `[${value.map(stable).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
      : JSON.stringify(value === undefined ? null : value);
  const digest = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)))), (byte) => byte.toString(16).padStart(2, "0")).join("");
  // Canvas pins no one key casing for a share row, and Morrow's own share
  // request body at the branch below mixes them, so the casing a tenant answers
  // with is the tenant's. Every reader of a share row in this file uses this one
  // pair. The two readers are the pre-write duplicate check and the post-write
  // readback of the same write: a reader quietly stricter than its twin compares
  // against "undefined" and reports a share Canvas did create as unconfirmed,
  // which is a working operation that looks broken. The gateway readers of the
  // same rows, packages/mcp-server/src/item-bank-fan-out.ts and
  // packages/mcp-server/src/course-inventory.ts, accept both casings too.
  const shareEntityId = (row) => String(row?.entity_id ?? row?.entityId ?? "");
  const shareEntityType = (row) => String(row?.entity_type ?? row?.entityType ?? "");
  // A legacy guarded repair carries no caller-supplied question. Its
  // certificate is the guard's own item and protected-state digests, checked
  // against a fresh read further down.
  if (!guardedUpdate && ["create_item", "update_item"].includes(operation.nickname)
    && (!/^[0-9a-f]{64}$/.test(String(input.payloadContractSha256 || ""))
      || input.payloadContractSha256 !== await digest(input.arguments?.item))) {
    return { matched: true, ok: false, sent: false, error: "item_bank_payload_contract_unverified" };
  }
  const validObservedFanOut = async (record, bank, course, acknowledged) => {
    const plain = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
    const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
    const compareIds = (left, right) => left.length === right.length ? compareText(left, right) : left.length - right.length;
    if (!plain(record)) return "missing_record";
    if (record.schema !== "morrow.canvas.item-bank.fan-out.v1") return "wrong_schema";
    if (String(record.bank_id || "") !== bank) return "bank_mismatch";
    if (String(record.course_id || "") !== course) return "course_mismatch";
    // The same unread-source rule as connector/extension/src/item-bank-fan-out.js:
    // a source that is missing, unfinished, or named unreachable was not walked
    // to its end. scripts/test/canvas-item-bank-fan-out.test.mjs runs
    // its copy and this executor copy over the same records.
    const asName = (value) => typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
    const sources = ["bank_entries", "shared_banks", "quiz_uses"];
    const exhausted = new Map();
    for (const row of Array.isArray(record.sources) ? record.sources : []) {
      const name = asName(row?.name);
      exhausted.set(name, exhausted.has(name) ? false : row?.exhausted === true);
    }
    const declared = Array.isArray(record.unreachable) ? record.unreachable.map(asName) : [...sources];
    const unread = [...new Set([...declared, ...sources.filter((name) => exhausted.get(name) !== true)])].filter(Boolean);
    if (record.complete !== false || unread.length === 0) return "authoritative_reach_claim_refused";
    if (!Array.isArray(record.consumers)) return "consumers_invalid";
    const consumers = [];
    const seen = new Set();
    for (const value of record.consumers) {
      if (!plain(value)) return "consumers_invalid";
      const consumer = { course_id: String(value.course_id || ""), entity_type: String(value.entity_type || ""), entity_id: String(value.entity_id || "") };
      if (!/^[1-9][0-9]*$/.test(consumer.course_id) || !/^[a-z][a-z0-9_]{0,63}$/.test(consumer.entity_type)
        || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(consumer.entity_id)) return "consumers_invalid";
      const key = `${consumer.course_id} ${consumer.entity_type} ${consumer.entity_id}`;
      if (seen.has(key)) return "consumers_invalid";
      seen.add(key);
      consumers.push(consumer);
    }
    consumers.sort((left, right) => compareIds(left.course_id, right.course_id)
      || compareText(left.entity_type, right.entity_type) || compareText(left.entity_id, right.entity_id));
    if (record.consumer_count !== consumers.length) return "consumer_count_mismatch";
    if (!/^[0-9a-f]{64}$/.test(String(record.consumers_sha256 || "")) || record.consumers_sha256 !== await digest(consumers)) return "consumers_digest_mismatch";
    const established = Date.parse(String(record.established_at || ""));
    if (!/(?:Z|[+-][0-9]{2}:?[0-9]{2})$/i.test(String(record.established_at || "")) || !Number.isFinite(established)) return "established_at_unreadable";
    if (established > Date.now()) return "record_from_future";
    if (Date.now() - established > 60 * 60 * 1_000) return "record_too_old";
    const external = [...new Set(consumers.map((value) => value.course_id))].filter((value) => value !== course).sort(compareIds);
    if (!Array.isArray(record.external_course_ids) || stable(record.external_course_ids) !== stable(external)) return "external_course_ids_mismatch";
    if (!Array.isArray(acknowledged) || !acknowledged.every((value) => /^[1-9][0-9]*$/.test(String(value)))
      || stable(acknowledged.map(String).sort(compareIds)) !== stable(external)) return "acknowledgement_mismatch";
    return null;
  };
  const verifyCourseAssociation = async () => {
    const requestedBank = id(input.arguments?.bank_id);
    if (!requestedBank) return { matched: true, ok: false, sent: false, error: "bank_id is required" };
    let associated = false;
    let exhausted = false;
    for (let page = 1; page <= 25; page += 1) {
      let response;
      try {
        const associationQuery = new URLSearchParams({ course_id: contextUuid, page: String(page), per_page: "100" });
        response = await fetch(`https://${apiHost}/api/banks?${associationQuery}`, {
          method: "GET", headers, credentials: "omit", redirect: "error",
        });
      } catch {
        return { matched: true, ok: false, sent: false, outcomeUnknown: false, error: "item_bank_course_association_unreadable" };
      }
      const read = await boundedResponseText(response);
      if (!response.ok || read.unreadable || read.oversize) {
        return { matched: true, ok: false, sent: false, status: response.status, outcomeUnknown: false, error: "item_bank_course_association_unreadable" };
      }
      let rows;
      try { rows = read.text ? JSON.parse(read.text) : null; } catch { rows = null; }
      if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== "object" || Array.isArray(row) || !id(row.id))) {
        return { matched: true, ok: false, sent: false, status: response.status, outcomeUnknown: false, error: "item_bank_course_association_unreadable" };
      }
      if (rows.some((row) => id(row.id) === requestedBank)) {
        associated = true;
        break;
      }
      if (rows.length === 0) {
        exhausted = true;
        break;
      }
    }
    if (associated) return null;
    return exhausted
      ? { matched: true, ok: false, sent: false, error: "item_bank_course_association_unverified" }
      : { matched: true, ok: false, sent: false, outcomeUnknown: false, error: "item_bank_course_association_unreadable" };
  };
  const bankSpecific = !["list_banks", "create_bank"].includes(operation.nickname);
  if (bankSpecific && !guardedUpdate) {
    const associationRefusal = await verifyCourseAssociation();
    if (associationRefusal) return associationRefusal;
  }
  if (operation.method !== "GET" && !guardedUpdate) {
    if (operation.nickname !== "create_bank") {
      const fanOutReason = await validObservedFanOut(input.arguments?.fan_out, String(input.arguments?.bank_id || ""), input.courseId, input.arguments?.acknowledged_course_ids);
      if (fanOutReason) return { matched: true, ok: false, sent: false, error: `item_bank_fan_out_${fanOutReason}` };
    }
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
      if (read.unreadable) return { transport: true, status: response.status };
      if (read.oversize) return { oversize: true, status: response.status };
      let data = null;
      let parsed = true;
      try { data = read.text ? JSON.parse(read.text) : null; } catch { data = read.text; parsed = false; }
      return { ok: response.ok, status: response.status, data, parsed };
    };
    const readableObject = (result) => Boolean(result?.ok) && result.parsed === true
      && Boolean(result.data) && typeof result.data === "object" && !Array.isArray(result.data);
    const readObject = async (requestPath) => await request("GET", requestPath);
    const readList = async (requestPath, baseQuery = {}) => {
      const rows = [];
      for (let page = 1; page <= 25; page += 1) {
        const listQuery = new URLSearchParams({ ...baseQuery, page: String(page), per_page: "100" });
        const result = await request("GET", `${requestPath}?${listQuery}`);
        if (!result.ok || result.parsed !== true || !Array.isArray(result.data)) return { error: result };
        if (result.data.length === 0) return { rows };
        rows.push(...result.data);
      }
      return { error: { capped: true } };
    };
    const readObservedList = async (requestPath) => {
      // Canvas share pagination is not established. This reads one unpaged
      // response, so every digest and duplicate check built from it covers
      // the rows observed, never a complete share list.
      const result = await request("GET", requestPath);
      return result.ok && result.parsed === true && Array.isArray(result.data) ? { rows: result.data } : { error: result };
    };
    const plain = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
    const snapshot = input.arguments?.expected_snapshot;
    const snapshotKeys = ["banks_sha256", "bank_sha256", "item_sha256", "entries_sha256", "entry_sha256", "shares_sha256"];
    const requiredSnapshots = {
      create_bank: ["banks_sha256"],
      rename_bank: ["bank_sha256"],
      archive_bank: ["bank_sha256", "entries_sha256", "shares_sha256"],
      attach_item: ["bank_sha256", "item_sha256", "entries_sha256"],
      create_item: ["bank_sha256"],
      update_item: ["bank_sha256", "item_sha256"],
      delete_entry: ["bank_sha256", "entry_sha256", "entries_sha256"],
      share_bank: ["bank_sha256", "shares_sha256"],
    }[operation.nickname] || [];
    const validDigest = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
    if (!plain(snapshot) || Object.keys(snapshot).some((key) => !snapshotKeys.includes(key))
      || requiredSnapshots.some((key) => !validDigest(snapshot[key]))) {
      return { matched: true, ok: false, sent: false, error: "item_bank_snapshot_invalid" };
    }
    const preflight = {};
    const before = {};
    const bankId = id(input.arguments?.bank_id);
    const itemId = id(input.arguments?.item_id);
    const entryId = id(input.arguments?.bank_entry_id);
    if (snapshot.banks_sha256) {
      const list = await readList("/api/banks", { course_id: contextUuid });
      if (list.error) return { matched: true, ok: false, sent: false, error: "item_bank_snapshot_unreadable" };
      before.banks = sanitize(list.rows);
      preflight.banks_sha256 = await digest(before.banks);
    }
    if (snapshot.bank_sha256) {
      const result = await readObject(`/api/banks/${encodeURIComponent(bankId)}`);
      if (!readableObject(result)) return { matched: true, ok: false, sent: false, error: "item_bank_snapshot_unreadable" };
      before.bank = sanitize(result.data);
      preflight.bank_sha256 = await digest(before.bank);
    }
    if (snapshot.item_sha256) {
      const result = await readObject(`/api/banks/${encodeURIComponent(bankId)}/items/${encodeURIComponent(itemId)}`);
      if (!readableObject(result)) return { matched: true, ok: false, sent: false, error: "item_bank_snapshot_unreadable" };
      before.item = sanitize(result.data);
      preflight.item_sha256 = await digest(before.item);
    }
    if (snapshot.entries_sha256) {
      const list = await readList(`/api/banks/${encodeURIComponent(bankId)}/bank_entries`);
      if (list.error) return { matched: true, ok: false, sent: false, error: "item_bank_snapshot_unreadable" };
      before.entries = sanitize(list.rows);
      preflight.entries_sha256 = await digest(before.entries);
    }
    if (snapshot.entry_sha256) {
      const result = await readObject(`/api/banks/${encodeURIComponent(bankId)}/bank_entries/${encodeURIComponent(entryId)}`);
      if (!readableObject(result)) return { matched: true, ok: false, sent: false, error: "item_bank_snapshot_unreadable" };
      before.entry = sanitize(result.data);
      preflight.entry_sha256 = await digest(before.entry);
    }
    if (snapshot.shares_sha256) {
      // The pinned digest covers the share rows one unpaged read observed,
      // not a complete share list: the same caveat the read tool reports.
      const list = await readObservedList(`/api/banks/${encodeURIComponent(bankId)}/shared_banks`);
      if (list.error) return { matched: true, ok: false, sent: false, error: "item_bank_snapshot_unreadable" };
      before.shares = sanitize(list.rows);
      preflight.shares_sha256 = await digest(before.shares);
    }
    // Every digest the reviewer sent is compared, not only the required ones. A
    // reviewer who pins more state than the minimum gets that state honoured.
    if (Object.keys(snapshot).some((key) => preflight[key] !== snapshot[key])) {
      return { matched: true, ok: false, sent: false, error: "item_bank_snapshot_changed" };
    }
    // The one media judgement that needs both questions: the reviewed payload
    // against the exact stored question this write is pinned to. A problem the
    // question already has stays the question's; a problem this change would
    // add stops the write before dispatch.
    if (updateMediaCheck) {
      const stored = plain(before.item) ? before.item : null;
      const added = stored === null ? "media_image_alt_missing" : newMediaReason(body.item, stored);
      if (added) return { matched: true, ok: false, sent: false, error: `item_bank_payload_${added}` };
    }
    if (operation.nickname === "create_bank" && (before.banks || []).some((row) => String(row?.title) === String(formValues.title)
      && String(row?.language || "en") === String(formValues.language || "en"))) {
      return { matched: true, ok: false, sent: false, error: "item_bank_create_recovery_ambiguous" };
    }
    if (operation.nickname === "attach_item" && (before.entries || []).some((row) => String(row?.entry_type) === "Item"
      && String(row?.entry_id) === String(formValues.item_id))) {
      return { matched: true, ok: false, sent: false, error: "item_bank_item_already_attached" };
    }
    if (operation.nickname === "share_bank" && (before.shares || []).some((row) => shareEntityId(row) === String(formValues.entity_id)
      && shareEntityType(row) === "course" && String(row?.permission) === "read")) {
      return { matched: true, ok: false, sent: false, error: "item_bank_share_already_present" };
    }

    const written = await request(operation.method, path, body);
    const clearRefusal = Number.isInteger(written.status) && written.status >= 400 && written.status < 500 && written.status !== 408 && written.status !== 429;
    if (clearRefusal) return { matched: true, ok: false, sent: true, status: written.status, data: sanitize(written.data), apiHost, outcomeUnknown: false };

    const base = { schema: "morrow.browser-verification.v1", strategy: `item-bank-${operation.nickname}-readback` };
    const unconfirmed = (reason = "item_bank_readback_unavailable") => ({ ...base, status: "unconfirmed", reason });
    const mismatch = (reason) => ({ ...base, status: "mismatch", reason });
    const subset = (actual, expected) => {
      if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((value, index) => subset(actual[index], value));
      if (plain(expected)) return plain(actual) && Object.entries(expected).every(([key, value]) => subset(actual[key], value));
      return Object.is(actual, expected);
    };
    let verification;
    try {
      if (operation.nickname === "create_bank") {
        const created = plain(written.data?.bank) ? written.data.bank : written.data;
        // The only identity Morrow accepts for the bank it just created is an id
        // Canvas returned. A title and a language are a label a person chose, not
        // an identity: when this response carries no id, relisting the course and
        // taking the one new row that matches cannot say which row is Morrow's.
        // Another person creating the same title in the same course inside this
        // window, or the same person retrying in the Canvas UI after Morrow
        // appeared to fail, leaves a row Morrow did not create, and the readback
        // below would confirm its title, language and course association, all of
        // which match by construction, and report it verified with its id as the
        // target for every later operation. A create that cannot name its own
        // result says so instead of guessing. `create_item` answers the same
        // question the same way.
        const createdId = id(created?.id);
        const saved = createdId ? await readObject(`/api/banks/${createdId}`) : null;
        const associated = createdId ? await readList("/api/banks", { course_id: contextUuid }) : null;
        verification = !createdId ? unconfirmed("created_bank_id_not_returned")
          : !readableObject(saved) || !associated || associated.error ? unconfirmed()
          : String(saved.data.title) !== String(formValues.title) ? mismatch("created_bank_title_did_not_match")
            : String(saved.data.language) !== String(formValues.language || "en") ? mismatch("created_bank_language_did_not_match")
              : !associated.rows.some((row) => id(row?.id) === createdId) ? mismatch("created_bank_course_association_not_found")
                : { ...base, status: "verified", evidence: "created_bank_fields_and_selected_course_association_reread", targetId: createdId };
      } else if (operation.nickname === "rename_bank") {
        const saved = await readObject(path);
        verification = !readableObject(saved) ? unconfirmed()
          : String(saved.data.title) === String(formValues.title) ? { ...base, status: "verified", evidence: "renamed_bank_reread" }
            : mismatch("renamed_bank_title_did_not_match");
      } else if (operation.nickname === "archive_bank") {
        const saved = await readObject(path);
        const list = await readList("/api/banks", { course_id: contextUuid });
        verification = saved?.status === 404 && !list.error && !list.rows.some((row) => id(row?.id) === bankId)
          ? { ...base, status: "verified", evidence: "bank_absent_from_exact_read_and_course_bank_list" }
          : saved?.transport || list.error ? unconfirmed() : mismatch("bank_still_present_after_delete");
      } else if (operation.nickname === "create_item") {
        const created = plain(written.data?.item) ? written.data.item : written.data;
        const createdId = id(created?.id);
        const saved = createdId ? await readObject(`/api/banks/${bankId}/items/${createdId}`) : null;
        const expected = plain(body?.item) ? body.item : null;
        verification = !createdId || !readableObject(saved) ? unconfirmed()
          : expected && (subset(saved.data, expected) || subset(saved.data.item, expected))
            ? { ...base, status: "verified", evidence: "created_item_reread_by_returned_id", targetId: createdId }
            : mismatch("created_item_did_not_match_payload");
      } else if (operation.nickname === "update_item") {
        const saved = await readObject(path);
        const expected = plain(body?.item) ? body.item : null;
        verification = !readableObject(saved) ? unconfirmed()
          : expected && (subset(saved.data, expected) || subset(saved.data.item, expected))
            ? { ...base, status: "verified", evidence: "updated_item_reread" }
            : mismatch("updated_item_did_not_match_payload");
      } else if (operation.nickname === "attach_item") {
        const created = plain(written.data?.bank_entry) ? written.data.bank_entry : written.data;
        let createdId = id(created?.id);
        if (!createdId) {
          const listed = await readList(`/api/banks/${bankId}/bank_entries`);
          const beforeIds = new Set((before.entries || []).map((row) => id(row?.id)).filter(Boolean));
          const candidates = listed.error ? [] : listed.rows.filter((row) => !beforeIds.has(id(row?.id))
            && String(row?.entry_type) === "Item" && String(row?.entry_id) === String(formValues.item_id));
          if (candidates.length === 1) createdId = id(candidates[0]?.id);
        }
        const saved = createdId ? await readObject(`/api/banks/${bankId}/bank_entries/${createdId}`) : null;
        verification = !createdId || !readableObject(saved) ? unconfirmed()
          : String(saved.data.entry_type) === "Item" && String(saved.data.entry_id) === String(formValues.item_id)
            ? { ...base, status: "verified", evidence: "attached_entry_reread_by_returned_id", targetId: createdId }
            : mismatch("attached_entry_did_not_match_item");
      } else if (operation.nickname === "delete_entry") {
        const saved = await readObject(path);
        const list = await readList(`/api/banks/${bankId}/bank_entries`);
        verification = saved?.status === 404 && !list.error && !list.rows.some((row) => id(row?.id) === entryId)
          ? { ...base, status: "verified", evidence: "entry_absent_from_exact_read_and_bank_entry_list" }
          : saved?.transport || list.error ? unconfirmed() : mismatch("bank_entry_still_present_after_delete");
      } else if (operation.nickname === "share_bank") {
        const list = await readObservedList(`/api/banks/${bankId}/shared_banks`);
        verification = list.error ? unconfirmed()
          : list.rows.some((row) => shareEntityId(row) === String(formValues.entity_id)
            && shareEntityType(row) === "course" && String(row?.permission) === "read")
            ? { ...base, status: "verified", evidence: "exact_course_read_share_found" }
            : mismatch("course_read_share_not_found");
      } else {
        verification = unconfirmed("item_bank_readback_contract_missing");
      }
    } catch {
      verification = unconfirmed();
    }
    return {
      matched: true,
      ok: verification.status === "verified",
      sent: true,
      ...(Number.isInteger(written.status) ? { status: written.status } : {}),
      apiHost,
      outcomeUnknown: verification.status !== "verified",
      verification,
      ...(!written.ok && verification.status !== "verified" ? { error: written.oversize ? "item_bank_response_too_large" : "item_bank_request_failed" } : {}),
    };
  }
  if (guardedUpdate) {
    // Defensive validation for a legacy guarded accessibility repair. Current
    // generic updates carry the same observed reach acknowledgement at the top
    // level, while this older shape retains it inside the frozen guard.
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
      if (record.complete !== false || unreadSources(record).length === 0) return "authoritative_reach_claim_refused";
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
    const entryMatchesTarget = (entry, bankEntryId, bankId, itemId) => plain(entry)
      && String(entry.id ?? "") === bankEntryId
      && (entry.bank_id === undefined || String(entry.bank_id) === bankId)
      && entryLinksItem(entry, itemId);

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
    const associationRefusal = await verifyCourseAssociation();
    if (associationRefusal) return associationRefusal;
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
    // Every Item Bank read Morrow returns is sanitized, so the only digest a
    // reviewer can hold is the digest of the sanitized question. Compare that
    // same form here. The change Morrow sends is still the whole question
    // Canvas returned, with one image body replaced.
    if (await digest(stable(sanitize(current))) !== guard.item_sha256) return refuse("item_bank_source_changed");
    if (current.entry_type !== "Item" || String(current.id) !== guard.item_id
      || !plain(current.entry) || typeof current.entry.item_body !== "string") return refuse("item_bank_item_shape_unsupported");

    // Resolve the bank entry itself. A list row is not an item, so the entry is
    // read whole and must name this exact question.
    const readEntry = await request("GET", entryPath);
    if (!readable(readEntry)
      || !entryMatchesTarget(readEntry.data, guard.bank_entry_id, guard.bank_id, guard.item_id)) return refuse("item_bank_entry_unresolved");

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

    const proposedProtected = protectedState(sanitize(proposed));
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
      const savedProtected = protectedState(sanitize(saved));
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
      ok: verification.status === "verified",
      sent: true,
      status: written.status,
      apiHost,
      outcomeUnknown: verification.status !== "verified",
      verification,
    };
  }
  const pageParameter = operation.method === "GET" && ["list_banks", "list_entries"].includes(operation.nickname)
    ? operation.parameters.find((parameter) => parameter.inputName === "page")
    : null;
  // The pre-write snapshot reads every bank list with per_page=100. A read that
  // paged differently would cover a different set of rows at scale and its
  // snapshotSha256 could never match the digest the frame recomputes, so both
  // sides use one page size unless the caller names its own.
  const perPageParameter = pageParameter ? operation.parameters.find((parameter) => parameter.inputName === "per_page") : null;
  if (perPageParameter && !query.has(perPageParameter.wireName)) query.set(perPageParameter.wireName, "100");
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
  const safeCollection = sanitize(collection);
  const collectionRead = operation.method === "GET" && ["list_banks", "list_entries", "list_shares"].includes(operation.nickname);
  const sharePaginationUnestablished = operation.nickname === "list_shares";
  const dataTruncated = collectionRead && Array.isArray(collection) && collection.length > 10_000;
  const collectionShapeUnknown = collectionRead && pages.some((page) => !Array.isArray(page));
  return {
    matched: true,
    ok: true,
    sent: true,
    status,
    data: safeCollection,
    snapshotSha256: await digest(safeCollection),
    apiHost,
    outcomeUnknown: false,
    ...(collectionRead ? {
      ...(pageParameter ? { pageCount: pages.length } : {}),
      truncated: truncated || dataTruncated || collectionShapeUnknown || sharePaginationUnestablished,
      ...(sharePaginationUnestablished ? { paginationComplete: false, paginationUnestablished: true } : {}),
    } : operation.method === "GET" ? { truncated: false } : {}),
  };
}
