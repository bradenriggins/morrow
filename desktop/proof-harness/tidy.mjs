// Cleanup, repeated until the sandbox stops changing. One pass can leave an object behind because
// a request for it was already waiting, so the sweep runs again and stops when a pass removes
// nothing more, rather than assuming one pass is enough.
import { execFileSync } from "node:child_process";

const here = new URL(".", import.meta.url).pathname;
let previous = Infinity;
for (let pass = 1; pass <= 6; pass += 1) {
  const output = execFileSync(process.execPath, [`${here}verify-clean.mjs`], { encoding: "utf8" });
  const after = Number(/"after":\s*(\d+)/.exec(output)?.[1] ?? "-1");
  console.log(`pass ${pass}: ${after} marked object(s) remain`);
  if (after === 0) break;
  if (after >= previous) { console.log("a pass removed nothing more; stopping"); break; }
  previous = after;
}
