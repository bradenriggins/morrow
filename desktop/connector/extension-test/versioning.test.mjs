import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Minimal Chrome stub: only what service-worker.js touches at import plus the
// surfaces these tests drive. The worker never connects here (no stored token),
// so no WebSocket or catalog fetch is stubbed.
const listeners = new Map();
function event(name) {
  return { addListener: (fn) => { listeners.set(name, fn); } };
}
let manifestVersion = "1.0.134";
let reloads = 0;
let sessionValues = {};

globalThis.chrome = {
  runtime: {
    id: "a".repeat(32),
    getManifest: () => ({ version: manifestVersion }),
    getURL: (path) => `chrome-extension://test/${path}`,
    onStartup: event("onStartup"),
    onInstalled: event("onInstalled"),
    onMessage: event("onMessage"),
    onUpdateAvailable: event("onUpdateAvailable"),
    reload: () => { reloads += 1; },
    sendMessage: async () => undefined,
  },
  management: {
    getSelf: async () => ({ id: "a".repeat(32), version: manifestVersion, installType: "normal" }),
  },
  storage: {
    local: { get: async () => ({}), set: async () => undefined },
    session: { get: async () => sessionValues },
    onChanged: event("onChanged"),
  },
  permissions: { onAdded: event("onAdded") },
  alarms: { onAlarm: event("onAlarm") },
  tabs: { onRemoved: event("onRemoved"), onUpdated: event("onUpdated") },
};

const worker = await import("../extension/src/service-worker.js");

describe("extension version parsing", () => {
  it("accepts Chrome dotted versions and rejects anything else", () => {
    assert.equal(worker.parseExtensionVersion("1.0.134"), "1.0.134");
    assert.equal(worker.parseExtensionVersion("  9.9 "), "9.9");
    assert.equal(worker.parseExtensionVersion("1.0.0-rc.2"), null);
    assert.equal(worker.parseExtensionVersion(""), null);
    assert.equal(worker.parseExtensionVersion(null), null);
    assert.equal(worker.parseExtensionVersion(undefined), null);
    assert.equal(worker.parseExtensionVersion(134), null);
  });

  it("sends the manifest version in its handshake identity", () => {
    manifestVersion = "1.0.134";
    assert.deepEqual(worker.bridgeHandshakeVersions(), {
      runtimeRevision: "1.0.0-rc.2",
      extensionVersion: "1.0.134",
    });
    assert.equal(worker.extensionVersion(), "1.0.134");
  });

  it("omits the version report when the manifest is unreadable", () => {
    manifestVersion = "not a version";
    assert.deepEqual(worker.bridgeHandshakeVersions(), { runtimeRevision: "1.0.0-rc.2" });
    assert.equal(worker.extensionVersion(), null);
    manifestVersion = "1.0.134";
  });
});

describe("pairing refusal mapping", () => {
  it("maps a distinct pairing version mismatch to a reload", () => {
    assert.equal(
      worker.pairingRefusal({ status: 409 }, {
        error: "version_mismatch",
        expectedRuntimeRevision: "1.0.0-rc.2",
        receivedRuntimeRevision: "9.9.9",
      }),
      "bridge_version_mismatch",
    );
  });

  it("keeps mapping an old server's conflated refusal to a reload", () => {
    assert.equal(
      worker.pairingRefusal({ status: 403 }, { error: "connector_identity_refused" }),
      "bridge_version_mismatch",
    );
  });

  it("keeps the folder and generic refusal mappings", () => {
    assert.equal(
      worker.pairingRefusal({ status: 409 }, { error: "pairing_folder_unconfirmed" }),
      "bridge_pairing_folder_unconfirmed",
    );
    assert.equal(
      worker.pairingRefusal({ status: 403 }, { error: "extension_identity_refused" }),
      "bridge_pairing_folder_unconfirmed",
    );
    assert.equal(worker.pairingRefusal({ status: 500 }, null), "bridge_pairing_refused");
    assert.equal(worker.pairingRefusal({ status: 409 }, { error: "version_mismatch", extra: 1 }), "bridge_version_mismatch");
  });
});

describe("version mismatch close classification", () => {
  it("treats version, digest-drift, and protocol closes as mismatches", () => {
    assert.equal(worker.isBridgeVersionMismatchClose(4403, "bridge_version_mismatch"), true);
    assert.equal(worker.isBridgeVersionMismatchClose(4403, "bridge_bindings_digest_mismatch"), true);
    assert.equal(worker.isBridgeVersionMismatchClose(4406, "bridge_protocol_mismatch:expected=1,received=2"), true);
    assert.equal(worker.isBridgeVersionMismatchClose(4406, "bridge_protocol_mismatch"), true);
  });

  it("does not mistake other closes for mismatches", () => {
    assert.equal(worker.isBridgeVersionMismatchClose(4403, "bridge_identity_refused"), false);
    assert.equal(worker.isBridgeVersionMismatchClose(4401, "authentication_required"), false);
    assert.equal(worker.isBridgeVersionMismatchClose(4409, "bridge_owned_by_other_profile"), false);
    assert.equal(worker.isBridgeVersionMismatchClose(4406, "something_else"), false);
    assert.equal(worker.isBridgeVersionMismatchClose(1006, ""), false);
  });
});

describe("Store update reload quiescence", () => {
  const idle = {
    reviewsWaiting: 0,
    reviewCount: 0,
    inFlightCommands: 0,
    queuedWrites: 0,
    privateChatPending: false,
    approvalPresence: false,
    handshakeInFlight: false,
  };

  it("reloads only when every signal proves idle", () => {
    assert.equal(worker.updateReloadQuiescent(idle), true);
    for (const key of Object.keys(idle)) {
      const busy = { ...idle, [key]: typeof idle[key] === "number" ? 1 : true };
      assert.equal(worker.updateReloadQuiescent(busy), false, key);
    }
  });

  it("fails closed on unknown or malformed snapshots", () => {
    assert.equal(worker.updateReloadQuiescent(null), false);
    assert.equal(worker.updateReloadQuiescent(undefined), false);
    assert.equal(worker.updateReloadQuiescent({}), false);
    assert.equal(worker.updateReloadQuiescent({ ...idle, approvalPresence: null }), false);
    assert.equal(worker.updateReloadQuiescent({ ...idle, reviewsWaiting: -1 }), false);
  });

  it("observes Store updates and reloads while quiescent", async () => {
    assert.equal(typeof listeners.get("onUpdateAvailable"), "function");
    sessionValues = {};
    reloads = 0;
    await listeners.get("onUpdateAvailable")();
    await new Promise((done) => setTimeout(done, 25));
    assert.equal(reloads, 1);
  });
});
