export async function executeQuizBankDrawInPage(input) {
  const MAX_BYTES = 2 * 1024 * 1024;
  const MAX_ENTRY_PAGES = 1000;
  const MAX_ENTRIES = 10_000;
  const id = (value) => /^[1-9][0-9]{0,18}$/.test(String(value || "")) ? String(value) : "";
  const plain = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const ltiHost = /^[^.]+\.quiz-lti(?:-[^.]+)*\.instructure\.com$/i;
  const apiHostPattern = /^[^.]+\.quiz-api(?:-[^.]+)*\.instructure\.com$/i;
  const currentHost = String(location.hostname || "").toLowerCase();
  if (!ltiHost.test(currentHost)) return { matched: false };
  let canvas;
  let referrer;
  try {
    canvas = new URL(input.canvasOrigin);
    referrer = new URL(document.referrer || "");
  } catch {
    return { matched: false };
  }
  const courseId = id(input.courseId);
  const assignmentId = id(input.assignmentId);
  const referrerMatch = referrer.pathname.match(/^\/courses\/([1-9][0-9]{0,18})\/assignments\/([1-9][0-9]{0,18})\/?$/);
  const tenant = canvas.hostname.match(/^([^.]+)(?:\.(?:beta|test))?\.instructure\.com$/i)?.[1]?.toLowerCase();
  if (canvas.protocol !== "https:" || canvas.origin !== input.canvasOrigin || referrer.origin !== canvas.origin
    || !courseId || !assignmentId || referrerMatch?.[1] !== courseId || referrerMatch?.[2] !== assignmentId
    || !tenant || currentHost.split(".")[0] !== tenant) return { matched: false };
  const operation = input.operation;
  const contracts = {
    list_quiz_draws: ["GET", "/api/quizzes/{builder_quiz_id}/quiz_entries"],
    attach_bank_to_quiz: ["POST", "/api/quizzes/{builder_quiz_id}/quiz_entries"],
    attach_bank_entry_to_quiz: ["POST", "/api/quizzes/{builder_quiz_id}/quiz_entries"],
    delete_quiz_bank_entry: ["DELETE", "/api/quizzes/{builder_quiz_id}/quiz_entries/{quiz_entry_id}"],
  };
  const contract = contracts[operation?.nickname];
  if (!contract || operation.service !== "item_bank" || operation.method !== contract[0] || operation.path !== contract[1]) {
    return { matched: true, ok: false, sent: false, error: "quiz_bank_operation_contract_mismatch" };
  }
  if (id(input.arguments?.course_id) !== courseId || id(input.arguments?.assignment_id) !== assignmentId) {
    return { matched: true, ok: false, sent: false, error: "quiz_bank_course_assignment_mismatch" };
  }
  const backend = String(localStorage.getItem("backend_url") || "").replace(/\/$/, "");
  const token = String(localStorage.getItem("quiz.build_token") || sessionStorage.getItem("quiz.build_token") || "");
  let backendUrl;
  try { backendUrl = new URL(backend); } catch { backendUrl = null; }
  const apiHost = currentHost.replace(".quiz-lti", ".quiz-api");
  if (!backendUrl || backendUrl.protocol !== "https:" || backendUrl.hostname.toLowerCase() !== currentHost
    || !apiHostPattern.test(apiHost) || token.length < 51 || token.length > 8192) {
    return { matched: true, ok: false, sent: false, error: "quiz_bank_builder_credential_unavailable" };
  }
  const resources = performance.getEntriesByType("resource").map((entry) => String(entry?.name || ""));
  const quizIds = [...new Set(resources.flatMap((url) => {
    const match = url.match(/\/api\/quizzes\/([1-9][0-9]{0,18})(?:[/?#]|$)/);
    return match ? [match[1]] : [];
  }))];
  if (quizIds.length !== 1) return { matched: true, ok: false, sent: false, error: "quiz_bank_builder_context_ambiguous" };
  const quizId = quizIds[0];
  const headers = { Accept: "application/json", Authorization: token, AuthType: "Signature" };
  const boundedResponse = async (response) => {
    const declared = response?.headers?.get?.("content-length");
    if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_BYTES)) return { oversize: true };
    if (!response?.body || typeof response.body.getReader !== "function") return { text: "" };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let size = 0;
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
  const request = async (method, path, body) => {
    let response;
    try {
      response = await fetch(`https://${apiHost}${path}`, {
        method,
        headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
        credentials: "omit",
        redirect: "error",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      return { transport: true };
    }
    const read = await boundedResponse(response);
    if (read.oversize) return { oversize: true, status: response.status };
    if (read.unreadable) return { transport: true, status: response.status };
    let data = null;
    let parsed = true;
    try { data = read.text ? JSON.parse(read.text) : null; } catch { data = read.text; parsed = false; }
    return { ok: response.ok, status: response.status, data, parsed };
  };
  const stable = (value) => Array.isArray(value)
    ? `[${value.map(stable).join(",")}]`
    : plain(value)
      ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
      : JSON.stringify(value === undefined ? null : value);
  const digest = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)))), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const sanitize = (value, depth = 0) => {
    if (depth > 24) return null;
    if (Array.isArray(value)) return value.slice(0, 10_000).map((entry) => sanitize(entry, depth + 1));
    if (!plain(value)) return typeof value === "string" ? value.split(token).join("[redacted]") : value;
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      if (/(?:authorization|bearer|token|secret|credential|cookie|csrf)/i.test(key)) continue;
      result[key] = sanitize(child, depth + 1);
    }
    return result;
  };
  const quiz = await request("GET", `/api/quizzes/${encodeURIComponent(quizId)}`);
  if (!quiz.ok || quiz.parsed !== true || !plain(quiz.data) || id(quiz.data.id ?? quiz.data.quiz_id) !== quizId) {
    return { matched: true, ok: false, sent: false, error: "quiz_bank_builder_quiz_unverified" };
  }
  if (input.contextOnly === true) return { matched: true, ok: true, sent: false };
  const readEntries = async () => {
    const rows = [];
    for (let page = 1; page <= MAX_ENTRY_PAGES; page += 1) {
      const result = await request("GET", `/api/quizzes/${encodeURIComponent(quizId)}/quiz_entries?page=${page}`);
      if (!result.ok || result.parsed !== true) return { error: result };
      const pageRows = Array.isArray(result.data) ? result.data : result.data?.quiz_entries;
      if (!Array.isArray(pageRows) || !pageRows.every(plain)) return { error: result };
      if (pageRows.length === 0) return { rows, pagesRead: page, paginationComplete: true };
      if (rows.length + pageRows.length > MAX_ENTRIES) return { error: { paginationLimit: true } };
      rows.push(...pageRows);
    }
    return { error: { paginationLimit: true } };
  };
  const before = await readEntries();
  if (before.error) return { matched: true, ok: false, sent: false, error: "quiz_bank_entries_unreadable" };
  const safeBefore = sanitize(before.rows);
  const beforeSha256 = await digest(safeBefore);
  if (operation.nickname === "list_quiz_draws") {
    return {
      matched: true, ok: true, sent: true, status: 200, outcomeUnknown: false,
      data: safeBefore, snapshotSha256: beforeSha256, quizId,
      pagesRead: before.pagesRead, paginationComplete: true,
    };
  }
  const snapshot = input.arguments?.expected_snapshot;
  const snapshotKeys = Object.keys(plain(snapshot) ? snapshot : {}).sort();
  const hex = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
  const bankId = id(input.arguments?.bank_id);
  if (!bankId) return { matched: true, ok: false, sent: false, error: "bank_id is required" };

  const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  const compareIds = (left, right) => left.length === right.length ? compareText(left, right) : left.length - right.length;
  const validObservedFanOut = async (record, acknowledged) => {
    if (!plain(record)) return "missing_record";
    if (record.schema !== "morrow.canvas.item-bank.fan-out.v1") return "wrong_schema";
    if (String(record.bank_id || "") !== bankId) return "bank_mismatch";
    if (String(record.course_id || "") !== courseId) return "course_mismatch";
    // The same unread-source rule as item-bank-executor.js: a source that is
    // missing, unfinished, or named unreachable was not walked to its end.
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
    if (!hex(record.consumers_sha256) || record.consumers_sha256 !== await digest(consumers)) return "consumers_digest_mismatch";
    const established = Date.parse(String(record.established_at || ""));
    if (!/(?:Z|[+-][0-9]{2}:?[0-9]{2})$/i.test(String(record.established_at || "")) || !Number.isFinite(established)) return "established_at_unreadable";
    if (established > Date.now()) return "record_from_future";
    if (Date.now() - established > 60 * 60 * 1_000) return "record_too_old";
    const external = [...new Set(consumers.map((value) => value.course_id))].filter((value) => value !== courseId).sort(compareIds);
    if (!Array.isArray(record.external_course_ids) || stable(record.external_course_ids) !== stable(external)) return "external_course_ids_mismatch";
    if (!Array.isArray(acknowledged) || !acknowledged.every((value) => /^[1-9][0-9]*$/.test(String(value)))
      || stable(acknowledged.map(String).sort(compareIds)) !== stable(external)) return "acknowledgement_mismatch";
    return null;
  };
  const fanOutReason = await validObservedFanOut(input.arguments?.fan_out, input.arguments?.acknowledged_course_ids);
  if (fanOutReason) return { matched: true, ok: false, sent: false, error: `item_bank_fan_out_${fanOutReason}` };

  const rowId = (row) => id(row?.id ?? row?.quiz_entry?.id);
  const normalized = (row) => plain(row?.quiz_entry) ? row.quiz_entry : row;
  const entryType = (row) => String(normalized(row)?.entry_type || "").replaceAll(/[_ -]/g, "").toLowerCase();
  const requiredSnapshotKeys = operation.nickname === "attach_bank_entry_to_quiz"
    ? ["bank_sha256", "entry_sha256", "quiz_entries_sha256"]
    : operation.nickname === "delete_quiz_bank_entry"
      ? ["bank_sha256", "quiz_entries_sha256", "quiz_entry_sha256", ...(id(input.arguments?.bank_entry_id) ? ["entry_sha256"] : [])]
    : ["bank_sha256", "quiz_entries_sha256"];
  if (!plain(snapshot) || stable(snapshotKeys) !== stable([...requiredSnapshotKeys].sort())
    || requiredSnapshotKeys.some((key) => !hex(snapshot[key]))
    || snapshot.bank_sha256 !== input.verifiedBankSha256
    || snapshot.quiz_entries_sha256 !== beforeSha256
    || (["attach_bank_entry_to_quiz", "delete_quiz_bank_entry"].includes(operation.nickname)
      && id(input.arguments?.bank_entry_id) && snapshot.entry_sha256 !== input.verifiedEntrySha256)) {
    return { matched: true, ok: false, sent: false, error: "quiz_bank_snapshot_invalid" };
  }

  const base = { schema: "morrow.browser-verification.v1", strategy: `quiz-bank-${operation.nickname}-readback` };
  if (operation.nickname === "delete_quiz_bank_entry") {
    const quizEntryId = id(input.arguments?.quiz_entry_id);
    const target = before.rows.find((row) => rowId(row) === quizEntryId);
    if (!quizEntryId || !target) return { matched: true, ok: false, sent: false, error: "quiz_bank_entry_unresolved" };
    const value = normalized(target);
    const kind = entryType(target);
    if (["bank", "itembank"].includes(kind)) {
      if (id(value?.entry_id) !== bankId) return { matched: true, ok: false, sent: false, error: "quiz_bank_entry_bank_mismatch" };
    } else if (kind === "bankentry") {
      const bankEntryId = id(input.arguments?.bank_entry_id);
      if (!bankEntryId || id(value?.entry_id) !== bankEntryId || snapshot.entry_sha256 !== input.verifiedEntrySha256) {
        return { matched: true, ok: false, sent: false, error: "quiz_bank_entry_bank_mismatch" };
      }
    } else return { matched: true, ok: false, sent: false, error: "quiz_bank_entry_type_unsupported" };
    if (snapshot.quiz_entry_sha256 !== await digest(sanitize(target))) return { matched: true, ok: false, sent: false, error: "quiz_bank_snapshot_invalid" };
    const written = await request("DELETE", `/api/quizzes/${encodeURIComponent(quizId)}/quiz_entries/${encodeURIComponent(quizEntryId)}`);
    const clearRefusal = Number.isInteger(written.status) && written.status >= 400 && written.status < 500 && written.status !== 408 && written.status !== 429;
    if (clearRefusal) return { matched: true, ok: false, sent: true, status: written.status, outcomeUnknown: false };
    const after = await readEntries();
    const verification = after.error
      ? { ...base, status: "unconfirmed", reason: "quiz_bank_readback_unavailable" }
      : !after.rows.some((row) => rowId(row) === quizEntryId)
        ? { ...base, status: "verified", evidence: "exact_quiz_bank_entry_absent_from_complete_entry_list", targetId: quizEntryId }
        : { ...base, status: "mismatch", reason: "quiz_bank_entry_still_present" };
    return { matched: true, ok: verification.status === "verified", sent: true,
      ...(Number.isInteger(written.status) ? { status: written.status } : {}),
      outcomeUnknown: verification.status !== "verified", verification };
  }
  const points = Number(input.arguments?.points_per_item);
  const position = Number(input.arguments?.position);
  if (!Number.isFinite(points) || points <= 0 || !Number.isInteger(position) || position < 1) {
    return { matched: true, ok: false, sent: false, error: "quiz_bank_payload_invalid" };
  }
  let matches;
  let payload;
  if (operation.nickname === "attach_bank_to_quiz") {
    // ItemProperties.sample_num is "the number of items to randomly select from the bank. null if
    // all items should be included" in the New Quiz Items contract, so an absent pick count is the
    // documented all-items draw and the readback requires that exact saved null.
    // https://developerdocs.instructure.com/services/canvas/resources/new_quiz_items
    const allItems = input.arguments?.pick_count === undefined || input.arguments?.pick_count === null;
    const pickCount = allItems ? null : Number(input.arguments.pick_count);
    if (!allItems && (!Number.isInteger(pickCount) || pickCount < 1)) return { matched: true, ok: false, sent: false, error: "quiz_bank_payload_invalid" };
    matches = (row) => {
      const value = normalized(row);
      const properties = plain(value?.properties) ? value.properties : {};
      const sample = allItems
        ? Object.hasOwn(properties, "sample_num") && properties.sample_num === null
        : Number(properties.sample_num) === pickCount;
      return ["bank", "itembank"].includes(entryType(row)) && id(value?.entry_id) === bankId
        && sample && Number(value?.points_possible) === points && Number(value?.position) === position;
    };
    payload = { quiz_entry: { entry_type: "Bank", entry_id: bankId, position, points_possible: points, properties: { sample_num: pickCount } } };
  } else {
    const bankEntryId = id(input.arguments?.bank_entry_id);
    if (!bankEntryId) return { matched: true, ok: false, sent: false, error: "quiz_bank_payload_invalid" };
    matches = (row) => {
      const value = normalized(row);
      return entryType(row) === "bankentry" && id(value?.entry_id) === bankEntryId
        && Number(value?.points_possible) === points && Number(value?.position) === position;
    };
    payload = { quiz_entry: { entry_type: "BankEntry", entry_id: bankEntryId, position, points_possible: points } };
  }
  const existing = before.rows.filter(matches);
  if (existing.length === 1) {
    return {
      matched: true, ok: true, sent: false, status: 200, outcomeUnknown: false,
      verification: { ...base, status: "verified", evidence: "exact_quiz_bank_entry_already_present", targetId: rowId(existing[0]) || undefined },
    };
  }
  if (existing.length > 1) return { matched: true, ok: false, sent: false, error: "quiz_bank_existing_entry_ambiguous" };
  const written = await request("POST", `/api/quizzes/${encodeURIComponent(quizId)}/quiz_entries`, payload);
  const clearRefusal = Number.isInteger(written.status) && written.status >= 400 && written.status < 500 && written.status !== 408 && written.status !== 429;
  if (clearRefusal) return { matched: true, ok: false, sent: true, status: written.status, outcomeUnknown: false };
  const after = await readEntries();
  if (after.error) {
    return {
      matched: true, ok: false, sent: true, ...(Number.isInteger(written.status) ? { status: written.status } : {}), outcomeUnknown: true,
      verification: { ...base, status: "unconfirmed", reason: "quiz_bank_readback_unavailable" },
    };
  }
  const beforeIds = new Set(before.rows.map(rowId).filter(Boolean));
  const beforeDigests = new Set(await Promise.all(before.rows.map((row) => digest(sanitize(row)))));
  const candidates = [];
  for (const row of after.rows) {
    if (!matches(row)) continue;
    const identity = rowId(row);
    if ((identity && beforeIds.has(identity)) || (!identity && beforeDigests.has(await digest(sanitize(row))))) continue;
    candidates.push(row);
  }
  const verification = candidates.length === 1
    ? { ...base, status: "verified", evidence: "new_exact_quiz_bank_entry_found_in_complete_entry_list", targetId: rowId(candidates[0]) || undefined }
    : candidates.length === 0
      ? { ...base, status: written.ok ? "mismatch" : "unconfirmed", reason: "quiz_bank_entry_not_found" }
      : { ...base, status: "mismatch", reason: "quiz_bank_entry_readback_ambiguous" };
  return {
    matched: true,
    ok: verification.status === "verified",
    sent: true,
    ...(Number.isInteger(written.status) ? { status: written.status } : {}),
    outcomeUnknown: verification.status !== "verified",
    verification,
  };
}
