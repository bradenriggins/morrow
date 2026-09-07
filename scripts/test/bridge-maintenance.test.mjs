import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { BridgeMaintenanceError, createBridgeMaintenance } from "../../connector/extension/src/bridge-maintenance.js";

const EXTENSION_ID = "abeloclekioohahgedmjcdbpllfjfhko";
const VERSION = "1.0.2";
const CHALLENGE_ID = "paired-bridge-challenge-id";
const NONCE = "paired-bridge-nonce-for-test";

function marker(overrides = {}) {
  return Buffer.from(`${JSON.stringify({
    schema: "morrow.bridge.active-folder-challenge.v1",
    extensionId: EXTENSION_ID,
    manifestVersion: VERSION,
    challengeId: CHALLENGE_ID,
    nonce: NONCE,
    ...overrides,
  })}\n`, "utf8");
}

function fixture(options = {}) {
  const values = new Map(Object.entries(options.values || {}).map(([key, value]) => [key, structuredClone(value)]));
  const calls = [];
  const chromeApi = {
    runtime: {
      id: options.extensionId || EXTENSION_ID,
      getManifest: () => ({ version: options.version || VERSION }),
      getURL: (path) => `chrome-extension://${options.extensionId || EXTENSION_ID}/${path}`,
    },
    management: {
      getSelf: async () => ({
        id: options.selfId || options.extensionId || EXTENSION_ID,
        version: options.selfVersion || options.version || VERSION,
        installType: options.installType || "development",
      }),
    },
    storage: {
      local: {
        get: async (key) => ({ [key]: values.has(key) ? structuredClone(values.get(key)) : undefined }),
        set: async (next) => { for (const [key, value] of Object.entries(next)) values.set(key, structuredClone(value)); },
        remove: async (key) => { values.delete(key); },
      },
    },
  };
  const bytes = options.markerBytes || marker();
  const defaultFetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: options.markerOk !== false,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
  const fetchImpl = options.fetchImpl || defaultFetch;
  return {
    chromeApi,
    values,
    calls,
    create: () => createBridgeMaintenance({ chromeApi, fetchImpl, randomUUID: () => "12345678-1234-1234-1234-123456789abc" }),
  };
}

async function rejectsCode(callback, code) {
  await assert.rejects(callback, (error) => error instanceof BridgeMaintenanceError && error.code === code);
}

test("paired Bridge status returns an exact active-folder nonce proof without a filesystem path", async () => {
  const testFixture = fixture();
  const result = await testFixture.create().control({ action: "status" });
  assert.deepEqual(result, {
    schema: "morrow.bridge.update-status.v1",
    extensionId: EXTENSION_ID,
    manifestVersion: VERSION,
    installType: "development",
    quiescent: false,
    activeFolderProof: {
      schema: "morrow.bridge.active-folder-proof.v1",
      extensionId: EXTENSION_ID,
      manifestVersion: VERSION,
      challengeId: CHALLENGE_ID,
      nonce: NONCE,
      challengeSha256: createHash("sha256").update(marker()).digest("hex"),
    },
  });
  assert.deepEqual(testFixture.calls, [{
    url: `chrome-extension://${EXTENSION_ID}/morrow-bridge-active-folder.json`,
    init: { cache: "no-store" },
  }]);
  assert.equal(JSON.stringify(result).includes("folder"), true);
  assert.equal(JSON.stringify(result).includes("/Users/"), false);
});

test("wrong active-folder identity or malformed nonce proof is refused before quiescence", async () => {
  await rejectsCode(
    () => fixture({ markerBytes: marker({ extensionId: "a".repeat(32) }) }).create().control({ action: "status" }),
    "bridge_active_folder_unconfirmed",
  );
  await rejectsCode(
    () => fixture({ markerBytes: marker({ nonce: "short" }) }).create().control({ action: "quiesce" }),
    "bridge_active_folder_unconfirmed",
  );
});

test("Store-installed Bridge is refused without a broader management permission", async () => {
  const testFixture = fixture({ installType: "normal" });
  await rejectsCode(() => testFixture.create().control({ action: "quiesce" }), "bridge_store_install_refused");
  await rejectsCode(() => testFixture.create().control({ action: "readback" }), "bridge_store_install_refused");
});

test("pending and unknown write receipts block quiescence before any file-layer handoff", async () => {
  const testFixture = fixture();
  const maintenance = testFixture.create();
  await maintenance.beginWrite({ operationId: "operation:pending-write", effectReceiptId: "effect:pending-write" });
  await rejectsCode(() => maintenance.control({ action: "quiesce" }), "bridge_quiesce_busy");
  await maintenance.finishWrite("operation:pending-write", "known");
  await maintenance.beginWrite({ operationId: "operation:unknown-write", effectReceiptId: "effect:unknown-write" });
  await maintenance.finishWrite("operation:unknown-write", "unknown");
  await rejectsCode(() => maintenance.control({ action: "quiesce" }), "bridge_quiesce_busy");
});

test("quiesce installs its in-memory admission fence before waiting for the active-folder proof", async () => {
  let resolveFetch;
  const pendingFetch = new Promise((resolve) => { resolveFetch = resolve; });
  const testFixture = fixture({ fetchImpl: () => pendingFetch });
  const maintenance = testFixture.create();
  const quiescing = maintenance.control({ action: "quiesce" });
  await rejectsCode(
    () => maintenance.beginWrite({ operationId: "operation:blocked-during-quiesce", effectReceiptId: "effect:blocked-during-quiesce" }),
    "bridge_update_quiesced",
  );
  const bytes = marker();
  resolveFetch({ ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  await quiescing;
});

test("a durable quiesce fence blocks writes after service-worker restart and resumes only with its exact restored epoch", async () => {
  const testFixture = fixture();
  const firstWorker = testFixture.create();
  const quiesced = await firstWorker.control({ action: "quiesce" });
  await rejectsCode(
    () => firstWorker.beginWrite({ operationId: "operation:blocked-before-restart", effectReceiptId: "effect:blocked-before-restart" }),
    "bridge_update_quiesced",
  );
  const restartedWorker = testFixture.create();
  await rejectsCode(() => restartedWorker.control({ action: "quiesce" }), "bridge_quiesce_active");
  await rejectsCode(
    () => restartedWorker.beginWrite({ operationId: "operation:blocked-after-restart", effectReceiptId: "effect:blocked-after-restart" }),
    "bridge_update_quiesced",
  );
  await rejectsCode(
    () => restartedWorker.control({ action: "resume", quiesceEpoch: "quiesce-stale-epoch-value", fileLayerRestored: true }),
    "bridge_resume_epoch_stale",
  );
  assert.deepEqual(await restartedWorker.control({
    action: "resume",
    quiesceEpoch: quiesced.quiesceEpoch,
    fileLayerRestored: true,
  }), {
    schema: "morrow.bridge.update-resumed.v1",
    extensionId: EXTENSION_ID,
    manifestVersion: VERSION,
    quiesceEpoch: quiesced.quiesceEpoch,
    resumed: true,
  });
  await restartedWorker.beginWrite({ operationId: "operation:resumed-write", effectReceiptId: "effect:resumed-write" });
  await restartedWorker.finishWrite("operation:resumed-write", "known");
});

test("a resume refuses a swapped file layer until the app restores the exact quiesced Bridge", async () => {
  const testFixture = fixture();
  const oldWorker = testFixture.create();
  const quiesced = await oldWorker.control({ action: "quiesce" });
  testFixture.chromeApi.runtime.getManifest = () => ({ version: "1.0.3" });
  testFixture.chromeApi.management.getSelf = async () => ({ id: EXTENSION_ID, version: "1.0.3", installType: "development" });
  await rejectsCode(
    () => testFixture.create().control({ action: "resume", quiesceEpoch: quiesced.quiesceEpoch, fileLayerRestored: true }),
    "bridge_resume_file_layer_unconfirmed",
  );
});
