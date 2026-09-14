import { writeFileSync } from "node:fs";

const pidPath = process.env.SILENT_UPSTREAM_PID_PATH;
if (!pidPath) throw new Error("SILENT_UPSTREAM_PID_PATH is required");

writeFileSync(pidPath, `${process.pid}\n`, "utf8");
process.stdin.resume();
setInterval(() => undefined, 1_000);
