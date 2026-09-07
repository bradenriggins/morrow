const { contextBridge, ipcRenderer } = require("electron");

const METHODS = new Set([
  "installer:get-state",
  "installer:choose-workspace",
  "installer:configure-blackboard",
  "installer:select-blackboard-courses",
  "installer:remove-blackboard-tenant",
  "installer:install-assistant",
  "installer:remove-assistant",
  "installer:reveal-bridge-folder",
  "installer:reconcile-bridge",
  "installer:check-for-updates",
  "installer:install-update",
  "installer:run-first-read",
  "installer:open-claude-desktop",
  "installer:reveal-claude-extension",
  "installer:repair",
  "installer:remove-data"
]);

function invoke(method, args) {
  if (!METHODS.has(method)) return Promise.reject(new TypeError("Unsupported Morrow action."));
  if (args === undefined) return ipcRenderer.invoke(method);
  return ipcRenderer.invoke(method, args);
}

contextBridge.exposeInMainWorld("morrowInstaller", Object.freeze({ invoke, platform: process.platform }));

// Electron ignores this export; installer/test/contract.test.cjs reads METHODS
// to prove it holds exactly the channels main.cjs registers.
module.exports = { METHODS };
