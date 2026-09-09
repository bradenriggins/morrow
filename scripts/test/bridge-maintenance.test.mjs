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

test("Store-installed Bridge reports signed status without reading an unpacked-folder marker", async () => {
  const testFixture = fixture({ installType: "normal" });
  const maintenance = testFixture.create();
  assert.deepEqual(await maintenance.control({ action: "status" }), {
    schema: "morrow.bridge.update-status.v1",
    extensionId: EXTENSION_ID,
    manifestVersion: VERSION,
    installType: "normal",
    quiescent: false,
    activeFolderProof: null,
  });
  assert.deepEqual(testFixture.calls, [], "Store status never reads an app-owned file");
  await rejectsCode(() => maintenance.control({ action: "quiesce" }), "bridge_store_install_refused");
  await rejectsCode(() => maintenance.control({ action: "readback" }), "bridge_store_install_refused");
  assert.deepEqual(testFixture.calls, [], "Store installs never enter file-layer maintenance");
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

test("a resume keeps the fence when the restored Bridge is no longer a development install", async () => {
  const testFixture = fixture();
  const quiesced = await testFixture.create().control({ action: "quiesce" });
  testFixture.chromeApi.management.getSelf = async () => ({ id: EXTENSION_ID, version: VERSION, installType: "normal" });
  const restartedWorker = testFixture.create();
  await rejectsCode(
    () => restartedWorker.control({ action: "resume", quiesceEpoch: quiesced.quiesceEpoch, fileLayerRestored: true }),
    "bridge_store_install_refused",
  );
  await rejectsCode(
    () => restartedWorker.beginWrite({ operationId: "operation:still-blocked", effectReceiptId: "effect:still-blocked" }),
    "bridge_update_quiesced",
  );
});

/**
 * Everything below is the Store-compatible status path. `status` is the one
 * control a Chrome Web Store Bridge is allowed to answer, so it is also the one
 * place where "this install is signed by the Store" must not become a way to
 * skip a check. An install source Morrow cannot read is not a Store install.
 */
test("an install source Morrow cannot read is refused, never treated as a Store install", async () => {
  const unreadable = fixture();
  unreadable.chromeApi.management.getSelf = async () => { throw new Error("management unavailable"); };
  await rejectsCode(() => unreadable.create().control({ action: "status" }), "bridge_install_type_unavailable");
  assert.deepEqual(unreadable.calls, [], "no marker is read for an install source Morrow could not read");

  for (const installType of [undefined, null, "", "normal ", "Normal", "store", "web_store", 1, true]) {
    const testFixture = fixture();
    testFixture.chromeApi.management.getSelf = async () => ({ id: EXTENSION_ID, version: VERSION, installType });
    await rejectsCode(() => testFixture.create().control({ action: "status" }), "bridge_identity_unavailable");
    assert.deepEqual(testFixture.calls, [], `${JSON.stringify(installType) ?? "undefined"} is not an install source`);
  }

  const absent = fixture();
  absent.chromeApi.management.getSelf = async () => null;
  await rejectsCode(() => absent.create().control({ action: "status" }), "bridge_identity_unavailable");
});

test("a Store install answers status only for this exact signed extension", async () => {
  await rejectsCode(
    () => fixture({ installType: "normal", selfId: "b".repeat(32) }).create().control({ action: "status" }),
    "bridge_identity_unavailable",
  );
  await rejectsCode(
    () => fixture({ installType: "normal", selfVersion: "9.9.9" }).create().control({ action: "status" }),
    "bridge_identity_unavailable",
  );
  const foreignId = fixture({ installType: "normal", extensionId: "not-a-chrome-extension-id" });
  await rejectsCode(() => foreignId.create().control({ action: "status" }), "bridge_identity_unavailable");
  const noVersion = fixture({ installType: "normal" });
  noVersion.chromeApi.runtime.getManifest = () => ({});
  await rejectsCode(() => noVersion.create().control({ action: "status" }), "bridge_identity_unavailable");
});

test("only a Store install skips the active-folder marker; every other install source still proves it", async () => {
  for (const installType of ["development", "admin", "sideload", "other"]) {
    const testFixture = fixture({ installType });
    const status = await testFixture.create().control({ action: "status" });
    assert.equal(status.installType, installType);
    assert.equal(status.activeFolderProof.challengeId, CHALLENGE_ID, `${installType} proves the active folder`);
    assert.equal(testFixture.calls.length, 1, `${installType} reads the app-owned marker`);
    await rejectsCode(
      () => fixture({ installType, markerOk: false }).create().control({ action: "status" }),
      "bridge_active_folder_unconfirmed",
    );
  }
});

test("a Store install reports its quiesce fence and refuses status when that fence cannot be trusted", async () => {
  const quiesced = fixture({
    installType: "normal",
    values: {
      morrowBridgeQuiesceFence: {
        schema: "morrow.bridge.quiesce-fence.v1",
        extensionId: EXTENSION_ID,
        manifestVersion: VERSION,
        quiesceEpoch: "quiesce-12345678-1234-1234",
      },
    },
  });
  const quiescedStatus = await quiesced.create().control({ action: "status" });
  assert.equal(quiescedStatus.quiescent, true);
  assert.equal(quiescedStatus.activeFolderProof, null);

  const damaged = fixture({ installType: "normal", values: { morrowBridgeQuiesceFence: { schema: "morrow.bridge.quiesce-fence.v1" } } });
  await rejectsCode(() => damaged.create().control({ action: "status" }), "bridge_quiesce_fence_invalid");

  const unreadable = fixture({ installType: "normal" });
  unreadable.chromeApi.storage.local.get = async () => { throw new Error("storage unavailable"); };
  await rejectsCode(() => unreadable.create().control({ action: "status" }), "bridge_quiesce_fence_unavailable");
});

test("status refuses a control Morrow did not send, whatever the install source is", async () => {
  for (const installType of ["normal", "development"]) {
    const maintenance = fixture({ installType }).create();
    await rejectsCode(() => maintenance.control({ action: "status", path: "/tmp/Bridge" }), "bridge_maintenance_control_invalid");
    await rejectsCode(() => maintenance.control({ action: "Status" }), "bridge_maintenance_control_invalid");
    await rejectsCode(() => maintenance.control(null), "bridge_maintenance_control_invalid");
  }
});
