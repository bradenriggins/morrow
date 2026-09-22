import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canvasApiCompatibilityContract, canvasApiCompatibilityDigest, loadCanvasApiCatalog } from "@morrow/canvas-api-catalog";
import { canonicalJson } from "@morrow/contracts";
import { CanvasConnectorRuntime } from "../../canvas-connector-mcp/src/runtime.js";
import { PRIVATE_BRIDGE_OPERATION_CONTRACTS as runtimePrivateBridgeOperationContracts, browserCatalogCompatibilityContract, loadCanvasBrowserCatalog, loadMoodleBrowserCatalog, parseMoodleBrowserCatalog, privateBridgeCompatibilityContract as runtimePrivateBridgeCompatibilityContract } from "../../canvas-connector-mcp/src/browser-catalog.js";
import {
  MAX_PUBLIC_CATALOG_BYTES,
  PRIVATE_BRIDGE_OPERATION_CONTRACTS as extensionPrivateBridgeOperationContracts,
  boundedCatalogText,
  bridgeCatalogCompatibilityContract as extensionBridgeCompatibilityContract,
  browserCatalogCompatibilityContract as extensionBrowserCompatibilityContract,
  canvasApiCompatibilityContract as extensionCanvasCompatibilityContract,
  parseBrowserCatalogText,
  parseCanvasApiCatalogText,
  privateBridgeCompatibilityContract as extensionPrivateBridgeCompatibilityContract,
  stableJson as extensionStableJson,
} from "../../../connector/extension/src/catalog-compatibility.js";
import { bridgeCatalogDigestForTests } from "./fixtures/bridge-catalog-digest.js";

const runtimes: CanvasConnectorRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
});

describe("bridge catalog digest fixture", () => {
  it("keeps the extension and MCP compatibility projections byte-identical", () => {
    const root = resolve("../..");
    const canvas = loadCanvasApiCatalog(resolve(root, "artifacts/canvas-api/canvas-api-catalog.json"));
    const canvasBrowser = loadCanvasBrowserCatalog();
    const moodle = loadMoodleBrowserCatalog();
    const canvasBrowserValue = JSON.parse(readFileSync(resolve(root, "connector/extension/generated/canvas-browser-catalog.json"), "utf8"));
    const moodleValue = JSON.parse(readFileSync(resolve(root, "connector/extension/generated/moodle-browser-catalog.json"), "utf8"));

    expect(extensionStableJson(extensionCanvasCompatibilityContract(canvas)))
      .toBe(canonicalJson(canvasApiCompatibilityContract(canvas)));
    expect(extensionStableJson(extensionBrowserCompatibilityContract(canvasBrowserValue)))
      .toBe(canonicalJson(browserCatalogCompatibilityContract(canvasBrowser)));
    expect(extensionStableJson(extensionBrowserCompatibilityContract(moodleValue)))
      .toBe(canonicalJson(browserCatalogCompatibilityContract(moodle)));
    expect(extensionStableJson(extensionPrivateBridgeCompatibilityContract(extensionPrivateBridgeOperationContracts)))
      .toBe(canonicalJson(runtimePrivateBridgeCompatibilityContract()));
    expect(extensionStableJson(extensionPrivateBridgeOperationContracts))
      .toBe(canonicalJson(runtimePrivateBridgeOperationContracts));
    expect(canvasApiCompatibilityDigest(canvas)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("normalizes every accepted browser-catalog string before extension compatibility hashing", () => {
    const value = {
      schema: "morrow.browser-catalog.v1",
      provider: "moodle",
      operations: [
        {
          key: " moodle.form.test.read.v1 ",
          toolName: "moodle_test_read ",
          provider: "moodle",
          summary: " Read a test record ",
          description: " Read one test record. ",
          readOnly: true,
          dataClass: " learner ",
          family: " learner-data ",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          documentation: " https://example.invalid/read ",
        },
        {
          key: " moodle.form.test.write.v1 ",
          toolName: "moodle_test_write ",
          provider: "moodle",
          summary: " Change a test record ",
          description: " Change one test record. ",
          readOnly: false,
          reviewTool: "moodle_test_read ",
          destructive: false,
          irreversible: null,
          dataClass: " course ",
          family: " course-content ",
          morrowPrivate: null,
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          documentation: " https://example.invalid/write ",
        },
      ],
    };
    const parsed = parseMoodleBrowserCatalog(value, "a".repeat(64));

    expect(extensionStableJson(extensionBrowserCompatibilityContract(value)))
      .toBe(canonicalJson(browserCatalogCompatibilityContract(parsed)));
  });

  it("rejects browser-catalog identities that collide only after normalization", () => {
    const operation = (key: string, toolName: string) => ({
      key,
      toolName,
      provider: "moodle",
      summary: "Read a test record",
      description: "Read one test record.",
      readOnly: true,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      documentation: "https://example.invalid/read",
    });
    const value = {
      schema: "morrow.browser-catalog.v1",
      provider: "moodle",
      operations: [
        operation("moodle.form.test.read.v1", "moodle_test_read"),
        operation(" moodle.form.test.read.v1 ", "moodle_test_other_read"),
      ],
    };

    expect(() => parseMoodleBrowserCatalog(value, "a".repeat(64))).toThrow(/duplicate operations/u);
    expect(() => extensionBrowserCompatibilityContract(value)).toThrow(/duplicate operations/u);
  });

  it("admits only bounded strict and shallow catalog bytes", async () => {
    await expect(boundedCatalogText(new Response("{}", {
      status: 200,
      headers: { "content-length": String(MAX_PUBLIC_CATALOG_BYTES + 1) },
    }), "test catalog")).rejects.toThrow(/too large/u);
    await expect(boundedCatalogText(new Response(new Uint8Array([0xc3, 0x28]), { status: 200 }), "test catalog"))
      .rejects.toThrow(/strict UTF-8/u);
    const deep = `${"[".repeat(65)}0${"]".repeat(65)}`;
    await expect(boundedCatalogText(new Response(deep, { status: 200 }), "test catalog"))
      .rejects.toThrow(/deeply nested/u);
    await expect(boundedCatalogText(new Response("missing", { status: 404 }), "test catalog"))
      .rejects.toThrow(/response is invalid/u);
  });

  it("verifies the embedded Canvas seal and exact catalog shape before hashing", async () => {
    const root = resolve("../..");
    const source = JSON.parse(readFileSync(resolve(root, "connector/extension/generated/canvas-api-catalog.json"), "utf8"));
    await expect(parseCanvasApiCatalogText(JSON.stringify({ ...source, catalogDigest: "0".repeat(64) })))
      .rejects.toThrow(/digest does not match/u);
    await expect(parseCanvasApiCatalogText(JSON.stringify({ ...source, unexpected: true })))
      .rejects.toThrow(/catalog is invalid/u);

    const browser = JSON.parse(readFileSync(resolve(root, "connector/extension/generated/canvas-browser-catalog.json"), "utf8"));
    expect(parseBrowserCatalogText(JSON.stringify(browser), "canvas"))
      .toMatchObject({ schema: "morrow.browser-catalog.v1", provider: "canvas" });
    expect(() => parseBrowserCatalogText(JSON.stringify({ ...browser, unexpected: true }), "canvas"))
      .toThrow(/catalog is invalid/u);
  });

  it("makes every private command contract part of Bridge compatibility", () => {
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    const original = digest(extensionStableJson(extensionPrivateBridgeCompatibilityContract(extensionPrivateBridgeOperationContracts)));
    const changed = extensionPrivateBridgeOperationContracts.map((operation) => operation.toolName === "canvas_send_private_conversation"
      ? { ...operation, path: "/morrow/private/courses/{course_id}/changed" }
      : operation);
    const changedContract = digest(extensionStableJson(extensionPrivateBridgeCompatibilityContract(changed)));
    expect(changedContract).not.toBe(original);
    const outer = (privateCommands: string) => extensionStableJson(extensionBridgeCompatibilityContract(
      "a".repeat(64), "b".repeat(64), "c".repeat(64), privateCommands,
    ));
    expect(outer(original)).not.toBe(outer(changedContract));
  });

  it("matches the digest the connector requires in a Bridge hello", async () => {
    const root = resolve("../..");
    const runtime = await CanvasConnectorRuntime.start({
      statePath: ":memory:",
      catalogPath: resolve(root, "artifacts/canvas-api/canvas-api-catalog.json"),
      token: "bridge-catalog-digest-token-".repeat(3),
      port: 0,
      runtimeRevision: "1.0.0-rc.2",
      allowedExtensionIds: ["a".repeat(32)],
      approveExtensionId: async () => undefined,
    });
    runtimes.push(runtime);

    expect(bridgeCatalogDigestForTests(root)).toBe(runtime.catalogDigest);
  });
});
