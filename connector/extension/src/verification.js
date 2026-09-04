const EXACT_READBACKS = Object.freeze({
  create_new_quiz: { read: "get_new_quiz", dynamic: { assignment_id: "id" }, targetField: "id", strategy: "created-resource" },
  update_single_quiz: { read: "get_new_quiz", strategy: "updated-resource" },
  delete_new_quiz: { read: "get_new_quiz", strategy: "deleted-resource" },
  create_quiz_item: { read: "get_quiz_item", dynamic: { item_id: "id" }, targetField: "id", strategy: "created-resource" },
  update_quiz_item: { read: "get_quiz_item", strategy: "updated-resource" },
  delete_quiz_item: { read: "get_quiz_item", strategy: "deleted-resource" },
  create_bank: { read: "get_bank", dynamic: { bank_id: "id" }, targetField: "id", strategy: "created-resource" },
  archive_bank: { read: "get_bank", strategy: "deleted-or-archived-resource" },
  attach_item: { read: "list_entries", targetArgument: "item_id", targetField: "entry_id", strategy: "collection-contains-target", ignoredAssertions: ["item_id"] },
  create_item: { read: "list_entries", targetResponse: "id", targetField: "entry_id", strategy: "collection-contains-target" },
  update_item: { read: "list_entries", targetArgument: "item_id", targetField: "entry_id", strategy: "collection-contains-target" },
  delete_entry: { read: "get_entry", strategy: "deleted-resource" },
  share_bank: { read: "list_shares", targetArgument: "entity_id", targetField: "entity_id", strategy: "collection-contains-target" },
});

function normalizedPath(value) {
  return String(value || "").replace(/\{[^}]+\}/g, "{}");
}

function wirePath(value) {
  return String(value || "").match(/[^\[\]]+/g) || [];
}

function normalizeKey(value) {
  return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function valueByKey(value, key, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = valueByKey(entry, key, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value !== "object") return undefined;
  const wanted = normalizeKey(key);
  for (const [name, child] of Object.entries(value)) {
    if (normalizeKey(name) === wanted && child !== undefined) return child;
  }
  for (const child of Object.values(value)) {
    const found = valueByKey(child, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function pathValue(value, path) {
  let current = value;
  for (const part of path) {
    if (!current || typeof current !== "object") return undefined;
    const match = Object.keys(current).find((key) => normalizeKey(key) === normalizeKey(part));
    if (!match) return undefined;
    current = current[match];
  }
  return current;
}

function pathCandidates(value, path, depth = 0, output = []) {
  if (depth > 12 || value === null || value === undefined) return output;
  const exact = pathValue(value, path);
  if (exact !== undefined) output.push(exact);
  if (Array.isArray(value)) {
    for (const entry of value) pathCandidates(entry, path, depth + 1, output);
  } else if (typeof value === "object") {
    for (const child of Object.values(value)) pathCandidates(child, path, depth + 1, output);
  }
  return output;
}

function equivalent(actual, expected) {
  if (Object.is(actual, expected)) return true;
  if (actual === null || expected === null || actual === undefined || expected === undefined) return false;
  if (Array.isArray(expected)) return Array.isArray(actual)
    && actual.length === expected.length
    && expected.every((entry, index) => equivalent(actual[index], entry));
  if (typeof expected === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
    return Object.entries(expected).every(([key, child]) => {
      const match = Object.keys(actual).find((candidate) => normalizeKey(candidate) === normalizeKey(key));
      return Boolean(match) && equivalent(actual[match], child);
    });
  }
  if (typeof actual === "number" || typeof expected === "number") return Number(actual) === Number(expected);
  if (typeof actual === "boolean" || typeof expected === "boolean") return String(actual) === String(expected);
  const left = String(actual);
  const right = String(expected);
  if (left === right) return true;
  const leftDate = Date.parse(left);
  const rightDate = Date.parse(right);
  return Number.isFinite(leftDate) && Number.isFinite(rightDate) && leftDate === rightDate;
}

function readArguments(read, writeArguments, dynamic = {}, writeData) {
  const output = {};
  for (const parameter of read.parameters || []) {
    if (parameter.location !== "path") continue;
    let value = writeArguments?.[parameter.inputName];
    const responseKey = dynamic?.[parameter.inputName];
    if (value === undefined && responseKey) value = valueByKey(writeData, responseKey);
    if (value === undefined && dynamic?.[parameter.wireName]) value = valueByKey(writeData, dynamic[parameter.wireName]);
    if (value === undefined && !Object.prototype.hasOwnProperty.call(writeArguments || {}, parameter.inputName)) {
      value = valueByKey(writeData, parameter.inputName) ?? valueByKey(writeData, "id");
    }
    if (value === undefined || value === null || value === "") return null;
    output[parameter.inputName] = String(value);
  }
  return output;
}

function exactRead(operations, write) {
  return operations.find((candidate) => candidate.readOnly && candidate.service === write.service && normalizedPath(candidate.path) === normalizedPath(write.path));
}

function childRead(operations, write) {
  const prefix = `${normalizedPath(write.path).replace(/\/$/, "")}/{}`;
  return operations.find((candidate) => candidate.readOnly && candidate.service === write.service && normalizedPath(candidate.path) === prefix);
}

function collectionRead(operations, write) {
  const segments = write.path.split("/").filter(Boolean);
  for (let count = segments.length; count >= 2; count -= 1) {
    const path = normalizedPath(`/${segments.slice(0, count).join("/")}`);
    const read = operations.find((candidate) => candidate.readOnly && candidate.service === write.service && normalizedPath(candidate.path) === path);
    if (read) return read;
  }
  return null;
}

function requestedAssertions(write, args, ignored = []) {
  return (write.parameters || []).flatMap((parameter) => {
    if (parameter.location === "path" || ignored.includes(parameter.inputName)) return [];
    const expected = args?.[parameter.inputName];
    if (expected === undefined) return [];
    const full = wirePath(parameter.wireName);
    const paths = full.length > 1 ? [full, full.slice(1)] : [full];
    return [{ inputName: parameter.inputName, paths, expected }];
  });
}

export function planBrowserReadback(operations, write, args, writeData) {
  if (!write || write.readOnly) return null;
  const override = EXACT_READBACKS[write.nickname];
  let read = override
    ? operations.find((candidate) => candidate.readOnly && candidate.service === write.service && candidate.nickname === override.read)
    : null;
  let strategy = override?.strategy;
  if (!read && write.method === "POST") {
    read = childRead(operations, write) || exactRead(operations, write) || collectionRead(operations, write);
    strategy = read && normalizedPath(read.path) === normalizedPath(write.path) ? "collection-contains-target" : "created-resource";
  }
  if (!read) {
    read = exactRead(operations, write) || collectionRead(operations, write);
    strategy = write.method === "DELETE"
      ? (read && normalizedPath(read.path) === normalizedPath(write.path) ? "deleted-resource" : "collection-omits-target")
      : "updated-resource";
  }
  if (!read) return null;
  const argumentsValue = readArguments(read, args, override?.dynamic || {}, writeData);
  if (!argumentsValue) return null;
  const targetId = override?.targetArgument
    ? args?.[override.targetArgument]
    : override?.targetResponse
      ? valueByKey(writeData, override.targetResponse)
      : write.method === "POST"
        ? valueByKey(writeData, "id")
        : undefined;
  const targetField = targetId === undefined || targetId === null ? undefined : override?.targetField || "id";
  return {
    schema: "morrow.browser-readback-plan.v1",
    strategy: strategy || "updated-resource",
    readOperation: read,
    arguments: argumentsValue,
    assertions: requestedAssertions(write, args, override?.ignoredAssertions || []),
    ...(targetId === undefined || targetId === null ? {} : { targetId: String(targetId) }),
    ...(targetField ? { targetField } : {}),
  };
}

function targetRecords(value, target, targetField, depth = 0, output = []) {
  if (depth > 12 || value === null || value === undefined) return output;
  if (Array.isArray(value)) {
    for (const entry of value) targetRecords(entry, target, targetField, depth + 1, output);
    return output;
  }
  if (typeof value !== "object") return output;
  if (String(pathValue(value, [targetField])) === String(target)) {
    output.push(value);
    return output;
  }
  for (const child of Object.values(value)) targetRecords(child, target, targetField, depth + 1, output);
  return output;
}

export function evaluateBrowserReadback(plan, readResult) {
  if (!plan || !readResult) return { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "readback_unavailable" };
  const absent = readResult.ok === false && [404, 410].includes(Number(readResult.status));
  if (["deleted-resource", "deleted-or-archived-resource"].includes(plan.strategy) && absent) {
    return { schema: "morrow.browser-verification.v1", status: "verified", strategy: plan.strategy, readTool: plan.readOperation.toolName, evidence: "fresh_readback_absent" };
  }
  if (readResult.ok !== true) {
    return { schema: "morrow.browser-verification.v1", status: "unconfirmed", strategy: plan.strategy, readTool: plan.readOperation.toolName, evidence: `fresh_readback_http_${Number(readResult.status || 0)}` };
  }
  if (plan.strategy === "deleted-or-archived-resource") {
    const archived = valueByKey(readResult.data, "archived") ?? valueByKey(readResult.data, "deleted");
    return archived === true
      ? { schema: "morrow.browser-verification.v1", status: "verified", strategy: plan.strategy, readTool: plan.readOperation.toolName, evidence: "fresh_readback_archived" }
      : { schema: "morrow.browser-verification.v1", status: "mismatch", strategy: plan.strategy, readTool: plan.readOperation.toolName, evidence: "resource_remains_active" };
  }
  if (!plan.targetId && (plan.assertions || []).length === 0) {
    return { schema: "morrow.browser-verification.v1", status: "unconfirmed", strategy: plan.strategy, readTool: plan.readOperation.toolName, evidence: "no_exact_postcondition" };
  }
  if (["collection-contains-target", "collection-omits-target"].includes(plan.strategy) && readResult.truncated === true) {
    return { schema: "morrow.browser-verification.v1", status: "unconfirmed", strategy: plan.strategy, readTool: plan.readOperation.toolName, evidence: "collection_readback_incomplete" };
  }
  if (["collection-contains-target", "collection-omits-target"].includes(plan.strategy) && !plan.targetId) {
    return { schema: "morrow.browser-verification.v1", status: "unconfirmed", strategy: plan.strategy, readTool: plan.readOperation.toolName, evidence: "collection_target_unresolved" };
  }
  if (plan.strategy === "collection-omits-target") {
    return targetRecords(readResult.data, plan.targetId, plan.targetField || "id").length === 0
      ? { schema: "morrow.browser-verification.v1", status: "verified", strategy: plan.strategy, readTool: plan.readOperation.toolName, evidence: "fresh_collection_omits_target" }
      : { schema: "morrow.browser-verification.v1", status: "mismatch", strategy: plan.strategy, readTool: plan.readOperation.toolName, evidence: "target_still_present" };
  }
  const records = plan.targetId ? targetRecords(readResult.data, plan.targetId, plan.targetField || "id") : [readResult.data];
  if (plan.targetId && records.length === 0) {
    return { schema: "morrow.browser-verification.v1", status: "mismatch", strategy: plan.strategy, readTool: plan.readOperation.toolName, evidence: "target_missing_from_readback" };
  }
  let missing = false;
  let mismatch = null;
  for (const record of records) {
    let matched = true;
    for (const assertion of plan.assertions || []) {
      const values = assertion.paths.flatMap((path) => pathCandidates(record, path));
      if (values.length === 0) {
        missing = true;
        matched = false;
        break;
      }
      if (!values.some((value) => equivalent(value, assertion.expected))) {
        mismatch = assertion.inputName;
        matched = false;
        break;
      }
    }
    if (matched) return { schema: "morrow.browser-verification.v1", status: "verified", strategy: plan.strategy, readTool: plan.readOperation.toolName, evidence: "fresh_readback_matches_requested_postcondition" };
  }
  if (missing) {
    return { schema: "morrow.browser-verification.v1", status: "unconfirmed", strategy: plan.strategy, readTool: plan.readOperation.toolName, evidence: "requested_fields_not_returned" };
  }
  return { schema: "morrow.browser-verification.v1", status: "mismatch", strategy: plan.strategy, readTool: plan.readOperation.toolName, evidence: `requested_field_mismatch:${mismatch || "unknown"}` };
}
