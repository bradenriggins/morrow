import { removeLegacyBridgeOverlay } from './lib/legacy-bridge-removal.mjs';

const legacyRootValue = String(process.env.MORROW_LEGACY_ROOT || '').trim();
const result = await removeLegacyBridgeOverlay({
  legacyRootValue,
  expectedRevision: String(
    process.env.MORROW_LEGACY_EXPECTED_REVISION || '7275bfbc1c24dd6baff58f9435f1ce5a50fbb5d4',
  ).trim(),
});
process.stdout.write(`Morrow legacy bridge overlay removed from ${result.revision}.\n`);
