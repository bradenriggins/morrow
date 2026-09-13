import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (process.argv.includes("--descendant")) {
  process.on("SIGTERM", () => {});
  setInterval(() => undefined, 1_000);
} else {
  const pidPath = process.env.STUBBORN_PID_PATH;
  const signalPath = process.env.STUBBORN_SIGNAL_PATH;
  if (!pidPath || !signalPath) throw new Error("stubborn child fixture paths are required");

  const descendant = spawn(process.execPath, [fileURLToPath(import.meta.url), "--descendant"], { stdio: "ignore" });
  writeFileSync(pidPath, `${JSON.stringify({ parent: process.pid, descendant: descendant.pid })}\n`, "utf8");
  process.on("SIGTERM", () => appendFileSync(signalPath, "SIGTERM\n", "utf8"));
  process.stdin.resume();
  setInterval(() => undefined, 1_000);
}
