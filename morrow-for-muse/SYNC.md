# SYNCED MIRROR — 0.4.6

- Synced 2026-09-27 from the installed 0.4.6 tree at ~/workspace/skills/morrow-canvas.
- `morrow-for-muse/` is now an exact content copy of that tree (0.4.6 snapshot).
- This mirror is authoritative for 0.4.6.
- Replaces the removed `STALE-MIRROR.md` (0.3.0 marker).
- Source provenance/version files from the installed tree (e.g. `VERSION`, `.morrow-tree-id`, `LICENSE`) are kept as-is.

## Exclusions (2026-09-27)
- helper/profile/ (28MB live Chromium profile, runtime state created by the
  installer via mkdir -p -m 0700; not source) was removed before commit:
  GitHub push protection flagged a false-positive AWS-key pattern in a
  browser cache file, and runtime browser state does not belong in source.
- __pycache__/ directories (Python bytecode from the installed tree) were
  removed for the same reason.
