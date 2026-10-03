# Installer dependency audit

The release gate keeps its moderate severity threshold. The installer has one
new narrowly scoped exception for [GHSA-ch52-4w7c-c8xp / CVE-2026-93748](https://github.com/advisories/GHSA-ch52-4w7c-c8xp),
reviewed on 2026-10-03. The advisory concerns disclosure from a shared HTTP
response cache. No patched package version exists as of this review.

The affected build dependency path is electron-builder 26.15.3 → app-builder-lib
→ @electron/get 3.1.0 → got 11.8.6 → cacheable-request 7.0.4 →
http-cache-semantics 4.2.0. Morrow supplies no HTTP response cache to this
downloader. The actual builder download path was exercised against a synthetic
loopback origin: two artifact and two checksum responses reached the origin,
and no HTTP cache was constructed. A positive control with an explicit HTTP
cache constructed one and served the second request from it. This distinguishes
HTTP response caching from the builder's filesystem artifact cache.

The application's production dependency closure excludes this chain. The full
bundled Node distribution also contains npm's copy of the affected package;
Morrow invokes Node directly and never runs npm, npx or corepack. The package
is therefore present in shipped bytes but is not reachable through Morrow's
current application or builder flows.

`test/dependency-cache-audit.test.cjs` guards the pinned lockfile chain, production
closure, workspace lock and download configuration. Review this exception at
every builder upgrade. Remove it when a patched http-cache-semantics release or
a supported stable builder using @electron/get 5 or later is available. A forced
major downloader override is not supported by the pinned builder's request
options. No root-workspace exception or broader audit suppression is permitted.

The release PR records the review and the dynamic proof receipt. The full local
and CI `pnpm check` must pass on the final release source.
