import { isJsonObject, type JsonObject } from "@morrow/contracts";
import type { GatewayRuntime } from "./runtime.js";
import { MAX_RESULT_ARTIFACT_CHARACTERS } from "./result-artifacts.js";

export function canvasReadResult(runtime: Pick<GatewayRuntime, "resultPage">, response: JsonObject): JsonObject {
  let result = response;
  const artifact = result.structuredContent;
  if (isJsonObject(artifact) && artifact.schema === "morrow.result-artifact.v1") {
    if (typeof artifact.handle !== "string" || typeof artifact.totalCharacters !== "number"
      || artifact.totalCharacters > MAX_RESULT_ARTIFACT_CHARACTERS) throw new Error("Saved result is unavailable.");
    let text = "";
    let offset: number | null = 0;
    do {
      const page = runtime.resultPage(artifact.handle, offset);
      if (typeof page.text !== "string" || (page.nextOffset !== null && typeof page.nextOffset !== "number")) throw new Error("Saved result is incomplete.");
      text += page.text;
      offset = page.nextOffset;
    } while (offset !== null);
    result = JSON.parse(text) as JsonObject;
  }
  const content = result.structuredContent;
  const browser = isJsonObject(content) ? content.result : null;
  if (result.isError === true || !isJsonObject(content)
    || content.schema !== "morrow.canvas-connector.result.v1" || content.ok !== true
    || content.commandKind !== "invoke_read" || !isJsonObject(browser)
    || browser.ok !== true || browser.sent !== true || browser.truncated !== false) {
    throw new Error("Canvas did not return a complete readable result.");
  }
  return browser;
}
