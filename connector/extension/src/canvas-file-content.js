export const MAX_FILE_TEXT_BYTES = 1024 * 1024;

function normalizedContentType(value) {
  return typeof value === "string" ? value.split(";", 1)[0].trim().toLowerCase() : "";
}

export function canvasFileTextContentTypeSupported(value) {
  return ["text/plain", "text/html", "application/xhtml+xml"].includes(normalizedContentType(value));
}

/**
 * This function is intentionally self-contained. Chrome serializes only the
 * supplied function body for a MAIN-world injection, so every validation it
 * needs must remain inside this lexical scope.
 */
export async function executeCanvasCourseFileTextInPage(input) {
  const isOwnToken = (value) => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+/.test(value);
  const decimalId = (value) => {
    const id = String(value || "");
    return /^[1-9][0-9]*$/.test(id) ? id : "";
  };
  const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const contentType = (value) => typeof value === "string" ? value.split(";", 1)[0].trim().toLowerCase() : "";
  const versionFromFile = (value, expectedId) => {
    if (!plainObject(value) || decimalId(value.id) !== expectedId) throw new Error("canvas_file_target_changed");
    const size = value.size;
    const updatedAt = typeof value.updated_at === "string" && value.updated_at.trim() ? value.updated_at : "";
    const modifiedAt = typeof value.modified_at === "string" && value.modified_at.trim() ? value.modified_at : "";
    const declaredType = contentType(value["content-type"]);
    if (!Number.isSafeInteger(size) || size < 0 || !declaredType || (!updatedAt && !modifiedAt)) {
      throw new Error("canvas_file_metadata_incomplete");
    }
    return { id: expectedId, size, content_type: declaredType, updated_at: updatedAt || null, modified_at: modifiedAt || null };
  };
  const safeFileMetadata = (value, version) => ({
    id: version.id,
    ...(typeof value.display_name === "string" ? { display_name: value.display_name.slice(0, 500) } : {}),
    ...(typeof value.filename === "string" ? { filename: value.filename.slice(0, 500) } : {}),
    size: version.size,
    content_type: version.content_type,
    updated_at: version.updated_at,
    modified_at: version.modified_at,
  });
  const canonicalDownloadUrl = (value, canvasOrigin, fileId) => {
    if (typeof value !== "string" || value.length < 1 || value.length > 8_192) throw new Error("canvas_file_download_url_missing");
    let url;
    try { url = new URL(value); } catch { throw new Error("canvas_file_download_url_invalid"); }
    if (url.protocol !== "https:" || url.origin !== canvasOrigin || url.username || url.password || url.hash
      || url.pathname !== `/files/${fileId}/download` || url.searchParams.getAll("verifier").length !== 1
      || !url.searchParams.get("verifier")) throw new Error("canvas_file_download_url_refused");
    return url.href;
  };
  const canvasJson = async (pathname, canvasOrigin) => {
    const response = await fetch(new URL(pathname, canvasOrigin), {
      credentials: "include",
      headers: { Accept: "application/json+canvas-string-ids" },
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) throw new Error(`canvas_file_metadata_http_${response.status}`);
    const received = new URL(response.url);
    if (received.origin !== canvasOrigin) throw new Error("canvas_file_metadata_origin_changed");
    return await response.json();
  };
  try {
    if (!plainObject(input) || !plainObject(input.binding)) throw new Error("canvas_file_binding_invalid");
    const courseId = decimalId(input.binding.courseId);
    const fileId = decimalId(input.fileId);
    const principalId = decimalId(input.binding.principalId);
    const canvasOrigin = typeof input.binding.origin === "string" ? input.binding.origin : "";
    if (!courseId || !fileId || !principalId || !canvasOrigin || location.origin !== canvasOrigin) throw new Error("canvas_file_binding_invalid");
    let origin;
    try { origin = new URL(canvasOrigin); } catch { throw new Error("canvas_file_binding_invalid"); }
    if (origin.protocol !== "https:" || origin.origin !== canvasOrigin) throw new Error("canvas_file_binding_invalid");
    const profile = await canvasJson("/api/v1/users/self/profile", canvasOrigin);
    if (decimalId(profile?.id) !== principalId) throw new Error("canvas_principal_changed");
    const course = await canvasJson(`/api/v1/courses/${encodeURIComponent(courseId)}`, canvasOrigin);
    if (decimalId(course?.id) !== courseId) throw new Error("canvas_file_course_changed");
    const file = await canvasJson(`/api/v1/courses/${encodeURIComponent(courseId)}/files/${encodeURIComponent(fileId)}`, canvasOrigin);
    const version = versionFromFile(file, fileId);
    return {
      ok: true,
      version,
      file: safeFileMetadata(file, version),
      ...(input.includeDownloadUrl === true ? { downloadUrl: canonicalDownloadUrl(file.url, canvasOrigin, fileId) } : {}),
    };
  } catch (error) {
    const message = String(error?.message || error);
    return { ok: false, error: isOwnToken(message) ? message : "canvas_file_text_execution_failed" };
  }
}

export async function prepareCanvasCourseFileTextInPage(input) {
  return await executeCanvasCourseFileTextInPage({ ...input, includeDownloadUrl: true });
}

export async function verifyCanvasCourseFileTextInPage(input) {
  return await executeCanvasCourseFileTextInPage({ ...input, includeDownloadUrl: false });
}
