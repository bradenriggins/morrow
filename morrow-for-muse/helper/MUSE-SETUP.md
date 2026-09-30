# Private Canvas sign-in in Muse

The helper runs inside the Muse VM. Its `127.0.0.1` address does not
refer to that VM when opened directly on the educator's Mac or phone.
Show the educator a private Muse artifact card with remote browser
controls. Do not send a bare localhost address as the Muse setup path.

## Platform boundary

Muse's `~/docs/artifacts.md` states that unpublished artifacts are
accessible only to the user who created them. Keep the sign-in artifact
interactive and unpublished. Never publish a snapshot of a sign-in page.
Use Muse's native artifact namespace for its actions; there is no separate
public action URL. Do not implement a second owner gate with invented
`ctx.viewer.isOwner`, `viewerFbid`, or `ownerFbid` fields. Muse does not
document supplying those fields. Caller-supplied identity is not proof.
If the current platform cannot provide private artifact access and native
action routing, stop and explain that limit. Never substitute a public
proxy or disable helper authentication.

For an existing artifact, use `artifact.inspect` to diagnose it and
`artifact.edit` to change it. Do not edit artifact files directly or
create a replacement over the existing artifact. For a new connection,
create one private interactive artifact using the current Muse artifact
skill. Read `artifact.status`, require `share.shared=false`, and present
its `card.widget_id` through `widget.present`. An unpublished artifact
has no public URL; never assemble one.

Read the [reusable card contract](ARTIFACT-CONTRACT.md) before creating or
updating the card. It specifies the actual configuration sources and readable
initial zoom; shared package code must not embed one account's values.

## Connect the exact helper

1. Activate the runtime environment from `INSTALL.md` Step 2.
2. Read this connector's `helper/env` through `config.tree_config`.
   Use its helper port, Canvas address, and profile. The default port is
   8901; an existing install can use another port. Never use a different
   helper merely because it answers.
3. Check `/status`. Normalize its `~/` profile spelling against the installed
   home, then compare real paths with the configured profile. A spelling change
   is not a different profile; a different directory must still fail closed.
   Verify the tree ID and state-directory binding. Require `helper_version` to match `VERSION`, the
   configured profile to match, `chromium_alive=true`, and
   `starting=false`. A missing helper or mismatch needs a clear retry or
   repair message. A Chrome error page or blank page is not a usable
   sign-in page, even when Chromium is alive. Show the connection error
   and a retry control. Do not show a stale frame as connected.
   Compare `/status.canvas_origin` with the configured Canvas origin, including
   scheme and port. Keep that identity separate from the current page URL:
   Canvas can redirect sign-in to an external HTTPS school identity provider.
   Show its current host without counting it as signed-in Canvas. A missing or
   mismatched configured origin blocks controls and requires update or repair.
4. Proxy only the sign-in controls through private native artifact
   actions: status, screenshot, ordered input batches, mouse, wheel, and navigation to the
   configured Canvas address. Use the installed
   `transport.local_chromium._helper_request` on the server side. It
   supplies the helper authentication from the protected tree state.
   Never send a launch token to the artifact client, arguments, chat,
   logs, or an external service. Never expose arbitrary CDP evaluation
   or arbitrary HTTP forwarding as an artifact action.
   Open Canvas returns to the configured Canvas origin root so the school's
   normal SSO flow runs. Do not force the local-password `/login/canvas` route.
5. Use the [input batch contract](README.md#ordered-private-input). Coalesce
   ordinary text briefly and send it once with `Input.insertText`; paired
   control keys are ordered on the server. Coalesce unsent text while a native
   call is in flight so normal typing does not queue one call per character.
   Keep dispatched payloads immutable. Use one queue for text, control
   keys, pointer, and navigation. Flush text before a focus change. Support
   paste, composition/IME, mobile backspace, Tab, Enter, selection, and blur.
   An ambiguous response may retry only the identical sequence and payload.
   A restart or uncertain partial outcome stops input and requires a fresh
   frame and deliberate resumption. Every failed or throwing ordered operation
   also stops queued input and pointer actions. Keep Resume input visible after
   healthy frames. Before resuming, verify fresh status and a frame/layout from
   the same current epoch; otherwise keep input blocked. Never silently replay
   it into a new field.
   Keep frames and input transient; do not save or log typed values. Never
   show plaintext password echo in an intermediate relay field. Pause frame
   polling while input is pending and refresh after acknowledgement.
6. Show a readable initial sign-in view, visible zoom in/out and Fit controls,
   and an expanded view. Support zoom/pan and narrow panes. Map pointer
   positions through the actual image bounds and zoom transform. A touch
   gesture that zooms or pans must not also click the remote form. Show input
   errors and pending acknowledgement clearly; never mark unconfirmed input
   as sent. Clear stale frames after a disconnect or identity mismatch.
7. Let the educator enter their own credentials and complete SSO/MFA.
   The assistant does not enter, inspect, echo, or retain them. Check
   `/status` afterward, pin the account, and confirm its name with the
   educator before course work. Keep Plan as the default; sign-in does
   not grant Edit.

Outside Muse, an owner who can reach the VM privately can use
`bin/morrow page-link`. It mints a single-use helper page code with a
10-minute lifetime. Keep that link private, never log it, and mint a new
one when spent. It does not make VM localhost reachable on another device.

## Check before declaring setup complete

- The signed-in owner opens the private card and sees a current frame.
- On an isolated dummy page, typing, paste, IME, mobile delete, Tab/Enter,
  selection, pointer, and scrolling work in order. Record round-trip and
  visual latency without credential values. Test identical retry, delayed
  acknowledgement, helper restart, and focus changes.
- At normal and narrow widths, the form is readable and zoom/pan work.
  Inspect an after-screenshot. Test pointer mapping at each zoom level.
- Helper-down and wrong-profile states show a clear recovery step.
- Unpublished/private state remains in the authoritative artifact status.
- Anonymous access cannot obtain the private artifact or control its browser.
- The helper refuses screenshot and input calls without authentication.
- A real course read succeeds through Morrow's executor after sign-in.

A builder action result alone does not prove the owner can use the card.
