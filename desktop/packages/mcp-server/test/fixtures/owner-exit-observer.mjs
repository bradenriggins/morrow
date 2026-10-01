import { existsSync, rmSync, writeFileSync } from "node:fs";

const root = process.env.MORROW_QA_OWNER_EXIT_ROOT;
const receipt = process.env.MORROW_QA_OWNER_EXIT_RECEIPT;
if (process.argv.includes("--morrow-local-owner") && root && receipt) {
  const exit = process.exit.bind(process);
  const once = process.once.bind(process);
  let prepared = false;
  process.exit = (code) => {
    if (!prepared) {
      prepared = true;
      rmSync(root, { recursive: true, force: true });
    }
    return exit(code);
  };
  process.once = (event, listener) => {
    if (event !== "exit" || !String(listener).includes("removeOwnerDescriptor")) return once(event, listener);
    return once(event, (...args) => {
      try { return listener(...args); }
      finally {
        writeFileSync(receipt, JSON.stringify({ schema: "morrow.owner-exit-cleanup.e2e.v1", observerSawOwnerCleanup: true, prepared, directoryRecreated: existsSync(root) }) + "\n");
      }
    });
  };
}
