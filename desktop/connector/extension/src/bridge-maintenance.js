const ACTIVE_FOLDER_MARKER = "morrow-bridge-active-folder.json";
const CHALLENGE_SCHEMA = "morrow.bridge.active-folder-challenge.v1";
const PROOF_SCHEMA = "morrow.bridge.active-folder-proof.v1";
const STATUS_SCHEMA = "morrow.bridge.update-status.v1";
const QUIESCED_SCHEMA = "morrow.bridge.update-quiesced.v1";
const RESUMED_SCHEMA = "morrow.bridge.update-resumed.v1";
const READBACK_SCHEMA = "morrow.bridge.update-readback.v1";
const COMMITTED_SCHEMA = "morrow.bridge.update-committed.v1";
const RELOAD_SCHEDULED_SCHEMA = "morrow.bridge.reload-scheduled.v1";
const RELOAD_DELAY_MS = 750;
const MAX_MANIFEST_BYTES = 64 * 1024;
const FENCE_SCHEMA = "morrow.bridge.quiesce-fence.v1";
const COMMIT_SCHEMA = "morrow.bridge.update-commit.v1";
const FENCE_KEY = "morrowBridgeQuiesceFence";
const COMMIT_KEY = "morrowBridgeMaintenanceCommit";
const RECEIPTS_KEY = "morrowBridgeMaintenanceReceipts";
const MAX_RECEIPTS = 2_000;
const MAX_MARKER_BYTES = 16 * 1024;
const ACTIVE_FOLDER_TIMEOUT_MS = 5_000;
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

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
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

function commitReceipt(value) {
  return exactKeys(value, ["extensionId", "manifestVersion", "previousManifestVersion", "quiesceEpoch", "schema"])
    && value.schema === COMMIT_SCHEMA
    && typeof value.extensionId === "string" && EXTENSION_ID.test(value.extensionId)
    && validVersion(value.manifestVersion) && validVersion(value.previousManifestVersion)
    && typeof value.quiesceEpoch === "string" && EPOCH.test(value.quiesceEpoch)
    && compareVersions(value.manifestVersion, value.previousManifestVersion) > 0;
}

function maintenanceControl(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("bridge_maintenance_control_invalid");
  if ((value.action === "status" || value.action === "quiesce" || value.action === "readback")
    && exactKeys(value, ["action"])) return value;
  if (value.action === "resume" && exactKeys(value, ["action", "fileLayerRestored", "quiesceEpoch"])
    && value.fileLayerRestored === true && typeof value.quiesceEpoch === "string" && EPOCH.test(value.quiesceEpoch)) {
    return value;
  }
  if (value.action === "reload" && exactKeys(value, ["action", "quiesceEpoch"])
    && typeof value.quiesceEpoch === "string" && EPOCH.test(value.quiesceEpoch)) return value;
  if (value.action === "commit" && exactKeys(value, ["action", "previousManifestVersion", "quiesceEpoch"])
    && validVersion(value.previousManifestVersion)
    && typeof value.quiesceEpoch === "string" && EPOCH.test(value.quiesceEpoch)) return value;
  fail("bridge_maintenance_control_invalid");
}

export function createBridgeMaintenance({ chromeApi = chrome, fetchImpl = fetch, randomUUID = () => crypto.randomUUID(), activeFolderTimeoutMs = ACTIVE_FOLDER_TIMEOUT_MS, scheduleReload = (reload) => setTimeout(reload, RELOAD_DELAY_MS) } = {}) {
  if (!chromeApi?.runtime?.getManifest || !chromeApi?.runtime?.getURL || !chromeApi?.storage?.local
    || !chromeApi?.management?.getSelf || typeof fetchImpl !== "function" || typeof randomUUID !== "function"
    || !Number.isSafeInteger(activeFolderTimeoutMs) || activeFolderTimeoutMs < 1) {
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
    const controller = new AbortController();
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(new Error("bridge_active_folder_unconfirmed"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), activeFolderTimeoutMs);
    let response = null;
    let reader = null;
    try {
      response = await Promise.race([
        fetchImpl(chromeApi.runtime.getURL(ACTIVE_FOLDER_MARKER), { cache: "no-store", redirect: "error", signal: controller.signal }),
        aborted,
      ]);
      if (!response?.ok) fail("bridge_active_folder_unconfirmed");
      const declaredLength = response.headers?.get?.("content-length");
      if (declaredLength !== null && declaredLength !== undefined
        && (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength) || Number(declaredLength) > MAX_MARKER_BYTES)) {
        try { const cancellation = response.body?.cancel?.("bridge_active_folder_unconfirmed"); if (cancellation?.catch) void cancellation.catch(() => {}); } catch {}
        fail("bridge_active_folder_unconfirmed");
      }
      if (!response.body?.getReader) fail("bridge_active_folder_unconfirmed");
      reader = response.body.getReader();
      const chunks = [];
      let length = 0;
      while (true) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        if (!(value instanceof Uint8Array)) fail("bridge_active_folder_unconfirmed");
        length += value.byteLength;
        if (length > MAX_MARKER_BYTES) {
          try { const cancellation = reader.cancel("bridge_active_folder_unconfirmed"); if (cancellation?.catch) void cancellation.catch(() => {}); } catch {}
          fail("bridge_active_folder_unconfirmed");
        }
        chunks.push(value);
      }
      if (length === 0 || controller.signal.aborted) fail("bridge_active_folder_unconfirmed");
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
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
      if (controller.signal.aborted) fail("bridge_active_folder_unconfirmed");
      const digest = [...new Uint8Array(challengeSha256)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      return {
        schema: PROOF_SCHEMA,
        extensionId: expected.extensionId,
        manifestVersion: expected.manifestVersion,
        challengeId: marker.challengeId,
        nonce: marker.nonce,
        challengeSha256: digest,
      };
    } catch (error) {
      if (error instanceof BridgeMaintenanceError) throw error;
      fail("bridge_active_folder_unconfirmed");
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", onAbort);
      if (controller.signal.aborted && reader) {
        try { const cancellation = reader.cancel("bridge_active_folder_unconfirmed"); if (cancellation?.catch) void cancellation.catch(() => {}); } catch {}
      }
      try { reader?.releaseLock(); } catch {}
    }
  }

  /**
   * The challenge id and secret in this Bridge folder's active-folder marker. Morrow wrote them
   * into the Bridge folder it set up, so a Bridge loaded from any other folder has none, and no
   * HTTP request can read them.
   */
  async function activeFolderSecret() {
    const current = await identity();
    const proof = await activeFolderProof(current);
    return { extensionId: current.extensionId, challengeId: proof.challengeId, nonce: proof.nonce };
  }

  async function loadFence() {
    let stored;
    try { stored = await chromeApi.storage.local.get(FENCE_KEY); } catch { fail("bridge_quiesce_fence_unavailable"); }
    const value = stored?.[FENCE_KEY];
    if (value === undefined) return null;
    if (!fence(value)) fail("bridge_quiesce_fence_invalid");
    return value;
  }

  async function loadCommit() {
    let stored;
    try { stored = await chromeApi.storage.local.get(COMMIT_KEY); } catch { fail("bridge_update_commit_unavailable"); }
    const value = stored?.[COMMIT_KEY];
    if (value === undefined) return null;
    if (!commitReceipt(value)) fail("bridge_update_commit_invalid");
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
    // Chrome Web Store installs do not contain the app-owned marker that binds
    // an unpacked development copy to Morrow's Bridge folder. Their signed
    // extension identity is sufficient for status only; every file-layer
    // maintenance action below remains limited to development installs.
    const proof = current.installType === "normal" ? null : await activeFolderProof(current);
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

  async function quiesce(beforeMutation) {
    if (inMemoryFence || activeWrites.size > 0) fail("bridge_quiesce_busy");
    const quiesceEpoch = `quiesce-${randomUUID()}`;
    if (!EPOCH.test(quiesceEpoch)) fail("bridge_quiesce_epoch_invalid");
    // This synchronous fence closes the admission race before every await below.
    inMemoryFence = { quiesceEpoch, state: "admitting" };
    try {
      if (await loadFence()) fail("bridge_quiesce_active");
      const entries = await receiptLedger();
      // An unknown receipt is durable evidence that Morrow must not replay that
      // write. Chrome keeps it across an unpacked-extension reload, so it does
      // not represent work that can still advance in this worker. Only a
      // pending or in-memory write must finish before the file layer changes.
      if (entries.some((entry) => entry.state === "pending") || activeWrites.size > 0) {
        fail("bridge_quiesce_busy");
      }
      const current = await identity();
      if (current.installType !== "development") fail("bridge_store_install_refused");
      const proof = await activeFolderProof(current);
      const nextFence = { schema: FENCE_SCHEMA, extensionId: current.extensionId, manifestVersion: current.manifestVersion, quiesceEpoch };
      await beforeMutation?.();
      await chromeApi.storage.local.set({ [FENCE_KEY]: nextFence });
      await chromeApi.storage.local.remove(COMMIT_KEY);
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

  async function resume(control, beforeMutation) {
    const request = maintenanceControl(control);
    if (request.action !== "resume") fail("bridge_maintenance_control_invalid");
    const persistedFence = await loadFence();
    if (!persistedFence || persistedFence.quiesceEpoch !== request.quiesceEpoch) fail("bridge_resume_epoch_stale");
    const current = await identity();
    if (current.installType !== "development") fail("bridge_store_install_refused");
    if (current.extensionId !== persistedFence.extensionId || current.manifestVersion !== persistedFence.manifestVersion) {
      fail("bridge_resume_file_layer_unconfirmed");
    }
    await activeFolderProof(current);
    await beforeMutation?.();
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

  async function commit(control, beforeMutation) {
    const request = maintenanceControl(control);
    if (request.action !== "commit") fail("bridge_maintenance_control_invalid");
    const current = await identity();
    if (current.installType !== "development") fail("bridge_store_install_refused");
    const proof = await activeFolderProof(current);
    const persistedFence = await loadFence();
    const existing = await loadCommit();
    if (!persistedFence) {
      if (!existing || existing.extensionId !== current.extensionId
        || existing.manifestVersion !== current.manifestVersion
        || existing.previousManifestVersion !== request.previousManifestVersion
        || existing.quiesceEpoch !== request.quiesceEpoch) fail("bridge_update_commit_stale");
    } else {
      if (persistedFence.extensionId !== current.extensionId
        || persistedFence.manifestVersion !== request.previousManifestVersion
        || persistedFence.quiesceEpoch !== request.quiesceEpoch
        || compareVersions(current.manifestVersion, persistedFence.manifestVersion) <= 0) {
        fail("bridge_update_commit_unconfirmed");
      }
      const nextCommit = {
        schema: COMMIT_SCHEMA,
        extensionId: current.extensionId,
        previousManifestVersion: persistedFence.manifestVersion,
        manifestVersion: current.manifestVersion,
        quiesceEpoch: persistedFence.quiesceEpoch,
      };
      await beforeMutation?.();
      await chromeApi.storage.local.set({ [COMMIT_KEY]: nextCommit });
      await chromeApi.storage.local.remove(FENCE_KEY);
      if (await loadFence()) fail("bridge_update_commit_unavailable");
      const stored = await loadCommit();
      if (!stored || stored.extensionId !== nextCommit.extensionId
        || stored.manifestVersion !== nextCommit.manifestVersion
        || stored.previousManifestVersion !== nextCommit.previousManifestVersion
        || stored.quiesceEpoch !== nextCommit.quiesceEpoch) fail("bridge_update_commit_unavailable");
    }
    inMemoryFence = null;
    return {
      schema: COMMITTED_SCHEMA,
      extensionId: current.extensionId,
      previousManifestVersion: request.previousManifestVersion,
      manifestVersion: current.manifestVersion,
      quiesceEpoch: request.quiesceEpoch,
      committed: true,
      activeFolderProof: proof,
    };
  }

  /** The version of the manifest now in the extension folder, which a staged update has replaced. */
  async function folderManifestVersion() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), activeFolderTimeoutMs);
    let reader = null;
    try {
      const response = await fetchImpl(chromeApi.runtime.getURL("manifest.json"), { cache: "no-store", redirect: "error", signal: controller.signal });
      if (!response?.ok || !response.body?.getReader) fail("bridge_reload_folder_unconfirmed");
      reader = response.body.getReader();
      const chunks = [];
      let length = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) fail("bridge_reload_folder_unconfirmed");
        length += value.byteLength;
        if (length > MAX_MANIFEST_BYTES) {
          try { const cancellation = reader.cancel("bridge_reload_folder_unconfirmed"); if (cancellation?.catch) void cancellation.catch(() => {}); } catch {}
          fail("bridge_reload_folder_unconfirmed");
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      let manifest;
      try { manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { fail("bridge_reload_folder_unconfirmed"); }
      if (!validVersion(manifest?.version)) fail("bridge_reload_folder_unconfirmed");
      return manifest.version;
    } catch (error) {
      if (error instanceof BridgeMaintenanceError) throw error;
      fail("bridge_reload_folder_unconfirmed");
    } finally {
      clearTimeout(timeout);
      try { reader?.releaseLock(); } catch {}
    }
  }

  /**
   * A staged update has replaced the files in this unpacked Bridge folder while the running Bridge
   * stays fenced. Chrome only loads the new files when the extension reloads, and asking a person to
   * find the extensions page is the step this removes. The reload is admitted only for the exact
   * quiesce epoch, only when the folder now holds a newer version of this same extension, and only
   * after the folder marker proves that newer version belongs to Morrow's own Bridge folder.
   */
  async function reload(control, beforeMutation) {
    const request = maintenanceControl(control);
    if (request.action !== "reload") fail("bridge_maintenance_control_invalid");
    const persistedFence = await loadFence();
    if (!persistedFence || persistedFence.quiesceEpoch !== request.quiesceEpoch) fail("bridge_reload_epoch_stale");
    const current = await identity();
    if (current.installType !== "development") fail("bridge_store_install_refused");
    if (current.extensionId !== persistedFence.extensionId || current.manifestVersion !== persistedFence.manifestVersion) {
      fail("bridge_reload_epoch_stale");
    }
    const nextManifestVersion = await folderManifestVersion();
    if (compareVersions(nextManifestVersion, current.manifestVersion) <= 0) fail("bridge_reload_not_newer");
    await activeFolderProof({ extensionId: current.extensionId, manifestVersion: nextManifestVersion });
    await beforeMutation?.();
    scheduleReload(() => chromeApi.runtime.reload());
    return {
      schema: RELOAD_SCHEDULED_SCHEMA,
      extensionId: current.extensionId,
      manifestVersion: current.manifestVersion,
      nextManifestVersion,
      quiesceEpoch: persistedFence.quiesceEpoch,
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

  async function control(value, { beforeMutation } = {}) {
    if (beforeMutation !== undefined && typeof beforeMutation !== "function") fail("bridge_maintenance_control_invalid");
    const request = maintenanceControl(value);
    if (request.action === "status") return await status();
    if (request.action === "quiesce") return await quiesce(beforeMutation);
    if (request.action === "resume") return await resume(request, beforeMutation);
    if (request.action === "commit") return await commit(request, beforeMutation);
    if (request.action === "reload") return await reload(request, beforeMutation);
    return await readback();
  }

  return Object.freeze({ activeFolderSecret, beginWrite, finishWrite, commit, control, readback, resume, status });
}
