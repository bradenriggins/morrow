const { contextBridge, ipcRenderer } = require("electron");

const UPDATE_STATE_CHANNEL = "installer:update-state";

const METHODS = new Set([
  "installer:get-state",
  "installer:renderer-ready",
  "installer:choose-workspace",
  "installer:configure-blackboard",
  "installer:select-blackboard-courses",
  "installer:remove-blackboard-tenant",
  "installer:remove-blackboard-data",
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
  "installer:restore-bridge",
  "installer:remove-data"
]);

function invoke(method, args) {
  if (!METHODS.has(method)) return Promise.reject(new TypeError("Unsupported Morrow action."));
  if (args === undefined) return ipcRenderer.invoke(method);
  return ipcRenderer.invoke(method, args);
}

function subscribeUpdates(listener) {
  if (typeof listener !== "function") throw new TypeError("Morrow update listener must be a function.");
  const receive = (_event, snapshot) => listener(snapshot);
  ipcRenderer.on(UPDATE_STATE_CHANNEL, receive);
  return () => ipcRenderer.removeListener(UPDATE_STATE_CHANNEL, receive);
}

function rendererReady() {
  return ipcRenderer.invoke("installer:renderer-ready");
}

contextBridge.exposeInMainWorld("morrowInstaller", Object.freeze({ invoke, platform: process.platform, rendererReady, subscribeUpdates }));

// Electron ignores this export; installer/test/contract.test.cjs reads METHODS
// to prove it holds exactly the channels main.cjs registers.
module.exports = { METHODS, UPDATE_STATE_CHANNEL };
