export function normalizeCourseConnectionUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    return `${url.origin}${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

export function validCourseConnectionIntent(value, now = Date.now(), ttlMs = 60_000) {
  return value && typeof value.id === "string" && /^[a-f0-9-]{36}$/.test(value.id)
    && Number.isInteger(value.tabId) && typeof value.url === "string" && normalizeCourseConnectionUrl(value.url) === value.url
    && Array.isArray(value.origins) && value.origins.length > 0
    && value.origins.every((origin) => typeof origin === "string" && /^https:\/\/[^/*]+\/\*$/.test(origin))
    && Array.isArray(value.preGrantedOrigins) && value.preGrantedOrigins.every((origin) => value.origins.includes(origin))
    && Number.isFinite(value.createdAt) && value.createdAt + ttlMs >= now;
}

export function canClaimCourseConnectionIntent(intent, { intentId, tabId, url, permissionOrigins, now = Date.now(), ttlMs = 60_000 }) {
  return validCourseConnectionIntent(intent, now, ttlMs)
    && (intentId === undefined || intent.id === intentId)
    && intent.tabId === tabId
    && intent.url === normalizeCourseConnectionUrl(url)
    && intent.origins.every((origin) => permissionOrigins.includes(origin));
}

export function canCompleteCourseConnectionIntent(intent, { intentId, tabId, url, permissionOrigins, addedOrigins, popupConfirmed = false, now = Date.now(), ttlMs = 60_000 }) {
  if (!canClaimCourseConnectionIntent(intent, { intentId, tabId, url, permissionOrigins, now, ttlMs })) return false;
  if (popupConfirmed) return true;
  if (!Array.isArray(addedOrigins)) return false;
  const alreadyGranted = Array.isArray(intent.preGrantedOrigins) ? intent.preGrantedOrigins : [];
  return intent.origins.every((origin) => alreadyGranted.includes(origin) || addedOrigins.includes(origin));
}
