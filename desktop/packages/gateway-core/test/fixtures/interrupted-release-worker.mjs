import { linkSync, readFileSync } from "node:fs";
import { withExactPrivateStateFileTransaction } from "../../dist/private-state-file.js";

// Holds the transaction, publishes the exact release claim the owner would
// publish first, then dies before the lock name is unlinked.
const [path] = process.argv.slice(2);
if (!path) throw new Error("interrupted release worker path is required");
withExactPrivateStateFileTransaction(path, { label: "test state" }, () => {
  const lockPath = `${path}.transaction.lock`;
  const owner = JSON.parse(readFileSync(lockPath, "utf8"));
  linkSync(lockPath, `${lockPath}.release-${owner.nonce}`);
  process.stdout.write(`claimed ${owner.nonce}\n`);
  process.kill(process.pid, "SIGKILL");
});
