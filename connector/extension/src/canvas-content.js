(() => {
  if (globalThis.__morrowCanvasConnectorInstalled) return;
  globalThis.__morrowCanvasConnectorInstalled = true;

  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_PAGES = 50;

  async function readBounded(response) {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("canvas_response_too_large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  }

  function parsePayload(text, contentType) {
    if (!text) return null;
    if (/application\/(?:json|problem\+json)|text\/json/i.test(contentType || "")) {
      return JSON.parse(text);
    }
    return { text: text.slice(0, MAX_RESPONSE_BYTES) };
  }

  function nextLink(value, origin) {
    for (const part of String(value || "").split(",")) {
      const match = /^\s*<([^>]+)>;\s*rel="?next"?\s*$/i.exec(part);
      if (!match) continue;
      const url = new URL(match[1]);
      if (url.origin !== origin || !url.pathname.startsWith("/api/")) throw new Error("canvas_pagination_origin_refused");
      return url.href;
    }
    return null;
  }

  function appendValue(target, name, value) {
    if (Array.isArray(value)) {
      for (const entry of value) target.append(name, typeof entry === "object" ? JSON.stringify(entry) : String(entry));
      return;
    }
    target.append(name, typeof value === "object" ? JSON.stringify(value) : String(value));
  }

  function wirePath(name) {
    return String(name || "").match(/[^\[\]]+/g) || [];
  }

  function assignJsonValue(target, name, value) {
    const path = wirePath(name);
    if (path.length === 0) throw new TypeError("canvas_body_parameter_invalid");
    let current = target;
    for (let index = 0; index < path.length - 1; index += 1) {
      const part = path[index];
      if (!current[part] || typeof current[part] !== "object" || Array.isArray(current[part])) current[part] = {};
      current = current[part];
    }
    current[path[path.length - 1]] = value;
  }

  function usesJsonBody(operation) {
    return operation.family === "new-quizzes"
      && /\/quizzes\/\{assignment_id\}\/items(?:\/\{item_id\})?$/.test(operation.path)
      && ["POST", "PATCH"].includes(operation.method);
  }

  function decodeFile(value) {
    if (!value || typeof value !== "object" || typeof value.name !== "string" || typeof value.base64 !== "string") {
      throw new TypeError("file parameters require name and base64");
    }
    const binary = atob(value.base64);
    if (binary.length > 20 * 1024 * 1024) throw new RangeError("file parameter exceeds 20 MiB");
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new File([bytes], value.name, { type: typeof value.type === "string" ? value.type : "application/octet-stream" });
  }

  function requestParts(operation, args) {
    let path = operation.path;
    const query = new URLSearchParams();
    const body = [];
    for (const parameter of operation.parameters) {
      const value = args[parameter.inputName];
      if (value === undefined || value === null || value === "") {
        if (parameter.required) throw new TypeError(`${parameter.inputName} is required`);
        continue;
      }
      if (parameter.location === "path") {
        path = path.replace(`{${parameter.wireName}}`, encodeURIComponent(String(value)));
      } else if (parameter.location === "query") {
        appendValue(query, parameter.wireName, value);
      } else {
        body.push([parameter, value]);
      }
    }
    if (/\{[^}]+\}/.test(path) || path.includes("://") || path.split("/").includes("..")) {
      throw new TypeError("canvas_operation_path_refused");
    }
    const url = new URL(`/api${path}`, location.origin);
    for (const [name, value] of query) url.searchParams.append(name, value);
    return { url, body };
  }

  async function canvasProfile(includeCourseName = false) {
    const response = await fetch(new URL("/api/v1/users/self/profile", location.origin), {
      credentials: "include",
      headers: { Accept: "application/json+canvas-string-ids" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`canvas_profile_http_${response.status}`);
    const profile = JSON.parse(await readBounded(response));
    const id = String(profile?.id || "").trim();
    if (!/^[1-9][0-9]*$/.test(id)) throw new Error("canvas_profile_id_invalid");
    const courseId = location.pathname.match(/\/courses\/([1-9][0-9]*)(?:\/|$)/)?.[1] || null;
    let courseName;
    if (includeCourseName && courseId) {
      const courseResponse = await fetch(new URL(`/api/v1/courses/${courseId}`, location.origin), {
        credentials: "include",
        headers: { Accept: "application/json+canvas-string-ids" },
        cache: "no-store",
      });
      if (!courseResponse.ok) throw new Error("canvas_course_unavailable");
      const course = JSON.parse(await readBounded(courseResponse));
      if (String(course?.id) !== courseId) throw new Error("canvas_course_mismatch");
      courseName = String(course.name || "").trim().slice(0, 300);
    }
    return { id, name: String(profile?.name || profile?.short_name || "Canvas user").slice(0, 200), origin: location.origin, courseId, ...(courseName ? { courseName } : {}) };
  }

  async function executeCanvas(operation, args, expectedPrincipalId) {
    const profile = await canvasProfile();
    if (profile.id !== expectedPrincipalId) throw new Error("canvas_principal_changed");
    const { url, body } = requestParts(operation, args);
    const isRead = operation.method === "GET";
    const headers = new Headers({ Accept: "application/json+canvas-string-ids" });
    const options = { method: operation.method, credentials: "include", headers, cache: "no-store" };
    if (!isRead) {
      const csrf = document.querySelector('meta[name="csrf-token"]')?.content || "";
      if (!csrf) throw new Error("canvas_csrf_context_missing");
      headers.set("X-CSRF-Token", csrf);
      headers.set("X-Requested-With", "XMLHttpRequest");
      const containsFile = body.some(([parameter]) => String(parameter.schema?.format || "") === "binary");
      if (containsFile) {
        const form = new FormData();
        for (const [parameter, value] of body) {
          if (String(parameter.schema?.format || "") === "binary") form.append(parameter.wireName, decodeFile(value));
          else appendValue(form, parameter.wireName, value);
        }
        options.body = form;
      } else if (body.length > 0 && usesJsonBody(operation)) {
        const json = {};
        for (const [parameter, value] of body) assignJsonValue(json, parameter.wireName, value);
        headers.set("Content-Type", "application/json;charset=UTF-8");
        options.body = JSON.stringify(json);
      } else if (body.length > 0) {
        const encoded = new URLSearchParams();
        for (const [parameter, value] of body) appendValue(encoded, parameter.wireName, value);
        headers.set("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8");
        options.body = encoded.toString();
      }
    }
    const maxPages = Math.max(1, Math.min(Number(args.morrow_max_pages || 25), MAX_PAGES));
    const pages = [];
    let next = url.href;
    let lastResponse = null;
    for (let page = 0; next && page < maxPages; page += 1) {
      let response;
      let payload;
      try {
        for (let attempt = 0; attempt < (isRead ? 3 : 1); attempt += 1) {
          response = await fetch(next, options);
          if (response.status !== 429 || !isRead || attempt === 2) break;
          const seconds = Math.min(30, Math.max(1, Number(response.headers.get("Retry-After") || 1)));
          await new Promise((resolve) => setTimeout(resolve, seconds * 1_000));
        }
        payload = parsePayload(await readBounded(response), response.headers.get("Content-Type"));
      } catch {
        return { ok: false, sent: true, outcomeUnknown: !isRead, error: isRead ? "canvas_read_failed" : "canvas_write_response_unknown" };
      }
      lastResponse = response;
      if (!response.ok) {
        return { ok: false, sent: true, status: response.status, error: payload, requestUrl: url.pathname };
      }
      pages.push(payload);
      next = isRead ? nextLink(response.headers.get("Link"), location.origin) : null;
    }
    return {
      ok: true,
      sent: true,
      status: lastResponse?.status || 0,
      data: pages.length === 1 ? pages[0] : pages.flatMap((page) => Array.isArray(page) ? page : [page]),
      pageCount: pages.length,
      truncated: Boolean(next),
      requestCost: lastResponse?.headers.get("X-Request-Cost") || null,
      rateLimitRemaining: lastResponse?.headers.get("X-Rate-Limit-Remaining") || null,
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "morrow_canvas_probe") {
      canvasProfile(true).then((profile) => sendResponse({ ok: true, profile }), (error) => sendResponse({ ok: false, error: String(error?.message || error) }));
      return true;
    }
    if (message?.type === "morrow_canvas_execute") {
      executeCanvas(message.operation, message.arguments || {}, message.principalId)
        .then((result) => sendResponse(result), (error) => sendResponse({ ok: false, sent: false, error: String(error?.message || error) }));
      return true;
    }
    return false;
  });
})();
