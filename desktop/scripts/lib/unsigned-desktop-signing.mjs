import { isDeepStrictEqual } from "node:util";

/**
 * The signing record the packager writes into an unsigned desktop package receipt
 * (scripts/package-mcp-bundle.mjs). `--unsigned-release` builds the files a maintainer publishes and
 * `--unsigned-qa` builds the QA workflow's private artifacts. The packaging steps are the same, so
 * the application is the same; only this record differs.
 */
export function unsignedSigningState(target, { publicRelease }) {
  return publicRelease
    ? { mode: "unsigned_public_release", target, publicRelease: true, automaticUpdates: false }
    : { mode: "unsigned_private_qa", target, publicRelease: false };
}

/**
 * Whether `signing` is exactly one of the two unsigned records for `target`, with `additions` (the
 * Windows packager adds the checked Authenticode state). The installed-app smoke harnesses bind
 * either one, so the published files can be smoke-tested as well as the QA workflow's.
 */
export function isUnsignedPackageSigning(signing, target, additions = {}) {
  return [false, true].some((publicRelease) =>
    isDeepStrictEqual(signing, { ...unsignedSigningState(target, { publicRelease }), ...additions }));
}
