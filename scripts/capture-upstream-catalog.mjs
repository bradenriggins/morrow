#!/usr/bin/env node
import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildSourceCatalog } from "../packages/gateway-core/dist/index.js";
import { loadGatewayConfig } from "../packages/mcp-server/dist/config.js";
import { StdioMcpUpstream } from "../packages/upstream-mcp/dist/index.js";

function safeFileSegment(value) {
  const segment = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  if (!segment || segment.startsWith("-")) throw new Error(`Invalid source id for file output: ${value}`);
  return segment;
}

async function writeAtomic(path, value) {
  await mkdir(resolve(path, ".."), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function main() {
  const config = await loadGatewayConfig();
  const requestedSource = String(process.env.MORROW_CAPTURE_SOURCE || "").trim().toLowerCase();
  const outputDirectory = resolve(
    process.cwd(),
    String(process.env.MORROW_CATALOG_DIR || "artifacts/catalogs"),
  );
  const selected = requestedSource
    ? config.upstreams.filter((upstream) => upstream.id.toLowerCase() === requestedSource)
    : config.upstreams;
  if (selected.length === 0) throw new Error(`No configured upstream matches ${requestedSource}`);

  for (const source of selected) {
    const upstream = new StdioMcpUpstream({
      id: source.id,
      label: source.label,
      command: source.command,
      args: source.args,
      ...(source.cwd ? { cwd: source.cwd } : {}),
      env: source.env,
      priority: source.priority,
      required: true,
    });
    try {
      const tools = await upstream.connect();
      const artifact = buildSourceCatalog({
        id: source.id,
        label: source.label,
        kind: "mcp-stdio",
        ...(source.repository ? { repository: source.repository } : {}),
        ...(source.revision ? { revision: source.revision } : {}),
      }, tools);
      const path = resolve(outputDirectory, `${safeFileSegment(source.id)}.live.json`);
      await writeAtomic(path, artifact);
      process.stdout.write([
        `source=${artifact.source.id}`,
        `tools=${artifact.count}`,
        `digest=${artifact.digest}`,
        `wrote=${path}`,
        "",
      ].join("\n"));
    } finally {
      await upstream.close();
    }
  }
}

main().catch((error) => {
  process.stderr.write(`[morrow-catalog-capture] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
