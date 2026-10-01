"""Moodle identity and course discovery in installed Chromium.

Authentication material stays inside an isolated execution world. This
transport has no write entrypoint. Governed operations are a separate layer.
"""
import json
import re
from urllib.parse import urlparse

from moodle.session import normalize_moodle_base, MoodleLaneError
from transport.local_chromium import LocalChromiumTransport, is_tenant_url


_BROWSER_READ = r"""(async () => {
  const input = %s;
  const fail = error => JSON.stringify({ok: false, error});
  const root = new URL(input.base + '/');
  if (location.origin !== root.origin ||
      !(location.pathname === root.pathname.slice(0, -1) || location.pathname.startsWith(root.pathname)))
    return fail('site_mismatch');
  const bounded = async response => {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > 2 * 1024 * 1024) throw new Error('response_incomplete');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  };
  const request = async (url, options = {}) => {
    const response = await fetch(url, {...options, credentials: 'same-origin',
      redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(25000)});
    if (response.type === 'opaqueredirect' || response.status >= 300 && response.status < 400)
      throw new Error('session_unavailable');
    if (response.status !== 200) throw new Error('provider_response_refused');
    return bounded(response);
  };
  try {
    const parseSession = doc => {
      const configurations = [];
      for (const script of doc.querySelectorAll('script:not([src])')) {
        const text = script.textContent || '';
        const assignments = text.matchAll(/\bM\.cfg\s*=\s*/g);
        for (const match of assignments) {
          const start = match.index + match[0].length;
          if (text[start] !== '{') throw new Error('configuration_invalid');
          let depth = 0, string = false, escaped = false, end = -1;
          for (let i = start; i < text.length; i++) {
            const c = text[i];
            if (string) {
              if (escaped) escaped = false;
              else if (c === '\\') escaped = true;
              else if (c === '"') string = false;
            } else if (c === '"') string = true;
            else if (c === '{' || c === '[') depth++;
            else if (c === '}' || c === ']') {
              depth--;
              if (depth === 0) { end = i + 1; break; }
            }
          }
          if (end < 0 || !/^\s*;/.test(text.slice(end))) throw new Error('configuration_invalid');
          configurations.push(JSON.parse(text.slice(start, end)));
        }
      }
      if (configurations.length !== 1) throw new Error('configuration_invalid');
      const cfg = configurations[0];
      if (!cfg || typeof cfg !== 'object' || typeof cfg.wwwroot !== 'string' ||
          cfg.wwwroot.replace(/\/$/, '') !== input.base) throw new Error('site_mismatch');
      let currentLogin = cfg.currentlogin;
      if (!Object.hasOwn(cfg, 'currentlogin')) {
        const logins = [];
        for (const script of doc.querySelectorAll('script:not([src])')) {
          for (const match of (script.textContent || '').matchAll(/require\s*\(\s*\[\s*['"]core\/storage_validation['"]\s*\]\s*,\s*function\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)\s*\{\s*\1\.init\s*\(\s*(null|[0-9]+)\s*\)\s*;/g))
            logins.push(match[2] === 'null' ? null : Number(match[2]));
        }
        if (logins.length !== 1) throw new Error('session_unavailable');
        currentLogin = logins[0];
      }
      if (!Number.isSafeInteger(currentLogin) || currentLogin < 1 ||
          typeof cfg.sesskey !== 'string' || !cfg.sesskey || cfg.sesskey.length > 512)
        throw new Error('session_unavailable');
      return {cfg, currentLogin};
    };
    const doc = new DOMParser().parseFromString(await request(root.href), 'text/html');
    const {cfg, currentLogin} = parseSession(doc);
    let userId = cfg.userId;
    if (!Object.hasOwn(cfg, 'userId')) {
      // Moodle 4.1 resolves a parameter-free profile to the signed-in user.
      const profile = new DOMParser().parseFromString(
        await request(input.base + '/user/profile.php'), 'text/html');
      if (profile.body.id !== 'page-user-profile') return fail('session_unavailable');
      const account = parseSession(profile);
      if (account.currentLogin !== currentLogin || account.cfg.sesskey !== cfg.sesskey)
        return fail('session_unavailable');
      userId = account.cfg.contextInstanceId;
      if (Object.hasOwn(account.cfg, 'userId') && account.cfg.userId !== userId)
        return fail('principal_mismatch');
    }
    if (!Number.isSafeInteger(userId) || userId < 1) return fail('session_unavailable');
    if (String(userId) !== input.principal_id) return fail('principal_mismatch');
    if (input.mode === 'identity') return JSON.stringify({ok: true,
      data: {id: String(userId), site_url: input.base}});
    const url = new URL(input.base + '/lib/ajax/service.php');
    url.searchParams.set('sesskey', cfg.sesskey);
    url.searchParams.set('info', 'core_course_get_enrolled_courses_by_timeline_classification');
    const body = [{index: 0, methodname: 'core_course_get_enrolled_courses_by_timeline_classification',
      args: {classification: 'allincludinghidden', limit: input.limit + 1, offset: input.offset,
        sort: null, customfieldname: null, customfieldvalue: null, searchvalue: null, requiredfields: []}}];
    const payload = JSON.parse(await request(url.href, {method: 'POST',
      headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}));
    if (!Array.isArray(payload) || payload.length !== 1 || payload[0]?.error !== false ||
        !Array.isArray(payload[0]?.data?.courses)) return fail('provider_response_refused');
    const rows = payload[0].data.courses;
    if (rows.length > input.limit + 1) return fail('provider_response_refused');
    const seen = new Set();
    const courses = [];
    for (const row of rows) {
      if (!Number.isSafeInteger(row?.id) || row.id < 1 || seen.has(row.id) ||
          typeof row.fullname !== 'string' || !row.fullname.trim() || row.fullname.length > 500)
        return fail('provider_response_refused');
      seen.add(row.id);
      if (courses.length < input.limit) courses.push({id: String(row.id), name: row.fullname});
    }
    const complete = rows.length <= input.limit;
    return JSON.stringify({ok: true, data: {courses, offset: input.offset, limit: input.limit,
      complete, next_offset: complete ? null : input.offset + courses.length}});
  } catch (error) {
    const known = ['response_incomplete', 'configuration_invalid', 'site_mismatch',
      'session_unavailable', 'provider_response_refused'];
    return fail(known.includes(error?.message) ? error.message : 'session_or_provider_unavailable');
  }
})()"""


class MoodleBrowserTransport(LocalChromiumTransport):
    def __init__(self, base_url, launcher, *, principal_id):
        base = normalize_moodle_base(base_url)
        if urlparse(base).scheme != "https" and urlparse(base).hostname not in ("127.0.0.1", "::1"):
            raise ValueError("Moodle browser access requires HTTPS")
        if not isinstance(principal_id, str) or not re.fullmatch(r"[1-9][0-9]*", principal_id):
            raise ValueError("Moodle browser access needs a pinned educator ID")
        if int(principal_id) > 9007199254740991:
            raise ValueError("Moodle educator ID exceeds the provider range")
        super().__init__(base, launcher)
        self.principal_id = principal_id

    def _tenant_tab_locked(self, fresh=False):
        prefix = urlparse(self.base).path.rstrip("/") + "/"
        if not fresh:
            for tab in self.cdp.tabs():
                url = tab.get("url", "")
                path = urlparse(url).path
                if (tab.get("type") == "page" and is_tenant_url(url, self.base)
                        and (path == prefix[:-1] or path.startswith(prefix))):
                    return tab
        return super()._tenant_tab_locked(fresh=True)

    def api(self, *args, **kwargs):
        raise MoodleLaneError("provider", "Use the Moodle provider operation layer")

    def ensure_session(self):
        return self.identity()

    def _read(self, mode, **params):
        tab = self._tenant_tab()
        context = self._new_api_world(tab)
        argument = {"mode": mode, "base": self.base, "principal_id": self.principal_id, **params}
        try:
            raw = self.cdp.evaluate(tab, _BROWSER_READ % json.dumps(argument),
                                    await_promise=True, timeout=60, context_id=context)
            response = json.loads(raw)
        except Exception:
            raise MoodleLaneError("network", "Moodle browser read did not complete") from None
        if not isinstance(response, dict) or response.get("ok") is not True:
            code = response.get("error") if isinstance(response, dict) else None
            kinds = {"principal_mismatch": "principal", "site_mismatch": "principal",
                     "session_unavailable": "reauth", "response_incomplete": "incomplete"}
            known = {"principal_mismatch", "site_mismatch", "session_unavailable", "response_incomplete",
                     "configuration_invalid", "provider_response_refused", "session_or_provider_unavailable"}
            raise MoodleLaneError(kinds.get(code, "provider"),
                                  "Moodle browser read refused (%s)" % (code if code in known else "invalid_result"))
        return response["data"]

    def identity(self):
        return self._read("identity")

    def courses_page(self, *, offset=0, limit=100):
        if (type(offset) is not int or offset < 0 or offset > 9007199254740991
                or type(limit) is not int or not 1 <= limit <= 100):
            raise ValueError("Moodle course page needs an offset >= 0 and a limit from 1 to 100")
        return self._read("courses", offset=offset, limit=limit)
