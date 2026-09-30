import { isJsonObject, type JsonObject } from "@morrow/contracts";

/** A roster is usable only after every authorized chunk is complete. */
export async function collectCanvasPrivacyCollection(
  read: (nextPage?: string) => Promise<JsonObject>,
  failure: string,
): Promise<readonly unknown[]> {
  const output: unknown[] = [];
  const seen = new Set<string>();
  let nextPage: string | undefined;
  let pagesRead = 0;
  let retainedBytes = 0;
  for (let chunk = 0; chunk < 10; chunk += 1) {
    const browser = await read(nextPage);
    if (!isJsonObject(browser) || browser.ok !== true || browser.sent !== true
      || typeof browser.truncated !== "boolean" || !Array.isArray(browser.data)) throw new Error(failure);
    retainedBytes += Buffer.byteLength(JSON.stringify(browser.data), "utf8");
    if (retainedBytes > 16 * 1024 * 1024 || output.length + browser.data.length > 50_000) throw new Error(failure);
    output.push(...browser.data);
    if (!browser.truncated) return output;
    const token = browser.morrow_next_page;
    const currentPages = browser.morrow_pages_read;
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(token) || seen.has(token)
      || typeof currentPages !== "number" || !Number.isSafeInteger(currentPages)
      || currentPages <= pagesRead || currentPages >= 500) throw new Error(failure);
    seen.add(token);
    nextPage = token;
    pagesRead = currentPages;
  }
  throw new Error(failure);
}
