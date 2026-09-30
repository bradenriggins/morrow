# Reusable private Muse sign-in card

Build or update the card through Muse's current native artifact workflow.
Use [MUSE-SETUP.md](MUSE-SETUP.md) for private access, actions, and owner-visible
verification. Derive configuration from the exact installed tree before the
build. Do not copy another installation's host, path, UUID, profile, or port.
The release ZIP is shared code; these values belong to each private card.

## Resolve the installed configuration

Read only the needed fields. Never print the complete environment or token.

| Field | Authoritative source |
|---|---|
| Tree path | Real path of the installed connector tree. |
| Tree UUID | `config.paths.read_tree_uuid(tree_path)`, from `.morrow-tree-id`. Require a valid installed UUID; it is not in the carve manifest. |
| State directory | `transport.local_chromium.tree_state_dir(tree_path)` in the helper's configured environment. Honor `MORROW_TREE_STATE_DIR`, then `MORROW_HOME`; require its `tree_path` binding to match the exact tree. |
| Canvas origin | `config.tree_config.canvas_base()` normalized with `normalize_tenant_base()`. Custom approved HTTPS origins are supported; do not assume an `instructure.com` hostname. |
| Profile | Effective `LOGIN_HELPER_PROFILE_DIR` from the helper's launch configuration; default `<tree>/helper/profile`. Compare real paths. |
| Helper port | `config.tree_config.helper_port()` in the helper's configured environment. Keep transport on the exact loopback listener. |
| CDP identity | Effective `LOGIN_HELPER_CDP_PORT`, default 19223. This is an identity label and forwarder allocation input, not a TCP debugging endpoint. Chromium uses a private pipe. |
| Version | Installed `VERSION`; require `/status.helper_version` to match it. |
| Home for `~/` display | The home used by the helper that abbreviates `/status.profile_dir`. Establish it from the existing helper launch configuration. Do not assume the artifact process has the same home. |

The configuration resolver's order is explicit environment, this tree's
`helper/env`, then legacy `<MORROW_HOME>/env` for Canvas only. Do not guess
settings from a port that happens to answer. Do not invent an installer
manifest or a saved-home field: the current installer does not provide them.
When a display path starts with `~/`, expand it against the established helper
home before checking the real path. An unknown home or a different directory
must fail closed. Preserve the bound tree and version check on every action.

## Client behavior

Use the [ordered input contract](README.md#ordered-private-input). One native
request sends a text batch. Control keys are paired on the server. One queue
orders text, keys, pointer, wheel, and navigation. Pause screenshot polling
while input is pending, then fetch a current frame. Handle composition/IME,
paste, mobile delete, Tab/Enter, selection, focus changes, and explicit recovery.
A missing batch endpoint requires a backend update; do not fall back to
unordered per-key requests. Never persist input or show plaintext password
echo. A failed or unconfirmed operation is not a successful input.

Choose the initial zoom from the actual image-to-pane scale. A fixed 150% of
a very small fitted image still makes text unreadable. Aim for one screenshot
pixel per CSS pixel at first load, with visible zoom in/out, Fit, and Expand.
Keep the sign-in form in view, allow pan/scroll, and support narrow panes,
pinch, and double-tap. Derive pointer coordinates from current image bounds
and the zoom/pan transform. A pan or zoom gesture must not also click a field.
Respect a zoom the user has chosen instead of resetting it on each frame.

Keep queued values, frames, and acknowledgement state transient. Clear pending
values after acknowledgement, error, navigation, or unmount. On a restart or
partial unknown outcome, stop the queue and show a new frame before the user
chooses to resume. Do not automatically replay text into a changed focus.

## Evidence required from the build

- Current native artifact status confirms interactive, unpublished access.
- Exact helper identity matches. Wrong tree/profile/version and helper-down
  cases show recovery and expose no frame or control.
- An isolated dummy page proves ordered typing, paste, composition, mobile
  delete, Tab/Enter, selection, pointer mapping, retry, and restart behavior.
- Desktop and narrow after-screenshots show a readable initial view. Pointer
  checks pass at Fit, initial zoom, manual zoom, and after panning.
- Measured input acknowledgement and frame latency distinguish browser input,
  platform action transport, and visual refresh. Never log credential values.
- The owner can use the real private card, then complete an admitted course
  read. A builder handoff or isolated browser test alone is not this proof.
