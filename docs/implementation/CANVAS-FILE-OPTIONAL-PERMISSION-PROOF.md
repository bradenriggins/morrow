# Canvas optional HTTPS file-access proof

This is a manual proof for the Canvas course-file content path. It uses an isolated Chrome for Testing profile and synthetic HTTPS Canvas and file-storage servers. It does not use a signed-in LMS account, a system Chrome profile, or a release archive.

## Current status

The final native Chrome for Testing proof passed on 2026-09-06 with a fresh release-manifest profile. The first course-site permission grant opened settings directly. It confirmed initial refusal, a native Chrome denial followed by refusal, a native Chrome allow with both the browser permission and local opt-in set, refusal for a different course ID, a selected-course cross-origin BOM-prefixed UTF-8 text read with no storage cookie, learner-token output without the fixture learner name, email, or verifier, and native removal followed by refusal. The final safe receipt is `output/canvas-file-permission-2026-09-06/native-permission-final-receipt.json`; the matching source inventory is `output/canvas-file-permission-2026-09-06/native-permission-final-source-inventory.json`. The evidence images are `output/canvas-file-permission-2026-09-06/native-optional-request.png` and `output/canvas-file-permission-2026-09-06/native-file-access-on.png`. That receipt predates the static `webRequest` permission for reviewed Canvas uploads. It does not prove the current manifest or the upload response observer.

Build the workspace before starting the proof:

```sh
pnpm build
node scripts/test/canvas-file-optional-permission-proof.mjs
```

The script opens Chrome for Testing and stops at three operator checkpoints. Type these exact terminal confirmations after each browser action: `course-ready`, `declined`, and `allowed`.

1. In the visible synthetic Canvas course tab, open the Morrow Bridge toolbar popup. Select **Connect course site** and allow the exact Canvas-site permission.
2. In Morrow Bridge Plan and Edit settings, decline the native Chrome request from **Enable course file access**.
3. Select **Enable course file access** again and allow the native Chrome request.

At each checkpoint, type the exact confirmation requested by the terminal. The script then uses the production settings page, course discovery and selection path, local connector source, and gateway privacy boundary. It confirms:

- The release manifest remains unchanged: loopback is the only required host permission and `https://*/*` remains optional.
- The file read is refused while the local opt-in or Chrome optional permission is absent.
- The settings page uses a real `chrome.permissions.request` decision for both decline and allow.
- A selected Canvas course can read one confirmed text file through a cross-origin fixture, without a file-storage cookie; a different course ID is refused first.
- The private source result preserves the fixture's UTF-8 BOM and has a SHA-256 that matches its returned UTF-8 text before learner redaction; the public gateway result is checked separately for redaction.
- Gateway output removes the fixture learner name and email, emits only a learner token, and excludes the download verifier.
- **Remove HTTPS file access** clears both controls and causes another refused read.

If setup stops before a checkpoint, the final JSON line reports only the proof stage, error class, harness source line, and whether it saved its receipt. It does not print the browser profile path, a connection token, cookies, or a download URL. The harness requires the Playwright Chrome for Testing executable; it rejects another browser executable before launch.

Each receipt has its timestamp, completed checkpoint names, release-manifest SHA-256, frozen critical extension-source SHA-256 values, final result, and a sanitized failure diagnostic when applicable. It contains no private path, profile, token, cookie, signed URL, or file content. For a durable receipt, set an absolute output directory and receipt path. Each run creates a new child directory for private temporary state.

```sh
MORROW_OPTIONAL_PERMISSION_PROOF_DIR=/tmp/morrow-canvas-proof \
MORROW_OPTIONAL_PERMISSION_PROOF_KEEP=1 \
MORROW_OPTIONAL_PERMISSION_PROOF_RECEIPT=/tmp/morrow-canvas-proof/canvas-file-optional-permission-receipt.json \
node scripts/test/canvas-file-optional-permission-proof.mjs
```

Without a supplied output directory or receipt path, the default cleanup also removes its temporary receipt. The retained directory contains temporary connector and browser state. Do not publish it. Start a new run with the same command when resuming the proof. The harness does not prove a real Canvas or file-storage host, a real learner roster, a reviewed Canvas upload, or a final package archive. It proves the optional HTTPS permission for Canvas file reads only. The static `webRequest` permission used to observe one reviewed upload response needs its separate browser-transfer proof.
