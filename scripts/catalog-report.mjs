#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  buildSourceCatalog,
  mergeCatalog,
  parseCatalogAliasRules,
  parseSourceCatalog,
  reconcileCatalogs,
} from "../packages/gateway-core/dist/index.js";
import { RUNTIME_PROFILES, sha256Json } from "../packages/contracts/dist/index.js";

function argumentsValue(argv) {
  const sources = [];
  let aliases = resolve("config/catalog-aliases.proposed.json");
  let outputDirectory = "artifacts/catalogs";
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--source") {
      const value = argv[++index];
      if (!value) throw new Error("--source requires a path");
      sources.push(resolve(value));
    } else if (flag === "--aliases") {
      aliases = resolve(argv[++index] || "");
      if (!aliases) throw new Error("--aliases requires a path");
    } else if (flag === "--out-dir") {
      outputDirectory = resolve(argv[++index] || "");
      if (!outputDirectory) throw new Error("--out-dir requires a path");
    } else {
      throw new Error(`Unknown argument ${flag}`);
    }
  }
  if (sources.length === 0) {
    sources.push(resolve("artifacts/catalogs/example-legacy.canvas.json"));
    sources.push(resolve("artifacts/catalogs/meridian.live.json"));
  }
  if (sources.length < 2) throw new Error("At least two --source paths are required");
  return { sources, aliases, outputDirectory };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeAtomic(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function main() {
  const options = argumentsValue(process.argv.slice(2));
  const catalogs = await Promise.all(options.sources.map(async (path) => parseSourceCatalog(await readJson(path))));
  const aliases = options.aliases ? parseCatalogAliasRules(await readJson(options.aliases)) : [];
  const sources = catalogs.map((catalog, index) => ({
    id: catalog.source.id,
    label: catalog.source.label,
    priority: catalogs.length - index,
    ...(catalog.source.revision ? { revision: catalog.source.revision } : {}),
    tools: catalog.tools,
  }));
  const merged = mergeCatalog(sources);
  const rawParity = reconcileCatalogs(catalogs, {
    aliases,
    sourcePriority: catalogs.map((catalog) => catalog.source.id),
  });
  const held = (member) => /(^|[_-])(mindtap|connect)([_-]|$)/i.test(member.toolName)
    || ["mindtap", "connect"].includes(String(member.provider || "").toLowerCase());
  const parityRows = rawParity.rows.map((row) => row.members.some(held)
    ? { ...row, status: "rights_hold", selected: null, reviewRequired: false, reason: "Held provider excluded before collision resolution." }
    : row);
  const parity = {
    ...rawParity,
    rows: parityRows,
    counts: {
      ...rawParity.counts,
      reviewRequired: parityRows.filter((row) => row.reviewRequired).length,
      rightsHold: parityRows.filter((row) => row.status === "rights_hold").length,
    },
    digest: sha256Json({ ...rawParity, generatedAt: null, rows: parityRows }),
  };
  const acceptedRouting = parityRows.map((row) => ({
    canonicalName: row.publicName,
    state: row.status === "rights_hold" ? "rights_hold" : row.selected ? "supported" : "broken_at_baseline",
    ...(row.selected ? { backend: row.selected.sourceId, sourceToolName: row.selected.toolName } : {}),
    aliases: row.kind === "alias"
      ? row.members
        .filter((member) => member.toolName !== row.selected?.toolName)
        .map((member) => member.toolName)
        .sort()
      : [],
    reason: row.reason || (row.reviewRequired ? "Contract drift requires an explicit compatibility rule." : ""),
  }));
  const profileCounts = Object.fromEntries(RUNTIME_PROFILES.map((profile) => [profile, {
    supported: merged.tools.filter((tool) => tool.capability?.profiles[profile]?.state === "supported").length,
    unavailable: merged.tools.filter((tool) => tool.capability?.profiles[profile]?.state !== "supported").length,
  }]));
  const profileReport = {
    schema: "morrow.profile-report.v1",
    catalogDigest: merged.digest,
    sourceCatalogDigests: catalogs.map((catalog) => catalog.digest).sort(),
    counts: profileCounts,
  };
  const parityReport = {
    ...parity,
    catalogDigest: merged.digest,
    heldProviderCount: merged.excluded.filter((tool) => tool.reason === "held_provider").length,
    acceptedRouting,
  };
  const capabilityReport = {
    schema: "morrow.merged-capabilities.v1",
    digest: merged.digest,
    capabilities: merged.tools.map((tool) => tool.capability),
  };
  const acceptedAliases = acceptedRouting.flatMap((route) => route.aliases.map((alias) => ({
    alias,
    canonicalName: route.canonicalName,
    backend: route.backend,
  })));
  const unresolved = parityRows.filter((row) => row.reviewRequired);
  const markdown = [
    "# Catalog report",
    "",
    `Catalog digest: \`${merged.digest}\``,
    `Source tools: ${catalogs.reduce((total, catalog) => total + catalog.count, 0)}`,
    `Published capabilities: ${merged.tools.length}`,
    `Held provider rows: ${parityReport.heldProviderCount}`,
    `Parity rows: ${parity.counts.rows}`,
    `Alias groups: ${parity.counts.aliasGroups}`,
    `Contract drift rows: ${parity.counts.contractDrift}`,
    `Accepted routes: ${acceptedRouting.filter((route) => route.state === "supported").length}`,
    "",
    "## Profile counts",
    "",
    ...RUNTIME_PROFILES.map((profile) => `- ${profile}: ${profileCounts[profile].supported} supported, ${profileCounts[profile].unavailable} unavailable`),
    "",
  ].join("\n");
  await mkdir(options.outputDirectory, { recursive: true });
  await Promise.all([
    writeAtomic(resolve(options.outputDirectory, "merged-capabilities.json"), capabilityReport),
    writeAtomic(resolve(options.outputDirectory, "parity-report.json"), parityReport),
    writeAtomic(resolve(options.outputDirectory, "profile-report.json"), profileReport),
    writeAtomic(resolve(options.outputDirectory, "aliases.json"), { schema: "morrow.catalog-alias-output.v1", aliases: acceptedAliases }),
    writeAtomic(resolve(options.outputDirectory, "unresolved-collisions.json"), { schema: "morrow.catalog-unresolved.v1", rows: unresolved }),
    writeFile(resolve(options.outputDirectory, "catalog-report.md"), markdown, "utf8"),
    writeFile(resolve(options.outputDirectory, "parity-report.md"), markdown, "utf8"),
  ]);
  if (unresolved.length > 0) {
    throw new Error(`${unresolved.length} catalog collision rows require an explicit compatibility decision`);
  }
  process.stdout.write([
    `catalogDigest=${merged.digest}`,
    `capabilities=${merged.tools.length}`,
    `heldProviderRows=${parityReport.heldProviderCount}`,
    `parityDigest=${parity.digest}`,
    `profileReportDigest=${sha256Json(profileReport)}`,
    `wrote=${options.outputDirectory}`,
    "",
  ].join("\n"));
}

main().catch((error) => {
  process.stderr.write(`[morrow-catalog-report] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
