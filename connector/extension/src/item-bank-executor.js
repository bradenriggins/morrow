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
  let path = operation.path;
  const query = new URLSearchParams();
  const formValues = {};
  for (const parameter of operation.parameters) {
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
  if (query.size) path += `${path.includes("?") ? "&" : "?"}${query}`;
  let body;
  if (operation.nickname === "create_bank") body = { bank: { title: String(formValues.title), language: "en" } };
  else if (operation.nickname === "attach_item") body = { bank_entry: { bank_id: String(input.arguments.bank_id), entry_type: "Item", entry_id: String(formValues.item_id) } };
  else if (operation.nickname === "share_bank") body = { shared_bank: { entity_id: String(formValues.entity_id), entityType: String(formValues.entity_type), bank_id: String(input.arguments.bank_id), permission: "read" } };
  else if (operation.nickname === "create_item" || operation.nickname === "update_item") body = formValues.item;
  else if (Object.keys(formValues).length) body = formValues;
  const headers = { Accept: "application/json", Authorization: token, AuthType: "Signature" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(`https://${apiHost}${path}`, {
      method: operation.method,
      headers,
      credentials: "omit",
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    return { matched: true, ok: false, sent: operation.method !== "GET", outcomeUnknown: operation.method !== "GET", error: "item_bank_request_failed" };
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BYTES) return { matched: true, ok: false, sent: true, outcomeUnknown: operation.method !== "GET", error: "item_bank_response_too_large" };
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text.slice(0, MAX_BYTES); }
  const sanitize = (value, depth = 0) => {
    if (depth > 24) return null;
    if (Array.isArray(value)) return value.slice(0, 10_000).map((entry) => sanitize(entry, depth + 1));
    if (!value || typeof value !== "object") return typeof value === "string" ? value.split(token).join("[redacted]") : value;
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      if (/(?:authorization|bearer|token|secret|credential|cookie|csrf)/i.test(key)) continue;
      output[key] = sanitize(child, depth + 1);
    }
    return output;
  };
  return { matched: true, ok: response.ok, sent: true, status: response.status, data: sanitize(data), apiHost, outcomeUnknown: false };
}
