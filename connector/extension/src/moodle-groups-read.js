/**
 * Reads one exact course's group map through its core group list and native
 * management member read endpoint. Session material and raw identities stay in Chrome.
 */
export async function executeMoodleCourseGroupsInPage(rawInput) {
  const PROVIDER = "moodle";
  const OPERATION = "moodle.page.group.membership_map.read.v1";
  const MAX_BYTES = 2_000_000;
  const MAX_GROUPS = 500;
  const MAX_MEMBERS = 10_000;
  const ID = /^[1-9][0-9]{0,18}$/;
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const id = (value) => {
    const raw = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
    return ID.test(raw) ? raw : "";
  };
  const text = (value, max = 1000) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
  const fail = (error, status) => ({ ok: false, sent: false, ...(Number.isInteger(status) ? { status } : {}), error });
  const incomplete = () => ({ ok: false, sent: false, complete: false, error: "moodle_course_groups_incomplete" });
  const input = (() => { try { return typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput; } catch { return null; } })();
  const cfg = globalThis.M?.cfg;
  if (!object(input) || !object(cfg) || typeof cfg.wwwroot !== "string" || !text(cfg.sesskey, 1024)) return fail("moodle_groups_context_invalid");
  let site;
  try { site = new URL(cfg.wwwroot); } catch { return fail("moodle_groups_context_invalid"); }
  const basePath = site.pathname.replace(/\/$/, "");
  const bodyCourse = String(globalThis.document?.body?.className || "").match(/(?:^|\s)course-([1-9][0-9]*)(?:\s|$)/)?.[1] || "";
  const courseId = id(cfg.courseId) || bodyCourse;
  const principalId = id(cfg.userId);
  const currentPath = String(globalThis.location?.pathname || "");
  if (site.protocol !== "https:" || site.search || site.hash || site.username || site.password || site.origin !== globalThis.location?.origin
    || !(currentPath === basePath || currentPath.startsWith(`${basePath}/`)) || !courseId || !principalId) return fail("moodle_groups_context_invalid");
  const operation = input.operation; const args = input.arguments; const binding = input.binding;
  if (!object(operation) || operation.key !== OPERATION || operation.toolName !== "moodle_get_course_groups" || operation.provider !== PROVIDER || operation.readOnly !== true
    || !object(args) || Object.keys(args).length !== 1 || id(args.course_id) !== courseId || !object(binding)
    || binding.origin !== site.origin || binding.siteUrl !== site.href || id(binding.principalId) !== principalId || id(binding.courseId) !== courseId
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) return fail("moodle_arguments_invalid");
  const sameContext = () => globalThis.M?.cfg?.sesskey === cfg.sesskey && id(globalThis.M?.cfg?.userId) === principalId
    && (id(globalThis.M?.cfg?.courseId) || bodyCourse) === courseId;
  const approved = () => Date.now() <= input.expiresAt && sameContext();
  const boundedText = async (response, endpoint) => {
    let responseUrl;
    try { responseUrl = new URL(response.url); } catch { return null; }
    if (!response.ok || responseUrl.origin !== endpoint.origin || responseUrl.pathname !== endpoint.pathname || responseUrl.search !== endpoint.search
      || !sameContext() || !response.body || typeof response.body.getReader !== "function" || typeof globalThis.TextDecoder !== "function") return null;
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let bytes = 0; let raw = "";
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (!(next.value instanceof Uint8Array) || (bytes += next.value.byteLength) > MAX_BYTES) { await reader.cancel(); return "limit"; }
        raw += decoder.decode(next.value, { stream: true });
      }
      raw += decoder.decode();
      return raw;
    } catch { try { await reader.cancel(); } catch {} return null; }
  };
  const ajax = async (methodname, methodArgs) => {
    const endpoint = new URL(site.href); endpoint.pathname = `${basePath}/lib/ajax/service.php`;
    endpoint.search = new URLSearchParams({ sesskey: cfg.sesskey, info: methodname }).toString();
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "error",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify([{ index: 0, methodname, args: methodArgs }]),
      });
    } catch { return null; }
    const raw = await boundedText(response, endpoint);
    if (raw === "limit") return raw;
    try {
      const payload = JSON.parse(raw);
      return Array.isArray(payload) && payload.length === 1 && !object(payload[0]?.error) && typeof payload[0]?.data === "string" ? JSON.parse(payload[0].data) : null;
    } catch { return null; }
  };
  const members = async (groupId) => {
    const endpoint = new URL(site.href); endpoint.pathname = `${basePath}/group/index.php`;
    endpoint.search = new URLSearchParams({ id: courseId, group: groupId, action: "ajax_getmembersingroup" }).toString();
    let response;
    try { response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "application/json" } }); } catch { return null; }
    const raw = await boundedText(response, endpoint);
    if (raw === "limit") return raw;
    try { return JSON.parse(raw); } catch { return null; }
  };
  const rawGroups = await ajax("core_group_get_course_groups", { courseid: Number(courseId) });
  if (rawGroups === "limit") return incomplete();
  if (!Array.isArray(rawGroups)) return fail("moodle_course_groups_unavailable");
  if (rawGroups.length > MAX_GROUPS) return incomplete();
  const groups = []; const groupIds = new Set();
  for (const raw of rawGroups) {
    const groupId = id(raw?.id); const groupCourse = id(raw?.courseid); const name = raw?.name;
    const visibility = raw?.visibility; const participation = raw?.participation;
    if (!groupId || groupCourse !== courseId || !text(name, 500) || !Number.isSafeInteger(visibility) || visibility < 0 || visibility > 3
      || typeof participation !== "boolean" || groupIds.has(groupId)) return fail("moodle_course_groups_invalid");
    groupIds.add(groupId); groups.push({ id: groupId, name, visibility, participation });
  }
  let memberCount = 0;
  for (const group of groups) {
    if (!approved()) return fail("moodle_groups_context_changed");
    const rawRoles = await members(group.id);
    if (rawRoles === "limit") return incomplete();
    if (!Array.isArray(rawRoles)) return fail("moodle_course_groups_invalid");
    const membership = []; const memberIds = new Set();
    for (const rawRole of rawRoles) {
      if (!object(rawRole) || !Array.isArray(rawRole.users)) return fail("moodle_course_groups_invalid");
      for (const rawMember of rawRole.users) {
        const userId = id(rawMember?.id); const name = rawMember?.name;
        if (!userId || !text(name, 2000) || memberIds.has(userId)) return fail("moodle_course_groups_invalid");
        memberIds.add(userId); membership.push({ user_id: userId, name });
        if (++memberCount > MAX_MEMBERS) return incomplete();
      }
    }
    group.membership = membership;
  }
  if (!approved()) return fail("moodle_groups_context_changed");
  return { ok: true, sent: false, complete: true, data: { course_id: courseId, groups } };
}
