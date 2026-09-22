import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadCanvasApiCatalog } from "@morrow/canvas-api-catalog";
import { describe, expect, it } from "vitest";
import { createFullMorrowServer } from "../src/full-server.js";
import type { MorrowRuntime } from "../src/morrow-runtime.js";
import { MORROW_SERVER_INSTRUCTIONS } from "../src/server-instructions.js";

const catalog = loadCanvasApiCatalog(
  fileURLToPath(new URL("../../../artifacts/canvas-api/canvas-api-catalog.json", import.meta.url)),
);

/** The Canvas operation an assistant sees, taken from the generated catalog rather than restated here. */
function catalogTool(toolName: string) {
  const operation = catalog.operations.find((candidate) => candidate.toolName === toolName);
  if (!operation) throw new Error(`The Canvas catalog no longer carries ${toolName}.`);
  return {
    publicName: operation.toolName,
    upstreamId: "canvas-connector",
    upstreamName: operation.toolName,
    title: operation.summary,
    description: operation.description,
    inputSchema: operation.inputSchema,
  };
}

/**
 * Enough runtime for the Full tool surface to register. Registration reads the
 * catalog, the tool-surface setting and the batch scheduler and calls nothing,
 * so no upstream, journal or bridge is needed to see the tool list a client gets.
 */
function fullSurfaceRuntime(): MorrowRuntime {
  const gateway = {
    catalog: {
      digest: "a".repeat(64),
      tools: [
        catalogTool("canvas_item_bank_create_item"),
        catalogTool("canvas_item_bank_delete_entry"),
        catalogTool("canvas_item_bank_archive_bank"),
      ],
    },
    config: { toolSurface: "full", upstreams: [] },
  };
  return {
    gateway,
    batchScheduler: {},
    health: () => ({ ready: false, publicToolCount: 0 }),
  } as unknown as MorrowRuntime;
}

async function connectedFullSurface() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = serveStdio(() => createFullMorrowServer(fullSurfaceRuntime()), { transport: serverTransport });
  const client = new Client(
    { name: "morrow-server-instructions-test", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(clientTransport);
  const tools = (await client.listTools()).tools;
  const instructions = client.getInstructions();
  await client.close();
  await server.close();
  return { tools, instructions };
}

describe("MORROW_SERVER_INSTRUCTIONS", () => {
  it("states the product boundary and the non-replay rule early", () => {
    expect(MORROW_SERVER_INSTRUCTIONS.length).toBeGreaterThan(500);
    expect(MORROW_SERVER_INSTRUCTIONS.length).toBeLessThan(4_000);
    const opening = MORROW_SERVER_INSTRUCTIONS.slice(0, 512);
    expect(opening).toContain("local LMS operations layer");
    expect(opening).toContain("operation evidence");
    expect(opening).toContain("separate human review");
    expect(MORROW_SERVER_INSTRUCTIONS).toContain("sourceSettlement");
    expect(MORROW_SERVER_INSTRUCTIONS).toContain("Preserve each course's existing design");
    expect(MORROW_SERVER_INSTRUCTIONS).toContain("two or three representative sources");
    expect(MORROW_SERVER_INSTRUCTIONS).toContain("Make the smallest suitable edit");
    expect(MORROW_SERVER_INSTRUCTIONS).toContain("fixed LMS widths");
    expect(MORROW_SERVER_INSTRUCTIONS).toContain("metadata-only file is not a pass");
    expect(MORROW_SERVER_INSTRUCTIONS).toContain("inspected, manual, unread, blocked");
    expect(MORROW_SERVER_INSTRUCTIONS).toContain("Never enable or broaden Edit authority yourself");
    expect(MORROW_SERVER_INSTRUCTIONS).toContain("Loopback review links open only on that computer");
    expect(MORROW_SERVER_INSTRUCTIONS).toContain("client tool approval cannot");
    expect(MORROW_SERVER_INSTRUCTIONS).toContain("Never repeat a write");
    expect(MORROW_SERVER_INSTRUCTIONS).toContain("Do not ask for credentials, tokens, cookies, or passwords");
  });

  it("carries the New Quizzes and snapshot-bound Item Banks rules", () => {
    expect(MORROW_SERVER_INSTRUCTIONS).toContain(
      "New Quizzes, Item Banks, and Classic Quizzes are three different surfaces; an id from one names nothing in another.",
    );
    expect(MORROW_SERVER_INSTRUCTIONS).toContain(
      "morrow_read_item_bank_fan_out reports observed uses only and is not an authority grant.",
    );
    expect(MORROW_SERVER_INSTRUCTIONS).toContain(
      "A structural New Quiz item change is a delete and an add; morrow_plan_new_quiz_item_replacement plans that pair, and the pair is not atomic.",
    );
    expect(MORROW_SERVER_INSTRUCTIONS).toContain("Item Bank owner operations require the selected course");
    expect(MORROW_SERVER_INSTRUCTIONS).toContain("operation-specific readback");
  });
});

describe("Full Morrow tool surface", () => {
  it("lists every New Quizzes and Item Banks planner and hands the client the instructions", async () => {
    const { tools, instructions } = await connectedFullSurface();
    const names = tools.map((tool) => tool.name);
    // The lane's planners. A planner that is written but never registered is
    // unreachable, so this list is the surface, not the file count.
    expect(names).toContain("morrow_read_item_bank_fan_out");
    expect(names).toContain("morrow_plan_item_bank_question_image_alt_repair");
    expect(names).toContain("morrow_plan_new_quiz_item_create");
    expect(names).toContain("morrow_plan_new_quiz_item_replacement");
    expect(names).toContain("morrow_plan_new_quiz_item_delete");
    // The four guarded New Quiz alternative-text repairs share this surface.
    expect(names).toContain("morrow_plan_new_quiz_item_image_alt_repair");
    expect(names).toContain("morrow_plan_new_quiz_choice_image_alt_repair");
    expect(names).toContain("morrow_plan_new_quiz_answer_feedback_image_alt_repair");
    expect(names).toContain("morrow_plan_new_quiz_feedback_image_alt_repair");
    expect(instructions).toBe(MORROW_SERVER_INSTRUCTIONS);
  });

  it("describes the three Item Bank operations a person misreads", async () => {
    const { tools } = await connectedFullSurface();
    const description = (name: string) => tools.find((tool) => tool.name === name)?.description ?? "";
    expect(description("canvas_item_bank_create_item")).toContain(
      "This creates a standalone item. A separately reviewed attach_item operation adds it to the bank entries.",
    );
    expect(description("canvas_item_bank_create_item")).toContain(
      "A lost response cannot be reconciled without an item id because this private service exposes no standalone-item listing route.",
    );
    expect(description("canvas_item_bank_delete_entry")).toContain(
      "This removes the entry's association with the bank. It does not delete the standalone item object or the bank.",
    );
    expect(description("canvas_item_bank_archive_bank")).toContain("Delete one exact New Quizzes item bank");
    expect(description("canvas_item_bank_archive_bank")).toContain("saved-state result is bank absence");
  });
});
