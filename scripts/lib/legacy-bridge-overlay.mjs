export const LEGACY_BRIDGE_OVERLAY_FILES = Object.freeze([
  'morrow-gateway-bridge.js',
  'morrow-gateway-bridge-bindings.js',
  'morrow-gateway-bridge-protocol.js',
  'morrow-gateway-bridge-runtime.js',
]);

const IMPORT_BEGIN = '// MORROW_GATEWAY_BRIDGE_OVERLAY_IMPORT_BEGIN';
const IMPORT_END = '// MORROW_GATEWAY_BRIDGE_OVERLAY_IMPORT_END';
const CALL_BEGIN = '    // MORROW_GATEWAY_BRIDGE_OVERLAY_CALL_BEGIN';
const CALL_END = '    // MORROW_GATEWAY_BRIDGE_OVERLAY_CALL_END';

const IMPORT_BLOCK = `${IMPORT_BEGIN}\nimport { installMorrowGatewayBridge } from './morrow-gateway-bridge.js';\n${IMPORT_END}\n`;
const CALL_BLOCK = `${CALL_BEGIN}\n    installMorrowGatewayBridge({ readyPromise: startupBarrier });\n${CALL_END}\n`;

export function patchBackground(source) {
  if (typeof source !== 'string' || !source.trim()) throw new TypeError('background source is required');
  let output = source;
  if (!output.includes(IMPORT_BEGIN)) {
    const anchor = "import { recoverSignedCourseReadinessRootCheckpoint } from './domains/launch/course-health-journey.js';\n";
    if (!output.includes(anchor)) throw new Error('Morrow legacy background import anchor was not found');
    output = output.replace(anchor, `${anchor}${IMPORT_BLOCK}`);
  }
  if (!output.includes(CALL_BEGIN)) {
    const anchor = '    setupMessageRouter();\n';
    const matches = output.split(anchor).length - 1;
    if (matches !== 1) throw new Error('Morrow legacy setupMessageRouter anchor is missing or ambiguous');
    output = output.replace(anchor, `${anchor}${CALL_BLOCK}`);
  }
  return output;
}

export function unpatchBackground(source) {
  if (typeof source !== 'string') throw new TypeError('background source must be a string');
  const importPattern = new RegExp(`${escapeRegExp(IMPORT_BEGIN)}\\n[\\s\\S]*?${escapeRegExp(IMPORT_END)}\\n`, 'g');
  const callPattern = new RegExp(`${escapeRegExp(CALL_BEGIN)}\\n[\\s\\S]*?${escapeRegExp(CALL_END)}\\n`, 'g');
  return source.replace(importPattern, '').replace(callPattern, '');
}

export function renderLocalConfig({ url, token, donorRevision, catalogDigest }) {
  const normalized = {
    enabled: true,
    url: String(url || '').trim(),
    token: String(token || '').trim(),
    donorRevision: String(donorRevision || '').trim(),
    catalogDigest: String(catalogDigest || '').trim(),
  };
  const parsed = new URL(normalized.url);
  if (
    parsed.protocol !== 'ws:'
    || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname.toLowerCase())
    || parsed.pathname !== '/morrow-bridge/v1'
    || parsed.search
    || parsed.hash
  ) throw new Error('bridge URL must be a loopback ws:// URL ending in /morrow-bridge/v1');
  if (normalized.token.length < 32 || normalized.token.length > 512) {
    throw new Error('bridge token must contain 32 to 512 characters');
  }
  if (!normalized.donorRevision) throw new Error('donor revision is required');
  if (!/^[0-9a-f]{64}$/.test(normalized.catalogDigest)) {
    throw new Error('catalog digest must be a SHA-256 digest');
  }
  return `export const MORROW_GATEWAY_BRIDGE_CONFIG = Object.freeze(${JSON.stringify(normalized, null, 2)});\n`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
