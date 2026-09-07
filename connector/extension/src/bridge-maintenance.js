const ACTIVE_FOLDER_MARKER = "morrow-bridge-active-folder.json";
const CHALLENGE_SCHEMA = "morrow.bridge.active-folder-challenge.v1";
const PROOF_SCHEMA = "morrow.bridge.active-folder-proof.v1";
const STATUS_SCHEMA = "morrow.bridge.update-status.v1";
const QUIESCED_SCHEMA = "morrow.bridge.update-quiesced.v1";
const RESUMED_SCHEMA = "morrow.bridge.update-resumed.v1";
const READBACK_SCHEMA = "morrow.bridge.update-readback.v1";
const FENCE_SCHEMA = "morrow.bridge.quiesce-fence.v1";
const FENCE_KEY = "morrowBridgeQuiesceFence";
const RECEIPTS_KEY = "morrowBridgeMaintenanceReceipts";
const MAX_RECEIPTS = 2_000;
const MAX_MARKER_BYTES = 16 * 1024;
const EXTENSION_ID = /^[a-p]{32}$/;
const CHALLENGE_ID = /^[A-Za-z0-9._-]{16,128}$/;
const NONCE = /^[A-Za-z0-9._-]{16,512}$/;
const EPOCH = /^[A-Za-z0-9._-]{16,256}$/;
const OPERATION_ID = /^[A-Za-z0-9_.:-]{8,160}$/;
const EFFECT_RECEIPT_ID = /^[A-Za-z0-9_.:-]{1,160}$/;

export class BridgeMaintenanceError extends Error {
  constructor(code) {
    super(code);
    this.name = "BridgeMaintenanceError";
    this.code = code;
  }
}

function fail(code) {
  throw new BridgeMaintenanceError(code);
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\u0000") === [...keys].sort().join("\u0000");
}

function validVersion(value) {
  return typeof value === "string" && /^(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*)){0,3}$/.test(value);
}

function validInstallType(value) {
  return ["admin", "development", "normal", "sideload", "other"].includes(value);
}

function receipt(value) {
  return exactKeys(value, ["effectReceiptId", "operationId", "state"])
    && typeof value.operationId === "string" && OPERATION_ID.test(value.operationId)
    && typeof value.effectReceiptId === "string" && EFFECT_RECEIPT_ID.test(value.effectReceiptId)
    && (value.state === "pending" || value.state === "unknown");
}

function fence(value) {
  return exactKeys(value, ["extensionId", "manifestVersion", "quiesceEpoch", "schema"])
    && value.schema === FENCE_SCHEMA
    && typeof value.extensionId === "string" && EXTENSION_ID.test(value.extensionId)
    && validVersion(value.manifestVersion)
    && typeof value.quiesceEpoch === "string" && EPOCH.test(value.quiesceEpoch);
}

function maintenanceControl(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("bridge_maintenance_control_invalid");
  if ((value.action === "status" || value.action === "quiesce" || value.action === "readback")
    && exactKeys(value, ["action"])) return value;
  if (value.action === "resume" && exactKeys(value, ["action", "fileLayerRestored", "quiesceEpoch"])
    && value.fileLayerRestored === true && typeof value.quiesceEpoch === "string" && EPOCH.test(value.quiesceEpoch)) {
    return value;
  }
  fail("bridge_maintenance_control_invalid");
}

export function createBridgeMaintenance({ chromeApi = chrome, fetchImpl = fetch, randomUUID = crypto.randomUUID } = {}) {
  if (!chromeApi?.runtime?.getManifest || !chromeApi?.runtime?.getURL || !chromeApi?.storage?.local
    || !chromeApi?.management?.getSelf || typeof fetchImpl !== "function" || typeof randomUUID !== "function") {
    throw new TypeError("bridge maintenance requires Chrome runtime, storage, management, and fetch");
  }

  const activeWrites = new Map();
  let inMemoryFence = null;
  let storageQueue = Promise.resolve();

  function queueStorage(work) {
    const next = storageQueue.catch(() => undefined).then(work);
    storageQueue = next.catch(() => undefined);
    return next;
  }

  async function identity() {
    const manifest = chromeApi.runtime.getManifest();
    const extensionId = chromeApi.runtime.id;
    if (typeof extensionId !== "string" || !EXTENSION_ID.test(extensionId) || !validVersion(manifest?.version)) {
      fail("bridge_identity_unavailable");
    }
    let self;
    try { self = await chromeApi.management.getSelf(); } catch { fail("bridge_install_type_unavailable"); }
    if (!self || self.id !== extensionId || self.version !== manifest.version || !validInstallType(self.installType)) {
      fail("bridge_identity_unavailable");
    }
    return { extensionId, manifestVersion: manifest.version, installType: self.installType };
  }

  async function activeFolderProof(expected) {
    let response;
    try {
      response = await fetchImpl(chromeApi.runtime.getURL(ACTIVE_FOLDER_MARKER), { cache: "no-store" });
    } catch { fail("bridge_active_folder_unconfirmed"); }
    if (!response?.ok) fail("bridge_active_folder_unconfirmed");
    let bytes;
    try { bytes = new Uint8Array(await response.arrayBuffer()); } catch { fail("bridge_active_folder_unconfirmed"); }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_MARKER_BYTES) fail("bridge_active_folder_unconfirmed");
    let marker;
    try { marker = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { fail("bridge_active_folder_unconfirmed"); }
    if (!exactKeys(marker, ["challengeId", "extensionId", "manifestVersion", "nonce", "schema"])
      || marker.schema !== CHALLENGE_SCHEMA || marker.extensionId !== expected.extensionId
      || marker.manifestVersion !== expected.manifestVersion
      || typeof marker.challengeId !== "string" || !CHALLENGE_ID.test(marker.challengeId)
      || typeof marker.nonce !== "string" || !NONCE.test(marker.nonce)) {
      fail("bridge_active_folder_unconfirmed");
    }
    const challengeSha256 = await crypto.subtle.digest("SHA-256", bytes);
    const digest = [...new Uint8Array(challengeSha256)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return {
      schema: PROOF_SCHEMA,
      extensionId: expected.extensionId,
      manifestVersion: expected.manifestVersion,
      challengeId: marker.challengeId,
      nonce: marker.nonce,
      challengeSha256: digest,
    };
  }

  async function loadFence() {
    let stored;
    try { stored = await chromeApi.storage.local.get(FENCE_KEY); } catch { fail("bridge_quiesce_fence_unavailable"); }
    const value = stored?.[FENCE_KEY];
    if (value === undefined) return null;
    if (!fence(value)) fail("bridge_quiesce_fence_invalid");
    return value;
  }

  async function receiptLedger() {
    let stored;
    try { stored = await chromeApi.storage.local.get(RECEIPTS_KEY); } catch { fail("bridge_maintenance_receipts_unavailable"); }
    const values = stored?.[RECEIPTS_KEY] || [];
    if (!Array.isArray(values) || values.length > MAX_RECEIPTS || !values.every(receipt)
      || new Set(values.map((entry) => entry.operationId)).size !== values.length) {
      fail("bridge_maintenance_receipts_invalid");
    }
    return values.map((entry) => ({ ...entry }));
  }

  function writeBlocked() {
    return inMemoryFence !== null;
  }

  async function beginWrite({ operationId, effectReceiptId }) {
    if (!OPERATION_ID.test(operationId) || !EFFECT_RECEIPT_ID.test(effectReceiptId)) fail("bridge_maintenance_write_invalid");
    if (writeBlocked()) fail("bridge_update_quiesced");
    const persistedFence = await loadFence();
    if (writeBlocked() || persistedFence) fail("bridge_update_quiesced");
    if (activeWrites.has(operationId)) fail("bridge_maintenance_write_duplicate");
    activeWrites.set(operationId, effectReceiptId);
    try {
      await queueStorage(async () => {
        const entries = await receiptLedger();
        if (entries.some((entry) => entry.operationId === operationId || entry.effectReceiptId === effectReceiptId)) fail("bridge_maintenance_write_duplicate");
        await chromeApi.storage.local.set({ [RECEIPTS_KEY]: [...entries, { operationId, effectReceiptId, state: "pending" }] });
      });
    } catch (error) {
      activeWrites.delete(operationId);
      throw error;
    }
  }

  async function finishWrite(operationId, outcome) {
    const effectReceiptId = activeWrites.get(operationId);
    activeWrites.delete(operationId);
    if (!effectReceiptId) return;
    await queueStorage(async () => {
      const entries = await receiptLedger();
      const index = entries.findIndex((entry) => entry.operationId === operationId && entry.effectReceiptId === effectReceiptId);
      if (index < 0) fail("bridge_maintenance_receipts_invalid");
      const next = outcome === "unknown"
        ? entries.map((entry, entryIndex) => entryIndex === index ? { ...entry, state: "unknown" } : entry)
        : entries.filter((_, entryIndex) => entryIndex !== index);
      await chromeApi.storage.local.set({ [RECEIPTS_KEY]: next });
    });
  }

  async function status() {
    const current = await identity();
    const proof = await activeFolderProof(current);
    const persistedFence = await loadFence();
    return {
      schema: STATUS_SCHEMA,
      extensionId: current.extensionId,
      manifestVersion: current.manifestVersion,
      installType: current.installType,
      quiescent: Boolean(inMemoryFence || persistedFence),
      activeFolderProof: proof,
    };
  }

  async function quiesce() {
    if (inMemoryFence || activeWrites.size > 0) fail("bridge_quiesce_busy");
    const quiesceEpoch = `quiesce-${randomUUID()}`;
    if (!EPOCH.test(quiesceEpoch)) fail("bridge_quiesce_epoch_invalid");
    // This synchronous fence closes the admission race before every await below.
    inMemoryFence = { quiesceEpoch, state: "admitting" };
    try {
      if (await loadFence()) fail("bridge_quiesce_active");
      const entries = await receiptLedger();
      if (entries.some((entry) => entry.state === "pending" || entry.state === "unknown") || activeWrites.size > 0) {
        fail("bridge_quiesce_busy");
      }
      const current = await identity();
      if (current.installType !== "development") fail("bridge_store_install_refused");
      const proof = await activeFolderProof(current);
      const nextFence = { schema: FENCE_SCHEMA, extensionId: current.extensionId, manifestVersion: current.manifestVersion, quiesceEpoch };
      await chromeApi.storage.local.set({ [FENCE_KEY]: nextFence });
      inMemoryFence = nextFence;
      return {
        schema: QUIESCED_SCHEMA,
        extensionId: current.extensionId,
        manifestVersion: current.manifestVersion,
        installType: current.installType,
        quiescent: true,
        quiesceEpoch,
        activeFolderProof: proof,
      };
    } catch (error) {
      inMemoryFence = null;
      throw error;
    }
  }

  async function resume(control) {
    const request = maintenanceControl(control);
    if (request.action !== "resume") fail("bridge_maintenance_control_invalid");
    const persistedFence = await loadFence();
    if (!persistedFence || persistedFence.quiesceEpoch !== request.quiesceEpoch) fail("bridge_resume_epoch_stale");
    const current = await identity();
    if (current.extensionId !== persistedFence.extensionId || current.manifestVersion !== persistedFence.manifestVersion) {
      fail("bridge_resume_file_layer_unconfirmed");
    }
    await activeFolderProof(current);
    await chromeApi.storage.local.remove(FENCE_KEY);
    inMemoryFence = null;
    return {
      schema: RESUMED_SCHEMA,
      extensionId: current.extensionId,
      manifestVersion: current.manifestVersion,
      quiesceEpoch: persistedFence.quiesceEpoch,
      resumed: true,
    };
  }

  async function readback() {
    const current = await identity();
    if (current.installType !== "development") fail("bridge_store_install_refused");
    return {
      schema: READBACK_SCHEMA,
      extensionId: current.extensionId,
      manifestVersion: current.manifestVersion,
      installType: current.installType,
      activeFolderProof: await activeFolderProof(current),
    };
  }

  async function control(value) {
    const request = maintenanceControl(value);
    if (request.action === "status") return await status();
    if (request.action === "quiesce") return await quiesce();
    if (request.action === "resume") return await resume(request);
    return await readback();
  }

  return Object.freeze({ beginWrite, finishWrite, control, readback, resume, status });
}
