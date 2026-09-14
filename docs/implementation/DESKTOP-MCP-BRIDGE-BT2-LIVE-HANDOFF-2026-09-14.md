# Desktop, MCP, Bridge, and BT2 live handoff, 2026-09-14

## Purpose

This handoff records the exact package, installed runtime, Bridge, and CHCP Canvas BT2 evidence for the `codex/desktop-mcp-bridge-triple-check-20260914` repair branch. It separates source and simulated proof from live Canvas provider proof.

## Exact target

- Machine: Braden's MacBook Air (`Bradens-MacBook-Air.local`, arm64).
- Source checkout: `/Users/Braden/Projects/.morrow-worktrees/desktop-mcp-bridge-triple-check-20260914`.
- Branch: `codex/desktop-mcp-bridge-triple-check-20260914`.
- Source base at package time: `18d81b97d16317d7407b373a69126b76f205fe60` plus the dirty source set sealed by the package input manifest.
- Canvas tenant: `https://chcp.instructure.com`.
- Required live course: BT2, Canvas course ID `89585`.
- Prohibited live proof without separate authority: grades and learner messages.

## Package and installed application

The final private-QA package is in `output/live-bt2-final-package-v17`.

| Artifact | SHA-256 |
| --- | --- |
| `Morrow-1.0.4-mac-arm64.dmg` | `2feb4e30d758d10d16d6fde57ae5bb74b04ed0c9726d128c37bbbbc879f5ff89` |
| `Morrow-1.0.4-mac-arm64.zip` | `e7aa1acbe4fa6edbf196779f19c12261962e18751b595e57900834f34701ac75` |
| Installed `/Applications/Morrow.app/Contents/Resources/app.asar` | `429c1c82175b5c87d7464f64995b429a95d6eed77b2ad253cd162dd05e582846` |
| MCP runtime manifest | `22e36378758a5f55e1b6ca82cfc221be3494698f175c1579e35ae7120c559a9d` |
| Package input manifest | `fb30690cc8fd1a871e95107531379ff41ac78f17e4470f7551de846ad8002b78` |
| Release graph | `d0333c6ec7d8d501615b4cd9e81ec897713b83b0f6cd2677dd0b130269c5dabc` |

`codesign --verify --deep --strict /Applications/Morrow.app` passed. This is an unsigned private-QA package for `darwin-arm64`; it is not a public signed or notarized release.

The previous installed app was preserved at `/Applications/Morrow.app.before-bt2-v17-20260914T223920Z`.

## Exact installed Bridge

The app-owned Bridge at `/Users/Braden/Library/Application Support/morrow-installer/Bridge` was repaired through the packaged v17 installer controller. The controller stopped the prior runtime under its maintenance protocol, replaced the stale same-version Bridge, verified the sealed release, restarted the runtime, and issued a new active-folder challenge.

| Fact | Verified value |
| --- | --- |
| Extension ID | `abeloclekioohahgedmjcdbpllfjfhko` |
| Extension version | `1.0.6` |
| Release manifest SHA-256 | `901ee38f8f2b8c9bf118ae772c37fd380fde379fc7f1e8ac5d1f1b295d670b20` |
| Extension manifest SHA-256 | `e0202b8b238f9b87247cba9a15a7602aa8e15f94b1417a0ae392625c98c919b4` |
| Sealed files | 98 |
| Installed files | 98 sealed files plus the active-folder marker |
| Pending update | none |

A recursive comparison found only the expected app-issued `morrow-bridge-active-folder.json` marker in the installed folder. The installed extension manifest, generated Canvas catalog, and `canvas-file-transfer.js` matched the sealed package byte for byte. Chrome was restarted after the replacement. The Bridge popup then reported `Morrow: Connected`, and Desktop `Check Bridge` changed the visible status to `Morrow Bridge is connected`.

## Installed MCP and Bridge health

The installed runtime was invoked through its public MCP stdio entry point in `/Applications/Morrow.app/Contents/Resources/MorrowPayload`.

At `2026-09-14T22:51:58.102Z`, the installed `morrow_health` response proved:

- gateway ready;
- Morrow kernel ready;
- Canvas connector process connected, ready, and catalog-attested;
- Bridge listening on loopback and connected as extension `abeloclekioohahgedmjcdbpllfjfhko`;
- zero active or uncertain provider-effect operations;
- zero active, inspection-required, or unsettled batches;
- approval server ready on loopback;
- public catalog digest `f2ab86ba04a8155300b2e826a5f85d1c30712e06a2111a0da5bb3ee066f4b9fa` with 581 public tools.

The current installed public catalog was collected through `morrow_catalog_search` and `morrow_capability_get` at `2026-09-14T22:51:44.605Z`:

| Surface | Count |
| --- | ---: |
| Public tools | 581 |
| Published Canvas capabilities | 328 |
| Published Canvas reads | 215 |
| Published Canvas writes | 113 |
| Published media-upload credential minting route | 0 |

The provider session catalog contains 1,392 Canvas operations. The MCP publishes the governed subset above through the capability interface.

## BT2 state before login

The exact installed capability call `morrow_capability_read(name: morrow_canvas_bindings)` returned one BT2 binding:

- course ID `89585`;
- tenant origin `https://chcp.instructure.com`;
- source binding ID `canvas:5381de17df52cb77eb87:g8:c89585`;
- Bridge catalog digest `8c1fa4e3fcb7fdadbde9a48eb131c1f5b2c3c93b9431c2d4ae50bd50835106ff`;
- Edit policy revision `0`;
- Edit options available;
- `runtimeVerified: false`.

The binding is not current provider proof while Canvas is logged out. Chrome is open at the CHCP Canvas login form. No BT2 provider read or write has been claimed from this state.

## Source verification already completed

The final source state that produced v17 passed these checks before packaging:

- native Canvas Bridge browser gate, including pairing, restart, course discovery, permissions, private chat, text and document reads, file transfer, concurrent upload isolation, action filtering, pagination, section, group, file, calendar, bulk-date writes, cancellation, render checks, Classic Quiz repair, tab loss, and disconnect;
- MCP server suite: 116 files and 693 tests;
- script suite: 927 tests passed except one intentional skip;
- Desktop suite: 408 tests passed and one Windows-only skip;
- Desktop update suite: 7 tests;
- gateway privacy suite: 49 tests;
- New Quiz and Item Bank conformance: 2 tests;
- Canvas connector runtime suite: 65 tests;
- dependency audits with no known vulnerabilities;
- generated artifact checks and `git diff --check`.

These checks prove local contracts and simulated browser behavior. They do not replace the live BT2 provider matrix below.

## Live BT2 read matrix

Status: **blocked on CHCP Canvas login**.

The installed v17 harness is `output/live-bt2-final-package-v17/live-proof/run-installed-canvas-read-matrix.mjs`. It requires one exact current BT2 binding with `runtimeVerified: true`, invokes every published Canvas read through `morrow_capability_read`, redeems paged result artifacts, records provider status and send state, and writes both partial and final receipts.

A pre-login run stopped before its first Canvas capability call with `BT2 has no exact current Canvas binding`. This is the required fail-closed result for the current `runtimeVerified: false` binding.

After login, run it only after the Bridge has selected BT2 and the installed bindings call proves exactly one current `runtimeVerified: true` binding for course `89585`.

Final result: **pending**.

## Live BT2 write matrix

Status: **not started**.

Before any write, open the Bridge Plan and Edit settings for BT2 and inspect the current 125 Canvas choices. Saving one-hour Edit access changes the extension's permission state and needs explicit action-time confirmation. Current catalog policy has:

- 125 choices for one Canvas course;
- 9 curated choices;
- 116 derived choices;
- 112 derived ordinary Edit choices;
- 4 derived Review-only choices;
- 28 destructive choices, of which 24 can be enabled for Edit;
- 29 choices that require field selection.

Two learner accommodation writes remain held for separate learner authority:

- `canvas_set_course_level_accommodations`;
- `canvas_set_quiz_level_accommodations`.

The live matrix must use Morrow-created disposable BT2 fixtures. Each admitted route must pass through `morrow_capability_change`, the approval surface, and `morrow_operation_dispatch`. Each write needs a fresh authoritative Canvas readback, a replay-refusal check, and verified cleanup. Do not use grades or learner messages.

Final result: **pending**.

## Live-proof artifacts

Current v17 proof files are under `output/live-bt2-final-package-v17/live-proof`:

- `supported-catalog.json`;
- `canvas-capability-descriptors.json`;
- `morrow-health-prelogin.json`;
- `canvas-health-prelogin.json`;
- `canvas-bindings-prelogin.json`;
- `collect-installed-canvas-capabilities.mjs`;
- `call-installed-full.mjs`;
- `run-installed-canvas-read-matrix.mjs`.

Add the post-login binding, complete read matrix, write plans, approval receipts, dispatch receipts, authoritative readbacks, replay refusals, and cleanup readbacks here. Every receipt must name course `89585` and the exact current source binding.

## Required remaining work

1. Complete CHCP Canvas login in the open Chrome tab.
2. Open BT2 course `89585` and select it in Morrow Bridge.
3. Prove one exact `runtimeVerified: true` BT2 binding through installed MCP.
4. Run and classify all 215 published Canvas reads. Repair any product defect and rerun its regression before continuing.
5. Inspect the current BT2 Plan and Edit choices. Obtain explicit action-time confirmation immediately before saving one-hour Edit access.
6. Run the finite disposable-fixture write matrix across all admitted write families. Record plan, approval, dispatch, authoritative readback, replay refusal, and cleanup.
7. Update this handoff and `DEFECT-ERADICATION-LEDGER.md` with every verified live defect and root fix.
8. If live work changes source, rerun the focused regression and the required broad gates, inspect the result, and rebuild the final package.
9. Commit the full authorized repair set.
10. Push `codex/desktop-mcp-bridge-triple-check-20260914` to `origin` and verify the exact remote SHA with `git ls-remote`.

The work is not complete until every row above has direct evidence.
