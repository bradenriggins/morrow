import { isJsonObject, type JsonObject } from "@morrow/contracts";
import type { GatewayRuntime } from "./runtime.js";
import { resolveResultArtifact, type ResultArtifactPage } from "./result-artifacts.js";

export function canvasReadResult(runtime: Pick<GatewayRuntime, "resultPage">, response: JsonObject): JsonObject {
  const result = resolveResultArtifact(response, (handle, offset) => (
    runtime.resultPage(handle, offset) as unknown as ResultArtifactPage
  ));
  const content = result.structuredContent;
  const browser = isJsonObject(content) ? content.result : null;
  // Truncation is something only a listing can be: a route that answers with one
  // record carries no page bound, so Canvas states nothing about it. Requiring
  // the flag on every answer refused every single-record reading, and a plan
  // that begins by reading one course could never be made.
  if (result.isError === true || !isJsonObject(content)
    || content.schema !== "morrow.canvas-connector.result.v1" || content.ok !== true
    || content.commandKind !== "invoke_read" || !isJsonObject(browser)
    || browser.ok !== true || browser.sent !== true
    || (Array.isArray(browser.data) ? browser.truncated !== false : browser.truncated === true)) {
    throw new Error("Canvas did not return a complete readable result.");
  }
  return browser;
}
