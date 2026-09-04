import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { isJsonObject } from "@morrow/contracts";

export interface CanvasConnectorConfig {
  readonly statePath: string;
  readonly catalogPath: string;
  readonly token: string;
  readonly port: number;
  readonly runtimeRevision: string;
  readonly allowedExtensionIds: readonly string[];
  readonly approveExtensionId: (extensionId: string) => Promise<void>;
}

interface ConnectorState {
  readonly schema: "morrow.canvas-connector.state.v1";
  readonly token: string;
  readonly port: number;
  readonly allowedExtensionIds: readonly string[];
}

function exactPort(value: unknown): number {
  const port = Number(value ?? 32147);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new TypeError("connector port is invalid");
  return port;
}

function exactIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !/^[a-p]{32}$/.test(entry))) {
    throw new TypeError("connector extension ids are invalid");
  }
  return [...new Set(value)].sort();
}

function parseState(value: unknown): ConnectorState {
  if (!isJsonObject(value) || value.schema !== "morrow.canvas-connector.state.v1") {
    throw new TypeError("connector state is invalid");
  }
  const token = String(value.token || "");
  if (token.length < 32 || token.length > 512) throw new TypeError("connector token is invalid");
  return {
    schema: "morrow.canvas-connector.state.v1",
    token,
    port: exactPort(value.port),
    allowedExtensionIds: exactIds(value.allowedExtensionIds),
  };
}

async function persist(path: string, state: ConnectorState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}

async function loadOrCreate(path: string): Promise<ConnectorState> {
  try {
    return parseState(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const state: ConnectorState = {
    schema: "morrow.canvas-connector.state.v1",
    token: randomBytes(48).toString("base64url"),
    port: 32147,
    allowedExtensionIds: [],
  };
  await persist(path, state);
  return state;
}

export async function loadCanvasConnectorConfig(
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): Promise<CanvasConnectorConfig> {
  const statePath = resolve(environment.MORROW_CANVAS_CONNECTOR_STATE || `${homedir()}/.morrow/canvas-connector.json`);
  const state = await loadOrCreate(statePath);
  const token = String(environment.MORROW_CANVAS_CONNECTOR_TOKEN || state.token).trim();
  if (token.length < 32 || token.length > 512) throw new TypeError("MORROW_CANVAS_CONNECTOR_TOKEN is invalid");
  const idsFromEnvironment = String(environment.MORROW_CANVAS_CONNECTOR_EXTENSION_IDS || "")
    .split(",").map((value) => value.trim()).filter(Boolean);
  const allowedExtensionIds = idsFromEnvironment.length > 0 ? exactIds(idsFromEnvironment) : state.allowedExtensionIds;
  const catalogPath = resolve(
    workingDirectory,
    environment.MORROW_CANVAS_CATALOG_PATH || "artifacts/canvas-api/canvas-api-catalog.json",
  );
  return {
    statePath,
    catalogPath,
    token,
    port: exactPort(environment.MORROW_CANVAS_CONNECTOR_PORT || state.port),
    runtimeRevision: String(environment.MORROW_CANVAS_CONNECTOR_REVISION || "1.0.0-rc.0").trim(),
    allowedExtensionIds,
    approveExtensionId: async (extensionId: string) => {
      const latest = await loadOrCreate(statePath);
      await persist(statePath, {
        ...latest,
        allowedExtensionIds: [...new Set([...latest.allowedExtensionIds, extensionId])].sort(),
      });
    },
  };
}
