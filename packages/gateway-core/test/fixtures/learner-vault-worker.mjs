import { access, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { LearnerVault } from "../../dist/privacy.js";

const [vaultPath, barrier, learnerId] = process.argv.slice(2);
if (!vaultPath || !barrier || !learnerId) throw new Error("learner vault worker arguments are required");

const scope = {
  canvasOrigin: "https://canvas.example.test",
  account: "1",
  course: "42",
  principal: "instructor:7",
  profile: "private-full",
};
const vault = new LearnerVault(vaultPath);
await writeFile(join(barrier, `ready-${basename(learnerId)}`), "ready\n", { flag: "wx" });
for (;;) {
  try {
    await access(join(barrier, "go"));
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const label = vault.tokenize(scope, { id: learnerId, name: `Learner ${learnerId}` });
process.stdout.write(`${JSON.stringify({ learnerId, label })}\n`);
