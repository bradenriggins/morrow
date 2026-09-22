// The Item Banks LTI tool runs in its own frame on a tenant Quizzes host, and
// only that frame holds the banks.build credential. Every other frame on a
// Canvas page can belong to a third-party tool, so Morrow runs the Item Bank
// executor in these frames alone. This is the one definition of the host shape:
// the service worker uses it both to choose injection targets and to build the
// connection-permission origins.
export const ITEM_BANK_FRAME_HOST_PATTERN = /^[^.]+\.quiz-(?:lti|api)(?:-[^.]+)*\.instructure\.com$/i;

export function itemBankApiOriginForFrame(frameUrl) {
  try {
    const url = new URL(frameUrl);
    if (url.protocol !== "https:" || !ITEM_BANK_FRAME_HOST_PATTERN.test(url.hostname)) return "";
    const hostname = url.hostname.toLowerCase().replace(".quiz-lti", ".quiz-api");
    return `https://${hostname}`;
  } catch {
    return "";
  }
}

// Takes the array chrome.webNavigation.getAllFrames({ tabId }) returns and
// yields the frame ids Morrow may inject into, in the order Chrome listed them.
export function itemBankFrameIds(frames) {
  const ids = [];
  for (const frame of Array.isArray(frames) ? frames : []) {
    if (!Number.isInteger(frame?.frameId) || frame.frameId < 0) continue;
    let url;
    try {
      url = new URL(frame.url);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || !ITEM_BANK_FRAME_HOST_PATTERN.test(url.hostname)) continue;
    ids.push(frame.frameId);
  }
  return ids;
}
