export const MAX_CANVAS_FILE_TRANSFER_BYTES = 1024 * 1024;

export const CANVAS_UPLOAD_PATH = /^\/api\/v1(?:\/[a-z_]+(?:\/(?:[1-9][0-9]*|self))?)+$/;

/** The Canvas folder a folder upload names, or "" for an upload to any other target. */
export function canvasUploadFolderId(uploadPath) {
  return /^\/api\/v1\/folders\/([1-9][0-9]*)\/files$/.exec(String(uploadPath || ""))?.[1] || "";
}

/**
 * This function is intentionally self-contained. Chrome serializes only the
 * supplied function body for a MAIN-world injection.
 */
export async function executeCanvasCourseFileTransferInPage(input) {
  const requestSignal = (expiresAt) => {
    const remaining = Number.isSafeInteger(expiresAt) ? expiresAt - Date.now() : 0;
    if (remaining <= 0) throw new Error("canvas_file_transfer_timeout");
    return AbortSignal.timeout(Math.min(2_147_483_647, remaining));
  };
  const limit = 1024 * 1024;
  const responseLimit = 2 * 1024 * 1024;
  const COUNT = /^(?:0|[1-9][0-9]*)$/;
  const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const decimalId = (value) => {
    const id = String(value || "");
    return /^[1-9][0-9]*$/.test(id) ? id : "";
  };
  const filename = (value) => typeof value === "string" && value.length >= 1 && value.length <= 255 && value === value.trim()
    && value !== "." && value !== ".." && !/[\\/\u0000-\u001f]/.test(value) ? value : "";
  const contentType = (value) => typeof value === "string" && /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(value)
    ? value
    : "";
  const sha256 = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const isOwnToken = (value) => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+/.test(value);
  const failure = (error, sent = false, outcomeUnknown = false, status) => ({
    schema: "morrow.canvas-course-file-transfer.v1",
    ok: false,
    sent,
    outcomeUnknown,
    ...(Number.isSafeInteger(status) ? { status } : {}),
    ...(sent ? { verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: error } } : {}),
    error,
  });
  // Canvas keeps both files when a name is taken, and names the new one `name-1.ext`. A folder upload
  // proves the name is free first, so only an upload to any other target accepts that renamed form.
  const savedName = (value, requested, exact) => {
    if (value === requested) return true;
    if (exact) return false;
    const dot = requested.lastIndexOf(".");
    const stem = dot > 0 ? requested.slice(0, dot) : requested;
    const extension = dot > 0 ? requested.slice(dot) : "";
    return value.startsWith(stem + "-") && value.endsWith(extension)
      && /^[1-9][0-9]{0,5}$/.test(value.slice(stem.length + 1, value.length - extension.length));
  };
  const safeFile = (value, expectedId, expectedFolder, attachment) => {
    if (!plainObject(value) || decimalId(value.id) !== expectedId || (expectedFolder && decimalId(value.folder_id) !== expectedFolder)
      || !savedName(filename(value.display_name || value.filename), attachment.filename, Boolean(expectedFolder))
      || !Number.isSafeInteger(value.size) || value.size !== attachment.size_bytes
      || contentType(String(value["content-type"] || value.content_type || "").split(";", 1)[0].trim().toLowerCase()) !== attachment.content_type) {
      throw new Error("canvas_file_readback_mismatch");
    }
    return {
      id: expectedId,
      ...(expectedFolder ? { folder_id: expectedFolder } : {}),
      display_name: filename(value.display_name || value.filename),
      filename: filename(value.filename || value.display_name),
      size: value.size,
      content_type: attachment.content_type,
    };
  };
  const canvasUrl = (value, canvasOrigin, code) => {
    if (typeof value !== "string" || value.length < 1 || value.length > 8192) throw new Error(code);
    let url;
    try { url = new URL(value, canvasOrigin); } catch { throw new Error(code); }
    if (url.protocol !== "https:" || url.origin !== canvasOrigin || url.username || url.password || url.hash) throw new Error(code);
    return url;
  };
  const cancelBody = (body) => {
    try {
      const canceled = body?.cancel?.();
      if (canceled && typeof canceled.catch === "function") canceled.catch(() => {});
    } catch {}
  };
  const boundedText = async (response) => {
    const declared = response.headers?.get?.("content-length");
    if (declared !== null && (!COUNT.test(declared) || Number(declared) > responseLimit)) {
      cancelBody(response.body);
      throw new Error("canvas_file_transfer_response_too_large");
    }
    const reader = response.body?.getReader?.();
    if (!reader || typeof globalThis.TextDecoder !== "function") {
      cancelBody(response.body);
      throw new Error("canvas_file_transfer_response_unavailable");
    }
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let size = 0;
    let text = "";
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (!(next.value instanceof Uint8Array) || (size += next.value.byteLength) > responseLimit) {
          cancelBody(reader);
          throw new Error("canvas_file_transfer_response_too_large");
        }
        text += decoder.decode(next.value, { stream: true });
      }
      return text + decoder.decode();
    } catch (error) {
      cancelBody(reader);
      throw error;
    }
  };
  // Canvas refuses a signed-in change without the page's own request token.
  const csrfHeaders = () => {
    const cookie = document.cookie.split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith("_csrf_token="));
    const token = cookie ? decodeURIComponent(cookie.slice("_csrf_token=".length)) : "";
    if (!token) throw new Error("canvas_csrf_context_missing");
    return { "X-CSRF-Token": token };
  };
  const canvasJson = async (pathname, canvasOrigin, options = {}) => {
    const response = await fetch(new URL(pathname, canvasOrigin), {
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      ...options,
      headers: { Accept: "application/json+canvas-string-ids", ...(options.headers || {}) },
      signal: requestSignal(input?.expiresAt),
    });
    if (!response.ok) {
      cancelBody(response.body);
      throw new Error("canvas_file_transfer_http_" + response.status);
    }
    let received;
    try { received = new URL(response.url); } catch { cancelBody(response.body); throw new Error("canvas_file_transfer_origin_changed"); }
    if (received.origin !== canvasOrigin) { cancelBody(response.body); throw new Error("canvas_file_transfer_origin_changed"); }
    const text = await boundedText(response);
    let value;
    try { value = JSON.parse(text); } catch { throw new Error("canvas_file_transfer_response_invalid"); }
    return { status: response.status, headers: response.headers, value };
  };
  const attachmentFrom = async (value) => {
    if (!plainObject(value)
      || Object.keys(value).some((key) => !["schema", "handle", "manifest", "bytes_base64", "content_type"].includes(key))
      || value.schema !== "morrow.private-file-attachment.v1"
      || typeof value.handle !== "string" || !/^file:[A-Za-z0-9_.:-]{1,160}$/.test(value.handle)
      || !plainObject(value.manifest)
      || Object.keys(value.manifest).some((key) => !["filename", "size_bytes", "sha256"].includes(key))
      || typeof value.bytes_base64 !== "string"
      || value.bytes_base64.length < 4 || value.bytes_base64.length > 4 * Math.ceil(limit / 3)
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.bytes_base64)) throw new Error("canvas_file_attachment_invalid");
    const manifest = value.manifest;
    const name = filename(manifest.filename);
    const type = contentType(value.content_type);
    if (!name || !type || !Number.isSafeInteger(manifest.size_bytes) || manifest.size_bytes < 1 || manifest.size_bytes > limit
      || typeof manifest.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error("canvas_file_attachment_invalid");
    let binary;
    try { binary = atob(value.bytes_base64); } catch { throw new Error("canvas_file_attachment_invalid"); }
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.byteLength !== manifest.size_bytes || bytes.byteLength > limit || await sha256(bytes) !== manifest.sha256) {
      throw new Error("canvas_file_attachment_invalid");
    }
    return { filename: name, size_bytes: manifest.size_bytes, sha256: manifest.sha256, content_type: type, bytes };
  };
  const uploadResponse = async (response, canvasOrigin) => {
    if (response.status >= 300 && response.status < 400 || response.status === 201 && response.headers.get("location")) {
      cancelBody(response.body);
      const confirmation = canvasUrl(response.headers.get("location"), canvasOrigin, "canvas_file_upload_confirmation_refused");
      return (await canvasJson(confirmation.pathname + confirmation.search, canvasOrigin)).value;
    }
    if (!response.ok) {
      cancelBody(response.body);
      throw new Error("canvas_file_upload_http_" + response.status);
    }
    try { canvasUrl(response.url, canvasOrigin, "canvas_file_upload_confirmation_refused"); } catch (error) { cancelBody(response.body); throw error; }
    const text = await boundedText(response);
    if (!text.trim()) throw new Error("canvas_file_upload_confirmation_missing");
    try { return JSON.parse(text); } catch { throw new Error("canvas_file_upload_confirmation_invalid"); }
  };
  const exactDownloadUrl = (value, canvasOrigin, fileId) => {
    const url = canvasUrl(value, canvasOrigin, "canvas_file_download_url_refused");
    if (url.pathname !== "/files/" + fileId + "/download" || url.searchParams.getAll("verifier").length !== 1 || !url.searchParams.get("verifier")) {
      throw new Error("canvas_file_download_url_refused");
    }
    return url;
  };
  const boundedBytes = async (response) => {
    const length = response.headers.get("content-length");
    if (length !== null && (!/^(?:0|[1-9][0-9]*)$/.test(length) || Number(length) > limit)) {
      try { const cancellation = response?.body?.cancel?.(); if (cancellation && typeof cancellation.catch === "function") void cancellation.catch(() => {}); } catch {}
      throw new Error("canvas_file_download_too_large");
    }
    if (!response.body || typeof response.body.getReader !== "function") throw new Error("canvas_file_download_unreadable");
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (!(next.value instanceof Uint8Array) || (size += next.value.byteLength) > limit) {
          try { const cancellation = reader.cancel(); if (cancellation && typeof cancellation.catch === "function") void cancellation.catch(() => {}); } catch {}
          throw new Error("canvas_file_download_too_large");
        }
        chunks.push(next.value);
      }
    } catch (error) {
      try { const cancellation = reader.cancel(); if (cancellation && typeof cancellation.catch === "function") void cancellation.catch(() => {}); } catch {}
      throw error;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  };
  const transferMode = plainObject(input) && typeof input.mode === "string" ? input.mode : "direct";
  let uploadDispatched = transferMode === "complete";
  let uploadStatus;
  try {
    const target = plainObject(input?.target) ? input.target : null;
    const kind = target?.kind === "file" || target?.kind === "rubric_csv" ? target.kind : "";
    const uploadPath = typeof target?.uploadPath === "string" && target.uploadPath.length <= 512
      && /^\/api\/v1(?:\/[a-z_]+(?:\/(?:[1-9][0-9]*|self))?)+$/.test(target.uploadPath)
      && (kind === "file" ? /\/files$/.test(target.uploadPath) : /\/rubrics\/upload$/.test(target.uploadPath))
      ? target.uploadPath : "";
    if (!plainObject(input) || !plainObject(input.binding) || !uploadPath
      || !(kind === "file" ? ["direct", "initialize", "complete"] : ["rubric"]).includes(transferMode)) throw new Error("canvas_file_binding_invalid");
    const courseId = decimalId(input.binding.courseId);
    const principalId = decimalId(input.binding.principalId);
    const folderId = /^\/api\/v1\/folders\/([1-9][0-9]*)\/files$/.exec(uploadPath)?.[1] || "";
    const canvasOrigin = typeof input.binding.origin === "string" ? input.binding.origin : "";
    if (!courseId || !principalId || !canvasOrigin || location.origin !== canvasOrigin) throw new Error("canvas_file_binding_invalid");
    const origin = canvasUrl(canvasOrigin, canvasOrigin, "canvas_file_binding_invalid");
    if (origin.href !== canvasOrigin + "/") throw new Error("canvas_file_binding_invalid");
    const attachment = await attachmentFrom(input.attachment);
    const currentBinding = async () => {
      const profile = await canvasJson("/api/v1/users/self/profile", canvasOrigin);
      if (decimalId(profile.value?.id) !== principalId) throw new Error("canvas_principal_changed");
      const course = await canvasJson("/api/v1/courses/" + encodeURIComponent(courseId), canvasOrigin);
      if (decimalId(course.value?.id) !== courseId) throw new Error("canvas_file_course_changed");
    };
    const result = (fields) => ({ schema: "morrow.canvas-course-file-transfer.v1", ...fields });
    if (kind === "rubric_csv") {
      await currentBinding();
      const form = new FormData();
      form.append("attachment", new Blob([attachment.bytes], { type: attachment.content_type }), attachment.filename);
      const headers = csrfHeaders();
      uploadDispatched = true;
      const started = await canvasJson(uploadPath, canvasOrigin, { method: "POST", headers, body: form });
      uploadStatus = started.status;
      const importId = decimalId(started.value?.id);
      if (!importId) throw new Error("canvas_rubric_import_result_invalid");
      const finished = ["succeeded", "succeeded_with_errors", "failed"];
      let status = started.value;
      while (!finished.includes(status?.workflow_state)) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        status = (await canvasJson(uploadPath + "/" + importId, canvasOrigin)).value;
        if (decimalId(status?.id) !== importId) throw new Error("canvas_rubric_import_readback_mismatch");
      }
      const state = status.workflow_state;
      const verified = state === "succeeded" && (status.error_count === undefined || status.error_count === null || status.error_count === 0);
      return result({
        ok: verified,
        sent: true,
        outcomeUnknown: false,
        status: uploadStatus,
        verification: verified
          ? { schema: "morrow.browser-verification.v1", status: "verified", targets: [{ type: "canvas_course", id: courseId }, { type: "canvas_rubric_import", id: importId }] }
          : { schema: "morrow.browser-verification.v1", status: "mismatch", reason: "canvas_rubric_import_" + state },
        ...(verified ? {} : { error: "canvas_rubric_import_" + state }),
        data: { course_id: courseId, upload_path: uploadPath, rubric_import: { id: importId, workflow_state: state } },
      });
    }
    const beginUpload = async () => {
      const started = await canvasJson(uploadPath, canvasOrigin, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", ...csrfHeaders() },
        body: new URLSearchParams({
          name: attachment.filename,
          size: String(attachment.size_bytes),
          content_type: attachment.content_type,
          on_duplicate: "rename",
        }),
      });
      const uploadUrl = typeof started.value?.upload_url === "string" ? started.value.upload_url : "";
      const uploadParams = started.value?.upload_params;
      if (!plainObject(uploadParams) || !uploadUrl) throw new Error("canvas_file_upload_init_invalid");
      let trustedUploadUrl;
      try { trustedUploadUrl = new URL(uploadUrl); } catch { throw new Error("canvas_file_upload_url_refused"); }
      if (trustedUploadUrl.protocol !== "https:" || trustedUploadUrl.username || trustedUploadUrl.password || trustedUploadUrl.hash) {
        throw new Error("canvas_file_upload_url_refused");
      }
      const entries = Object.entries(uploadParams);
      if (!entries.length || entries.length > 64 || entries.some(([key, value]) => !/^[A-Za-z0-9_.-]{1,128}$/.test(key) || key === "file" || typeof value !== "string" || value.length > 8192)) {
        throw new Error("canvas_file_upload_params_refused");
      }
      return { upload_url: trustedUploadUrl.href, upload_params: Object.fromEntries(entries), entries };
    };
    const filenameAvailable = async () => {
      const query = new URLSearchParams({ search_term: attachment.filename, per_page: "100" });
      query.append("only[]", "names");
      const listed = await canvasJson("/api/v1/folders/" + encodeURIComponent(folderId) + "/files?" + query, canvasOrigin);
      if (!Array.isArray(listed.value) || listed.value.length > 100) throw new Error("canvas_file_name_check_unavailable");
      const names = listed.value.map((entry) => plainObject(entry) ? filename(entry.display_name || entry.filename) : "");
      if (names.some((name) => !name)) throw new Error("canvas_file_name_check_unavailable");

      const link = listed.headers.get("link");
      if (link !== null && link.trim()) {
        const parts = link.split(/,\s*(?=<)/);
        if (!parts.length) throw new Error("canvas_file_name_check_unavailable");
        for (const part of parts) {
          const target = /^\s*<([^<>]+)>/.exec(part);
          if (!target) throw new Error("canvas_file_name_check_unavailable");
          canvasUrl(target[1], canvasOrigin, "canvas_file_name_check_unavailable");
          let rest = part.slice(target[0].length);
          const relations = [];
          while (rest.trim()) {
            const parameter = /^\s*;\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*=\s*(?:"([^"]*)"|([^;\s,]+))/.exec(rest);
            if (!parameter) throw new Error("canvas_file_name_check_unavailable");
            if (parameter[1].toLowerCase() === "rel") relations.push(...String(parameter[2] ?? parameter[3]).toLowerCase().split(/\s+/));
            rest = rest.slice(parameter[0].length);
          }
          if (!relations.length) throw new Error("canvas_file_name_check_unavailable");
          if (relations.includes("next")) throw new Error("canvas_file_name_check_incomplete");
        }
      } else if (listed.value.length === 100) {
        throw new Error("canvas_file_name_check_incomplete");
      }
      if (names.includes(attachment.filename)) throw new Error("canvas_file_name_already_exists");
    };
    const finalFile = async (completed) => {
      const fileId = decimalId(completed?.id);
      if (!fileId) throw new Error("canvas_file_upload_result_invalid");
      await currentBinding();
      const readback = await canvasJson("/api/v1/files/" + encodeURIComponent(fileId), canvasOrigin);
      const file = safeFile(readback.value, fileId, folderId, attachment);
      const downloadUrl = exactDownloadUrl(readback.value?.url, canvasOrigin, fileId);
      return { fileId, file, downloadUrl };
    };

    const targetFields = { course_id: courseId, upload_path: uploadPath, ...(folderId ? { folder_id: folderId } : {}) };
    await currentBinding();
    if (transferMode !== "complete" && folderId) await filenameAvailable();
    if (transferMode === "initialize") {
      const started = await beginUpload();
      return {
        schema: "morrow.canvas-course-file-transfer.v1",
        ok: true,
        sent: false,
        outcomeUnknown: false,
        data: { ...targetFields, upload_url: started.upload_url, upload_params: started.upload_params },
      };
    }
    if (transferMode === "complete") {
      const confirmation = canvasUrl(input.confirmation_url, canvasOrigin, "canvas_file_upload_confirmation_refused");
      const completed = (await canvasJson(confirmation.pathname + confirmation.search, canvasOrigin)).value;
      const finalized = await finalFile(completed);
      return {
        schema: "morrow.canvas-course-file-transfer.v1",
        ok: true,
        sent: true,
        outcomeUnknown: false,
        ...(Number.isSafeInteger(input.upload_status) ? { status: input.upload_status } : {}),
        verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "canvas_file_download_pending" },
        data: {
          ...targetFields, file: finalized.file,
          sha256: attachment.sha256, download_url: finalized.downloadUrl.href,
        },
      };
    }

    const started = await beginUpload();
    const form = new FormData();
    for (const [key, value] of started.entries) form.append(key, value);
    form.append("file", new Blob([attachment.bytes], { type: attachment.content_type }), attachment.filename);
    const uploadSignal = requestSignal(input.expiresAt);
    uploadDispatched = true;
    const uploaded = await fetch(started.upload_url, {
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      redirect: "manual",
      referrerPolicy: "no-referrer",
      body: form,
      signal: uploadSignal,
    });
    uploadStatus = uploaded.status;
    const finalized = await finalFile(await uploadResponse(uploaded, canvasOrigin));
    const download = await fetch(finalized.downloadUrl, {
      credentials: "omit",
      cache: "no-store",
      redirect: "follow",
      referrerPolicy: "no-referrer",
      signal: requestSignal(input?.expiresAt),
    });
    if (!download.ok) {
      cancelBody(download.body);
      throw new Error("canvas_file_download_http_" + download.status);
    }
    let finalUrl;
    try { finalUrl = new URL(download.url); } catch { cancelBody(download.body); throw new Error("canvas_file_download_origin_refused"); }
    if (finalUrl.protocol !== "https:") {
      cancelBody(download.body);
      throw new Error("canvas_file_download_origin_refused");
    }
    const bytes = await boundedBytes(download);
    if (bytes.byteLength !== attachment.size_bytes || await sha256(bytes) !== attachment.sha256) throw new Error("canvas_file_download_digest_mismatch");

    return {
      schema: "morrow.canvas-course-file-transfer.v1",
      ok: true,
      sent: true,
      outcomeUnknown: false,
      status: uploadStatus,
      verification: { schema: "morrow.browser-verification.v1", status: "verified", targets: [
        { type: "canvas_course", id: courseId },
        ...(folderId ? [{ type: "canvas_folder", id: folderId }] : []),
        { type: "canvas_file", id: finalized.fileId },
      ] },
      data: { ...targetFields, file: finalized.file, sha256: attachment.sha256 },
    };
  } catch (error) {
    const message = String(error?.message || error);
    return failure(isOwnToken(message) ? message : "canvas_file_transfer_execution_failed", uploadDispatched, uploadDispatched, uploadStatus);
  }
}
