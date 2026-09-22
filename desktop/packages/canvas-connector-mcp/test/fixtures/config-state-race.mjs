import { access } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { loadCanvasConnectorConfig } from "../../dist/config.js";

const [statePath, extensionId, barrierPath] = process.argv.slice(2);
if (!statePath || !extensionId || !barrierPath) throw new Error("config state race arguments are required");

const config = await loadCanvasConnectorConfig({ MORROW_CANVAS_CONNECTOR_STATE: statePath }, process.cwd());
process.stdout.write(`${JSON.stringify({ phase: "ready", token: config.token })}\n`);

const deadline = Date.now() + 15_000;
for (;;) {
  try {
    await access(barrierPath);
    break;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    if (Date.now() >= deadline) throw new Error("config state race barrier timed out");
    await delay(10);
  }
}

await config.approveExtensionId(extensionId);
process.stdout.write(`${JSON.stringify({ phase: "done" })}\n`);
