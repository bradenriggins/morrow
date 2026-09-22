#!/usr/bin/env node
import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildSourceCatalog } from "../packages/gateway-core/dist/index.js";
import { loadGatewayConfig } from "../packages/mcp-server/dist/config.js";
import { buildExamplePlatformSshLaunch } from "../packages/mcp-server/dist/meridian-runtime-adapter.js";
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
    const launch = source.kind === "meridian-ssh"
      ? buildExamplePlatformSshLaunch({
          host: source.host,
          remoteRoot: source.remoteRoot,
          serverPath: source.serverPath,
          runtimeProfile: source.runtimeProfile,
        })
      : {
          command: source.command,
          args: source.args,
          ...(source.cwd ? { cwd: source.cwd } : {}),
          env: source.env,
        };
    const upstream = new StdioMcpUpstream({
      id: source.id,
      label: source.label,
      command: launch.command,
      args: launch.args,
      ...(source.kind === "mcp-stdio" && source.cwd ? { cwd: source.cwd } : {}),
      ...(source.kind === "mcp-stdio" ? { env: source.env } : {}),
      ...(source.kind === "meridian-ssh" ? { stderr: "ignore" } : {}),
      priority: source.priority,
      required: true,
    });
    try {
      const tools = (await upstream.connect()).map((tool) => {
        const provider = tool.name.startsWith("mindtap_")
          ? "mindtap"
          : tool.name.startsWith("connect_") ? "connect" : "canvas";
        return {
          ...tool,
          capability: {
            family: "canvas-operation",
            provider,
            sourceExport: "MCP tools/list",
            behavior: {
              readOnly: tool.annotations?.readOnlyHint === true,
              mutating: tool.annotations?.readOnlyHint !== true,
              destructive: tool.annotations?.destructiveHint === true,
            },
            authority: {
              scopeClass: "unknown",
              approvalClass: tool.annotations?.destructiveHint === true
                ? "destructive"
                : tool.annotations?.readOnlyHint === true ? "none" : "standard",
              dataClass: "unknown",
            },
            route: { backend: source.id === "meridian" ? "meridian" : "morrow-extension" },
            profiles: {
              "private-full": { state: "supported" },
              "public-canvas": { state: "rights_hold", reason: "Publication approval is not present in tools/list." },
              sandbox: { state: "profile_limited", reason: "No synthetic fixture is attached." },
              "read-only": tool.annotations?.readOnlyHint === true
                ? { state: "supported" }
                : { state: "profile_limited", reason: "Provider writes are disabled." },
            },
            evidence: {
              sourcePath: { state: "unknown", reason: "MCP tools/list does not expose donor module paths." },
              sourceExport: { state: "known" },
              sourceDigest: { state: "unknown", reason: "MCP tools/list does not expose module digests." },
              supportsDryRun: { state: "unknown", reason: "MCP tools/list does not expose dry-run support." },
              supportsReadback: { state: "unknown", reason: "MCP tools/list does not expose readback support." },
            },
          },
        };
      });
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
