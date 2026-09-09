# First-run state inventory

Every state a person meets between opening the Morrow app for the first time and reading their first
course, with the source that renders it.

**This is a source inventory, not a walkthrough proof.** It was produced by reading the source in this
checkout and by executing the three pure view modules over one state per branch. Nobody installed
Morrow, opened Chrome, or used a screen reader for it. Section 12 lists what only a person on a Mac
and a Windows computer can settle.

`scripts/test/first-run-state-inventory.test.mjs` keeps this file true. It runs the setup window's
action panel, the popup's view and the setup guide's state over one state per branch, and it requires
this file to carry every heading, next step and status line those three produce, to list one state per
branch they have, to cite the line each state's own text is written on, and to name every control on
the line that carries it. The other surfaces are read, not run, so only their citations are checked. A
source change this file does not follow fails that test with the line to correct.

Citations are repo-relative. A range means the whole branch; the line inside it that carries the
state's own text is what the test checks.

---

## 1. The path, in order

| # | Surface | Files |
| --- | --- | --- |
| 1 | Morrow app setup window | `installer/renderer/index.html`, `installer/renderer/renderer.js`, `installer/shared/setup-view.mjs` |
| 2 | Chrome connection page | `packages/bridge-loopback/src/index.ts` |
| 3 | Morrow Bridge popup | `connector/extension/popup/popup.html`, `connector/extension/popup/popup.js`, `connector/extension/popup/popup-view.js` |
| 4 | Morrow Bridge setup guide | `connector/extension/onboarding/onboarding.html`, `connector/extension/onboarding/onboarding.js`, `connector/extension/onboarding/onboarding-state.js` |
| 5 | Plan and Edit settings | `connector/extension/settings/settings.html`, `connector/extension/settings/settings.js` |
| 6 | Review page and result page | `packages/mcp-server/src/approval-server.ts` |

The order a person moves in is not the order of the list: the app sends them to Chrome (2), the popup
sends them back to the app, and the setup guide (4) opens on install
(`connector/extension/onboarding/onboarding-install.js:1`) or from the popup. Sections 2 to 8 follow
the list.

---

## 2. Morrow app setup window

One page: header (`installer/renderer/index.html:11`), welcome
(`installer/renderer/index.html:18`), progress rail (`installer/renderer/index.html:25`), action panel
(`installer/renderer/index.html:29`), an updates section that appears only when there is an update
record (`installer/renderer/index.html:39`), two closed disclosures (Blackboard
(`installer/renderer/index.html:48`) and what stays on this computer
at `installer/renderer/index.html:90`), and a support footer that names this Morrow and where to write
(`installer/renderer/index.html:99`).

Two facts apply to every row, so they are stated once:

- **Keyboard.** Every control in the action panel is a `<button>`. `render()` replaces the whole panel
  (`installer/renderer/renderer.js:310`), and it saves the focused control's `data-action` before the
  replacement and restores it after (`installer/renderer/renderer.js:105`,
  `installer/renderer/renderer.js:305`, `installer/renderer/renderer.js:321`). A control that is
  disabled while Morrow works keeps its place: the key is held
  (`installer/renderer/renderer.js:322`) and focus returns when the step finishes. The header
  **Check status** button (`installer/renderer/index.html:14`) is outside the panel and survives every
  re-render.
- **If a step fails.** Every step goes through `invoke()` (`installer/renderer/renderer.js:325`), which
  writes one message and one recovery into `#problem`, a `role="alert"` region
  (`installer/renderer/index.html:36`, `installer/renderer/renderer.js:137`): no preload bridge gives
  "Morrow setup is unavailable." / "Restart Morrow, then check status again."
  (`installer/renderer/renderer.js:327`); a malformed answer gives "Morrow returned an incomplete setup
  state." / "Check status again." (`installer/renderer/renderer.js:335`); a rejected call gives
  "Morrow could not check setup." / "Check status again." (`installer/renderer/renderer.js:341`); a
  handled failure shows the step's own message (`installer/renderer/renderer.js:338`). The alert is
  rewritten only when its text changes (`installer/renderer/renderer.js:140`), so returning to the
  window does not read the same error again.

| State | What the person sees | Next action | Renders at |
| --- | --- | --- | --- |
| `first-paint` | "Checking Morrow setup…" alone; the action panel is hidden; the rail shows three stages, each "Not checked yet"; the header live region says "Checking setup"; **Check status** is disabled | None. The read answers and replaces this state. `respond()` catches its own failures and always answers, so this state ends unless the main process never settles `installer:get-state` | `installer/renderer/index.html:31`, `installer/renderer/renderer.js:299-302`, `installer/shared/setup-view.mjs:103` |
| `setup-unavailable` | "Morrow could not read its setup state." / "Morrow could not read the setup record it keeps on this computer, so it cannot show which steps are complete. No setup step ran." and "No setup state was returned" | **Check again** in the panel | `installer/shared/setup-view.mjs:430` |
| `repair` | "Repair Morrow before you connect a course." / "Morrow did not confirm that its local runtime is ready. No course connection or course action will start from this state." The three-stage rail marks no ordinary setup stage as current and says the assistant is waiting for repair. | **Repair Morrow**, or **Check again** | `installer/shared/setup-view.mjs:254` |
| `claude-pending` | "Finish setting up Claude Desktop." / "Morrow prepared its extension for Claude Desktop. Install it there, then return here to check the connection." | **Open Claude Desktop**, install **Morrow.mcpb** through **Settings > Extensions > Advanced settings > Install Extension**, then **Check setup**. **Show Morrow extension** opens its folder. | `installer/shared/setup-view.mjs:265` |
| `no-assistant` | "Choose your assistant." / "Morrow configures only the assistant you choose. Your course sign-in remains separate in Chrome." with one card per assistant. The optional materials-folder choice is closed by default. | Select a card, then **Set up ChatGPT** (the button names the chosen assistant). With no supported assistant, install one and use the header **Check status**. | `installer/shared/setup-view.mjs:274` |
| `runtime-not-ready` | "Morrow is getting ready." / "Morrow will show the next Bridge step when its local runtime is ready. It will not open Chrome setup before then." | Keep Morrow open, then use the header **Check status**. | `installer/shared/setup-view.mjs:281` |
| `delivery-blocked` | "Morrow Bridge is not available yet." / "Your assistant can be ready while the Chrome connection is still unavailable. Morrow will not suggest an unverified installation route." | Use the header **Check status** after Bridge delivery is available. | `installer/shared/setup-view.mjs:288` |
| `reload-required` | "Reload Morrow Bridge." and three exact Chrome actions | Reload it on **Manage Extensions**, then **Check Bridge**. | `installer/shared/setup-view.mjs:295` |
| `folder-not-ready` | "Morrow Bridge is not ready to open." / "Morrow could not verify its Bridge folder." | **Repair Morrow**, or **Check again**. | `installer/shared/setup-view.mjs:302` |
| `dev-temporary` | "Add Morrow Bridge." and the temporary Chrome method in five exact substeps | **Show Bridge folder**, use **Manage Extensions**, **Developer mode**, and **Load unpacked**, then select **Connect Morrow** and **Check Bridge**. | `installer/shared/setup-view.mjs:309` |
| `store-available` | "Install Morrow Bridge." / "Morrow Bridge uses the learning platform where you are already signed in. It asks Chrome for access only to the exact learning platform you choose." | Add it from the Chrome Web Store, select **Connect Morrow**, then **Check Bridge**. | `installer/shared/setup-view.mjs:316` |
| `not-paired` | "Connect Morrow Bridge." / "<assistant> is configured. Open Morrow Bridge in Chrome to complete the connection you start." | Select **Connect Morrow**, approve **Allow connection** only if you started it, then **Check Bridge**. | `installer/shared/setup-view.mjs:324` |
| `no-course` | "Open your course in Chrome." / "Morrow Bridge identifies Canvas or Moodle after you open a signed-in course." | Open and sign in to a course. In Morrow Bridge select **Connect Canvas** or **Connect Moodle**, allow the exact address, then in **Plan and Edit settings** select **Connect selected courses in Plan**. | `installer/shared/setup-view.mjs:331` |
| `preview-ready` | "Check your course connection." / "Morrow will read <course> to confirm the connection. This check does not change the course." | **Check connection**. | `installer/shared/setup-view.mjs:346` |
| `preview-preparing` | "Your selected course is connected." / "<course> is connected. Morrow will show when its first read is available." | Use the header **Check status** before asking Morrow to inspect the course. | `installer/shared/setup-view.mjs:352` |
| `preview-completed` | "Your course is connected." / "Morrow read <course> successfully. Continue in <assistant> and ask what you want to do, for example:" | Continue in the assistant. Setup is complete. | `installer/shared/setup-view.mjs:339` |

The exact title and explanatory sentence emitted for each branch are:

- "Repair Morrow before you connect a course."
- "Morrow did not confirm that its local runtime is ready. No course connection or course action will start from this state."
- "Finish setting up Claude Desktop."
- "Morrow prepared its extension for Claude Desktop. Install it there, then return here to check the connection."
- "Choose your assistant."
- "Morrow configures only the assistant you choose. Your course sign-in remains separate in Chrome."
- "Morrow is getting ready."
- "Morrow will show the next Bridge step when its local runtime is ready. It will not open Chrome setup before then."
- "Morrow Bridge is not available yet."
- "Your assistant can be ready while the Chrome connection is still unavailable. Morrow will not suggest an unverified installation route."
- "Reload Morrow Bridge."
- "Morrow staged a verified Bridge update. Chrome must reload Morrow Bridge before Morrow can check the update."
- "Morrow Bridge is not ready to open."
- "Morrow could not verify its Bridge folder. Repair Morrow to restore the folder from the copy included with the app."
- "Add Morrow Bridge."
- "Use this temporary Chrome method until Morrow Bridge is available in the Chrome Web Store."
- "Install Morrow Bridge."
- "Morrow Bridge uses the learning platform where you are already signed in. It asks Chrome for access only to the exact learning platform you choose."
- "Connect Morrow Bridge."
- "<assistant> is configured. Open Morrow Bridge in Chrome to complete the connection you start."
- "Open your course in Chrome."
- "Morrow Bridge identifies Canvas or Moodle after you open a signed-in course."
- "Check your course connection."
- "Morrow will read <course> to confirm the connection. This check does not change the course."
- "Your selected course is connected."
- "<course> is connected. Morrow will show when its first read is available."
- "Your course is connected."
- "Morrow read <course> successfully. Continue in <assistant> and ask what you want to do, for example:"
- "Morrow could not read its setup state."
- "Morrow could not read the setup record it keeps on this computer, so it cannot show which steps are complete. No setup step ran."

The progress rail runs Assistant, Morrow Bridge, Course
(`installer/shared/setup-view.mjs:100`) and marks one step current
(`installer/shared/setup-view.mjs:114`, `installer/shared/setup-view.mjs:121`). The header live region
follows the same order (`installer/shared/setup-view.mjs:84`) so it never announces a step later than
the panel.

Beside the action panel. "Setup you can change" is appended inside the panel in every state once an
assistant is configured or waiting for approval, and never in `repair`
(`installer/shared/setup-view.mjs:215-219`), so neither the folder nor the assistant list is reachable
only from the first screen. The Blackboard and retention panels are disclosures reachable through
their `<summary>`.

| State | What the person sees | Next action | Renders at |
| --- | --- | --- | --- |
| `manage-setup` | "Setup you can change", the materials folder, and one row per assistant on this computer | Change the folder, add another assistant, or remove one | `installer/shared/setup-view.mjs:203-208` |
| `folder-unset` | "Materials folder" says Morrow creates and uses its own Materials folder unless the person wants another location. On the first screen it is inside **Optional: Choose another materials folder**, closed by default. | **Choose folder** | `installer/shared/setup-view.mjs:182` |
| `folder-set` | The folder's path, and what changing it does to each configured assistant | **Change folder** | `installer/shared/setup-view.mjs:158-163` |
| `assistant-configured` | The assistant's name and "Morrow is set up in this assistant." | **Remove**, and for Claude Desktop the note that it must also be removed inside Claude Desktop | `installer/shared/setup-view.mjs:168`, `installer/shared/setup-view.mjs:184`, `installer/shared/setup-view.mjs:192` |
| `assistant-pending` | "Waiting for your approval in Claude Desktop." | **Open Claude Desktop**, **Show Morrow extension**, **Check setup**, or **Remove** | `installer/shared/setup-view.mjs:169`, `installer/shared/setup-view.mjs:180` |
| `assistant-available` | "Not set up yet." | **Set up <assistant>** | `installer/shared/setup-view.mjs:172`, `installer/shared/setup-view.mjs:186` |
| `assistant-absent` | "Not found on this computer." or "Not available in this Morrow version." | None. The row carries no control | `installer/shared/setup-view.mjs:170-171` |
| `updates-hidden` | Nothing | None. No update record, or delivery is unavailable | `installer/renderer/renderer.js:151-158` |
| `updates-idle` | "Morrow checks for updates automatically. You can also check now." or "Morrow is ready to check for an update." | **Check for updates** | `installer/renderer/renderer.js:163-164` |
| `updates-checking` | "Morrow is checking for an update." | None. It answers itself | `installer/renderer/renderer.js:168` |
| `updates-downloading` | "Morrow found version N and will download it in the background." or "Morrow is downloading … You can keep working while it finishes." | None. It answers itself | `installer/renderer/renderer.js:172-178` |
| `updates-held` | "Morrow will restart after course work finishes or its current state is clear." | None. Morrow restarts when the work is settled | `installer/renderer/renderer.js:181` |
| `updates-install-failed` | "Morrow could not install the update. Try again when course work is idle." | **Try restart again** | `installer/renderer/renderer.js:186-187` |
| `updates-ready` | "Version N is ready." and "Restart Morrow when course work is idle to finish the update." | **Restart to update** | `installer/renderer/renderer.js:190-191` |
| `updates-installing` | "Morrow is installing its update. It will reopen when the update is complete." | None. Morrow reopens | `installer/renderer/renderer.js:195` |
| `updates-rolled-back` | "The update did not start; Morrow is running version N." | **Retry the update** | `installer/renderer/renderer.js:201-203` |
| `updates-no-space` | "Morrow could not download the update: this computer does not have enough free space for it." | Free space, then **Try again** | `installer/renderer/renderer.js:207-208` |
| `updates-check-failed` | "Morrow could not check for an update." | **Try again** | `installer/renderer/renderer.js:211-212` |
| `blackboard-hidden` | Nothing | None. The panel appears only after an assistant is configured and the local runtime is ready, so the first screen never asks for credentials | `installer/shared/setup-view.mjs:47-49`, `installer/renderer/renderer.js:285` |
| `blackboard-empty` | "Connect a Blackboard Learn site (optional)", "Most people do not need this…" and four fields | Ask a Blackboard administrator for the key and secret, then **Save Blackboard connection** | `installer/renderer/index.html:48-85`, `installer/renderer/renderer.js:288` |
| `blackboard-invalid` | One message under each field that is not ready, and focus moves to the first of them | Correct the named field. Messages clear as the value becomes right | `installer/renderer/renderer.js:570-610`, `installer/renderer/renderer.js:614-623` |
| `blackboard-saved` | "Blackboard REST API configured. Live Blackboard access has not been tested.", and the saved site, account and stored name in one row | Saving verifies the integration account and opens a native chooser for the courses returned by Blackboard. **Remove connection** takes the connection and its secret off this computer | `installer/renderer/renderer.js:288-290`, `installer/renderer/renderer.js:266-278` |
| `blackboard-save-failed` | The step's own problem in `#problem`; the secret field is cleared and the web address and key keep what was typed | Correct the value and save again | `installer/renderer/renderer.js:637-654` |
| `blackboard-removal-failed` | The step's own problem in `#problem`; the saved connection row and its courses stay exactly as they are | Check status, then remove it again | `installer/renderer/renderer.js:517-532`, `installer/main.cjs:529-537` |
| `retention` | "What stays on this computer", every path this installation keeps, and which ones Morrow can remove | Optional: **Remove Morrow's data** | `installer/shared/setup-view.mjs:379-395` |
| `retention-partial` | "Morrow could not remove everything", the paths removed and the paths still on this computer | Close what is using them, then remove again, or remove them by hand | `installer/shared/setup-view.mjs:371` |
| `removal-announced` | Nothing on screen. The result of a removal is read once in a `role="status"` region, in the words the section shows, because focus stays on the button that ran it | None. It repeats what the section already shows | `installer/shared/setup-view.mjs:462-468`, `installer/renderer/index.html:97`, `installer/renderer/renderer.js:347` |
| `support` | "Where to get help", the Morrow version, the materials folder, the folder Morrow keeps its setup record in, and the support address. A value Morrow has not read is left out | None. Morrow opens no web page, so the address is text a person opens in their browser | `installer/shared/setup-view.mjs:437-454`, `installer/renderer/renderer.js:337` |

---

## 3. Chrome connection page

Served on loopback by the Morrow app. It has no JavaScript: both controls are `<button>` elements in
a plain `<form method="post">` (`packages/bridge-loopback/src/index.ts:371`), so they work by keyboard
and with scripts turned off.

| State | What the person sees | Next action | Renders at |
| --- | --- | --- | --- |
| `pair-pending` | "Connect Morrow to Chrome", what the connection does, "Only continue if you started this from Morrow Bridge. Connecting does not approve changes to your courses.", and the extension ID inside a disclosure | **Allow connection**, or **Cancel connection** | `packages/bridge-loopback/src/index.ts:428`, `packages/bridge-loopback/src/index.ts:430` |
| `pair-approved` | "Chrome connection approved" and "Open a signed-in Canvas or Moodle course in Chrome. Morrow Bridge identifies the platform and shows Connect Canvas or Connect Moodle." | Open a signed-in course in Chrome, then use the platform button in the popup. The page has no control | `packages/bridge-loopback/src/index.ts:369`, `packages/bridge-loopback/src/index.ts:372` |
| `pair-denied` | "Connection cancelled" and "Morrow did not connect through this request. You can start again from the Morrow extension when you are ready." | Open the popup and select **Connect Morrow**. The page has no control | `packages/bridge-loopback/src/index.ts:369`, `packages/bridge-loopback/src/index.ts:372` |
| `pair-unavailable` | "Start a new connection" and "This connection request has expired or is no longer available. Open the Morrow extension and select Connect Morrow to try again." | Open the popup and select **Connect Morrow**. The page has no control | `packages/bridge-loopback/src/index.ts:376-378` |

---

## 4. Morrow Bridge popup

The popup reads the current Bridge state, then uses a read-only active-tab probe when it needs to
name the active signed-in platform. The probe returns only `canvas`, `moodle`, or no match; it saves
no course or account value (`connector/extension/src/service-worker.js:3606`).

Every control is a native button. A control that does not apply is hidden, which removes it from the
tab order (`connector/extension/popup/popup.js:60`). The help disclosure uses the same three stages as the app and website:
choose the assistant, finish Morrow Bridge, then open and connect the course
(`connector/extension/popup/popup.html:33-35`).

| State | What the person sees | Next action | Renders at |
| --- | --- | --- | --- |
| `read-failed` | Morrow and Course are "Not checked". The detail names the failed read and retry. | **Try again**. | `connector/extension/popup/popup-view.js:82` |
| `not-paired` | Morrow "Not connected", Course "Not connected", and the detail says to add Morrow to the assistant. | **Connect Morrow**. | `connector/extension/popup/popup-view.js:91` |
| `pairing` | Morrow "Waiting for approval" and the detail names the Morrow page that opened. | **Allow connection** on that page. | `connector/extension/popup/popup-view.js:89` |
| `connecting` | Morrow "Connecting…" and a settled waiting detail. | No action. Return in a moment. | `connector/extension/popup/popup-view.js:93` |
| `paired-not-connected` | Morrow "Not available" and the popup says the assistant must be open. | Open the assistant. | `connector/extension/popup/popup-view.js:95` |
| `runtime-mismatch` | Morrow "Reload needed", Course "Not available", and a version-mismatch detail. | **Open setup guide**, update or repair, then reload Bridge. | `connector/extension/popup/popup-view.js:83` |
| `connected-no-site` | Morrow "Connected", Course "Not connected", disabled **Open Canvas or Moodle**, and instructions to open a signed-in course. | Open a signed-in Canvas or Moodle course in this tab. | `connector/extension/popup/popup-view.js:106` |
| `detected-platform` | The active Moodle course is detected. The primary action and detail both say **Connect Moodle**. Canvas produces **Connect Canvas** in the same branch. | Select the platform button and allow the exact address Chrome shows. | `connector/extension/popup/popup-view.js:72` |
| `site-ready-no-course` | Course "Ready", **Choose courses**, and a Plan explanation. | **Choose courses**, which opens Plan and Edit settings. | `connector/extension/popup/popup-view.js:101` |
| `site-stale` | Course "Canvas tab needed" and the detail names the saved Canvas connection. | Open a signed-in Canvas course, then **Connect Canvas**. | `connector/extension/popup/popup-view.js:78` |
| `course-ready` | Course "Connected", the selected course and last-check time, and a detail that names the Canvas course tab. | Ask the assistant, or use **Check or switch course**. | `connector/extension/popup/popup-view.js:97` |
| `course-tab-closed` | Course "Canvas tab needed" and a detail that names the closed Canvas tab. | Open the course, sign in, then **Connect Canvas**. | `connector/extension/popup/popup-view.js:74` |

The exact status, course, action, and detail strings emitted for these branches are:

- "Not checked"
- "Try again"
- "Morrow could not read this connection state. Select Try again. If the state does not change, close this popup and open it again."
- "Not connected"
- "Connect Morrow"
- "Add Morrow to your assistant, then open it. Select Connect Morrow to continue."
- "Waiting for approval"
- "Confirm this connection on the Morrow page that opens. Then return to this popup."
- "Connecting…"
- "Waiting for your assistant"
- "Connecting to Morrow. Keep this popup open or return in a moment."
- "Not available"
- "Open the assistant where you added Morrow. This popup will reconnect when Morrow is ready."
- "Reload needed"
- "Open setup guide"
- "The Morrow app and Morrow Bridge versions do not match. Open the setup guide, update or repair Morrow Bridge, then reload Morrow Bridge in Chrome."
- "Connected"
- "Open Canvas or Moodle"
- "Open a signed-in Canvas or Moodle course in Chrome. Morrow Bridge will detect the platform and show Connect Canvas or Connect Moodle."
- "Connect Moodle"
- "Morrow Bridge detected Moodle. Select Connect Moodle to allow access to this signed-in course."
- "Ready"
- "Choose courses"
- "Choose courses in Plan and Edit settings. Plan keeps changes ready for your review."
- "Canvas tab needed"
- "Connect Canvas"
- "The saved Canvas connection is no longer open. Open a Canvas course in Chrome, sign in, then select Connect Canvas."
- "This selected course is connected. Keep one signed-in Canvas course tab open while you work in Morrow."
- "This selected course is connected, but its Canvas tab is no longer open. Open the course in Chrome, sign in, then select Connect Canvas."

A saved Canvas course with an active Moodle tab gives a separate mismatch detail. It tells the person
to connect the detected Moodle platform or reopen the selected Canvas course
(`connector/extension/popup/popup-view.js:72`).

Failures reach one `role="alert"` banner as stable problem codes. Each known code gives what happened,
why, and one next action; an unknown code remains visible instead of becoming a generic success
(`connector/extension/src/bridge-problem-copy.js:17`, `connector/extension/src/bridge-problem-copy.js:309-314`).

---

## 5. Morrow Bridge setup guide

The guide opens after Bridge installation or from **Open setup guide**. **Guide me** shows one next
action. **Setup overview** shows the same three stages as the app, popup, and website
(`connector/extension/onboarding/onboarding.html:19-47`). The five readiness checks remain detailed evidence inside those three stages.

| State | What the person sees | Next action | Renders at |
| --- | --- | --- | --- |
| `read-failed` | "Setup state not checked", five explicit not-checked lines, and a detail that names **Setup overview**. | **Setup overview**, or return to this tab to read again. | `connector/extension/onboarding/onboarding-state.js:58` |
| `not-paired` | "Setup in progress" and "Open Morrow" with the exact assistant and Bridge connection action. | Open Morrow, choose the assistant, then **Connect Morrow** and **Allow connection**. | `connector/extension/onboarding/onboarding-state.js:202` |
| `pairing` | "Waiting for approval" / "Allow connection". | **Allow connection** on the Morrow page. | `connector/extension/onboarding/onboarding-state.js:188` |
| `connecting` | "Connecting Morrow" and a waiting detail. | No action. Return in a moment. | `connector/extension/onboarding/onboarding-state.js:195` |
| `paired-not-connected` | "Open Morrow again" and the assistant recovery. | Open Morrow and choose the assistant again. | `connector/extension/onboarding/onboarding-state.js:209` |
| `runtime-mismatch` | "Morrow needs a reload" / "Reload Morrow Bridge" with version detail. | Update Morrow, reload Bridge, then **Connect Morrow** again. | `connector/extension/onboarding/onboarding-state.js:216` |
| `connected-no-site` | "Open Canvas or Moodle" and the exact platform-detection behavior. | Open a signed-in course, then select **Connect Canvas** or **Connect Moodle**. | `connector/extension/onboarding/onboarding-state.js:225` |
| `site-saved-not-verified` | "Reconnect Canvas" and a detail that names the saved Canvas course. | Open it, sign in, then **Connect Canvas**. | `connector/extension/onboarding/onboarding-state.js:224` |
| `site-ready-no-course` | "Select a course in Plan" and the exact final course-selection control. | **Open Plan and Edit settings**, then **Connect selected courses in Plan**. | `connector/extension/onboarding/onboarding-state.js:232` |
| `course-ready` | "One step left" / "Try a first read" and the exact request to ask. | Ask the assistant for the read. | `connector/extension/onboarding/onboarding-state.js:239` |
| `ready` | "Ready to use" / "Plan your first change" after a named first read. | Ask the assistant for a change. Plan holds it for review. | `connector/extension/onboarding/onboarding-state.js:181` |

The exact heading, summary, next action, detail, and checklist strings emitted for these branches are:

- "Setup state not checked"
- "Morrow could not read this setup state, so no line below states a current result."
- "Follow the setup steps"
- "Morrow could not read this setup state, so it cannot name one next step. Select Setup overview to see the three stages. This guide reads the state again when you return to this tab."
- "Assistant approval is not checked"
- "Morrow Bridge connection is not checked"
- "Morrow version is not checked"
- "Course connection is not checked"
- "First read is not checked"
- "Setup in progress"
- "Morrow checks the assistant, this connection, your selected course and the first read each time this guide opens."
- "Open Morrow"
- "Open Morrow and choose your assistant. Then return to Morrow Bridge, select Connect Morrow, and allow the connection you started."
- "No assistant has approved this connection yet"
- "Morrow Bridge is not connected to Morrow"
- "Morrow version is checked when Morrow Bridge connects"
- "No Canvas or Moodle course is connected"
- "No first read is completed yet"
- "Waiting for approval"
- "Morrow is waiting for you to allow this connection on the Morrow page that opened."
- "Allow connection"
- "Select Allow connection in the Morrow page that opened. Then return here while Morrow connects."
- "An assistant approval is waiting on the Morrow page that opened"
- "Morrow Bridge connects after you allow this connection"
- "Connecting Morrow"
- "Morrow is connecting. This guide reads the state again when you return to this tab."
- "Keep your assistant open while Morrow connects. Return here in a moment."
- "An assistant approved this connection in Morrow. Morrow Bridge sees the connection, not the assistant itself."
- "Morrow Bridge is connecting to Morrow"
- "Open Morrow again"
- "Open Morrow and choose your assistant again. Then return to Morrow Bridge."
- "Morrow needs a reload"
- "Morrow and Morrow Bridge report different versions, so Morrow Bridge cannot confirm which course actions Morrow can use."
- "Reload Morrow Bridge"
- "Morrow and Morrow Bridge report different versions. Update Morrow, then reload Morrow Bridge on the Chrome extensions page and select Connect Morrow again."
- "Morrow Bridge is connected to Morrow"
- "Morrow reports a different version from this Morrow Bridge"
- "Open Canvas or Moodle"
- "Open a permitted Canvas or Moodle course in Chrome and sign in. Morrow Bridge identifies the platform and shows Connect Canvas or Connect Moodle. Select that button and allow Chrome access to the exact address shown."
- "Morrow matches this Morrow Bridge version and its list of course actions"
- "Reconnect Canvas"
- "Open the saved Canvas course in Chrome and sign in. Morrow Bridge identifies it and shows Connect Canvas. Select that button and allow Chrome access to the exact address shown."
- "Saved Canvas needs sign-in or reconnection"
- "Select a course in Plan"
- "Open Plan and Edit settings. Find available courses, choose a course, then select Connect selected courses in Plan."
- "Canvas is ready; select courses in Plan"
- "One step left"
- "1 selected course is ready in this Chrome session. One read from your assistant completes this setup."
- "Try a first read"
- "Return to your assistant and ask: Use Morrow to list the modules in my selected course."
- "1 selected course is ready"
- "Ready to use"
- "1 selected course is ready in this Chrome session. Morrow completed a first read in Biology 101."
- "Plan your first change"
- "Ask your assistant for a change in your selected course. Morrow keeps every change in Plan for your review."
- "First read completed in Biology 101"

The status dot is decorative, and every state also carries a heading, so colour alone never separates
waiting from ready (`connector/extension/onboarding/onboarding.html:26`).

### The five checks
### The five checks

The checklist reports the five states the completion goal names
(`connector/extension/onboarding/onboarding.html:28-34`). "Ready to use" is all five, so a connection
that has never read a course is not ready
(`connector/extension/onboarding/onboarding-state.js:164`).

| Element | What it reports | Renders at |
| --- | --- | --- |
| `assistant-check` | The connection an assistant approved through Morrow. Morrow Bridge cannot see the assistant window itself, and the line says so | `connector/extension/onboarding/onboarding.html:37` |
| `connection-check` | Whether Morrow Bridge holds an open connection to Morrow | `connector/extension/onboarding/onboarding.html:38` |
| `runtime-check` | Whether the Morrow this connection reached is the same build as this extension. Morrow names the connector identity it accepted, and the status read compares it with this extension, this connector revision and this exact list of course actions (`connector/extension/src/service-worker.js:2467-2476`) | `connector/extension/onboarding/onboarding.html:39` |
| `course-check` | How many selected courses are ready in this Chrome session | `connector/extension/onboarding/onboarding.html:40` |
| `read-check` | The course of the last read that returned. The service worker records the course and the time after a read answers ok, and replaces the record when a read succeeds in a different course (`connector/extension/src/service-worker.js:2066-2082`) | `connector/extension/onboarding/onboarding.html:41` |

Every line the five checks can render:

- `assistant-check`: "Assistant approval is not checked", "No assistant has approved this connection yet", "An assistant approval is waiting on the Morrow page that opened", "An assistant approved this connection in Morrow. Morrow Bridge sees the connection, not the assistant itself."
- `connection-check`: "Morrow Bridge connection is not checked", "Morrow Bridge is not connected to Morrow", "Morrow Bridge connects after you allow this connection", "Morrow Bridge is connecting to Morrow", "Morrow Bridge is connected to Morrow"
- `runtime-check`: "Morrow version is not checked", "Morrow version is checked when Morrow Bridge connects", "Morrow reports a different version from this Morrow Bridge", "Morrow matches this Morrow Bridge version and its list of course actions"
- `course-check`: "Course connection is not checked", "No Canvas or Moodle course is connected", "Saved Canvas needs sign-in or reconnection" (or Moodle), "Canvas is ready; select courses in Plan" (or Moodle), "1 selected course is ready" (or "2 selected courses are ready", and so on)
- `read-check`: "First read is not checked", "No first read is completed yet", "First read completed in Biology 101" (the recorded course, by name, or by "course" and its id when the record carries no name)

---

## 6. Plan and Edit settings

This page carries more than first-run setup. The rows below are the states a person meets while
connecting their first course. The Edit stage that follows them (choosing individual actions, a
duration, and confirming a flagged selection) is rendered at
`connector/extension/settings/settings.js:663-712` and
`connector/extension/settings/settings.html:98-155`, and is outside first run.

Every control on this page is a native `<button>`, `<select>`, `<input>` or `<label>`, so all of it is
keyboard reachable. One `role="alert"` (`connector/extension/settings/settings.html:21`) carries
failures and one polite `role="status"` (`connector/extension/settings/settings.html:22`) carries
announcements; a failure arrives as a stable code, and its title, cause and next action are read
from `connector/extension/src/bridge-problem-copy.js:17` and written into the alert at
`connector/extension/settings/settings.js:341-344`, with the unexplained-code fallback at
`connector/extension/src/bridge-problem-copy.js:309-314`.

| State | What the person sees | Next action | Renders at |
| --- | --- | --- | --- |
| `settings-first-paint` | "Checking connected courses…", "Loading connected courses…", "Checking Chrome permission…"; **Refresh connected courses** is disabled during the read | None. The read answers and replaces these lines | `connector/extension/settings/settings.html:28`, `connector/extension/settings/settings.html:56`, `connector/extension/settings/settings.html:88`, disabled at `connector/extension/settings/settings.js:840` |
| `settings-read-failed` | The alert names the failure. The page says "Connected courses were not checked." and "Course access was not checked. Select Refresh connected courses." It shows no false loading state. | **Refresh connected courses**, re-enabled when the read ends | `connector/extension/settings/settings.js:553`, `connector/extension/settings/settings.js:615`, `connector/extension/settings/settings.js:709`, state set at `connector/extension/settings/settings.js:924` |
| `settings-no-anchor` | "No signed-in Canvas or Moodle course is available. Open one course in Chrome, then refresh this page."; the site list and **Find available courses** are disabled | Open a signed-in course in Chrome, then **Refresh connected courses** | `connector/extension/settings/settings.js:555`, disabled at `connector/extension/settings/settings.js:548` |
| `settings-anchor-ready` | "Find courses from this signed-in site. You choose which courses to connect in Plan." and "No connected courses are available. Choose a signed-in site above to find courses you can connect." | **Find available courses** | `connector/extension/settings/settings.js:529`, `connector/extension/settings/settings.js:571` |
| `settings-available-list` | "Choose courses to connect", the page of available courses, and how many the page shows | Select courses, then **Connect selected courses in Plan** | `connector/extension/settings/settings.js:543`, `connector/extension/settings/settings.js:586-588`, `connector/extension/settings/settings.js:638` |
| `settings-more-available` | "Page N shows M available courses. More courses are available from this site." | **Load more available courses**, or connect what is selected first | `connector/extension/settings/settings.js:557`, `connector/extension/settings/settings.js:562` |
| `settings-discovery-expired` | "This available-course list has expired. Find available courses again before connecting courses." | **Find available courses** | `connector/extension/settings/settings.js:553`, `connector/extension/settings/settings.js:569` |
| `settings-connected` | How many connected courses are ready to use, and how many need an open course tab or a reconnected site | Select a course, then keep Plan or choose Edit | `connector/extension/settings/settings.js:593-597` |
| `settings-file-access-off` | "Off. Morrow cannot access course file content." | Optional: **Enable course file access** | `connector/extension/settings/settings.js:726`, `connector/extension/settings/settings.html:92` |
| `settings-file-access-revoked` | "Off. Chrome permission was removed, so Morrow keeps course file access off." | Optional: **Enable course file access** again | `connector/extension/settings/settings.js:723` |

---

## 7. Review page

Reached from the assistant, on this computer only (`packages/mcp-server/src/approval-server.ts:67`).
Approve and cancel are `<button>` elements inside `<form method="post">`
(`packages/mcp-server/src/approval-server.ts:815-816`), so the decision works by keyboard and without
JavaScript; the search and pagination controls (`packages/mcp-server/src/approval-server.ts:796`) come
from the deferred script and only filter what is already on the page.

| State | What the person sees | Next action | Renders at |
| --- | --- | --- | --- |
| `review-awaiting` | A title naming the change, who asked for it, the destination, the requested values, any risk warning, and when approval expires | **Apply this change** (the label names the change; for a group, "Apply all N changes"), or **Cancel** | `packages/mcp-server/src/approval-server.ts:808-816` |
| `review-missing-names` | "Morrow could not identify the course or a selected item in Canvas." and "Nothing can be approved here until those details load. Check your Canvas connection, then reload this page." | Reload the page after the connection is working. The approve control is absent by design, and the server also refuses an approval in this state (`packages/mcp-server/src/approval-server.ts:982`) | `packages/mcp-server/src/approval-server.ts:812-813`, `packages/mcp-server/src/approval-server.ts:815` |
| `review-limited` | "Too many different courses or activities to review at once." and "Return to your assistant and ask Morrow to split this into smaller groups. This page has not approved any changes." | Ask the assistant for smaller groups. See finding F-6 | `packages/mcp-server/src/approval-server.ts:810-811` |
| `review-expired` | "Review expired" and "Return to the assistant where you started this request and ask Morrow for a new review. Check the new request before approving it." | Ask the assistant for a new review. The page has no control | `packages/mcp-server/src/approval-server.ts:597`, reached at `packages/mcp-server/src/approval-server.ts:698` |
| `review-unavailable` | "Review unavailable" and "This review may have expired or the request may have changed… Do not repeat the change until Morrow checks the saved result." | Ask the assistant to check the saved result. The page has no control | `packages/mcp-server/src/approval-server.ts:1032` |

---

## 8. Result page

One page per request after approval (`packages/mcp-server/src/approval-server.ts:799`). The state
region is `role="status"` and updates itself once a second while work is active
(`packages/mcp-server/src/approval-server.ts:140-158`). Except for **Stop remaining changes** on an
active group (`packages/mcp-server/src/approval-server.ts:798`), these states carry no control: the
next action is in the assistant, or is reloading the page. That is deliberate: the page reports what
Morrow saved and refuses to offer a repeat.

| State | What the person sees | Next action | Renders at |
| --- | --- | --- | --- |
| `approved` | "Changes not started" / "Your approval was saved, but this request is not running. Return to your assistant and ask Morrow to check this saved request before starting anything else." | Ask the assistant to check the saved request | `packages/mcp-server/src/approval-server.ts:594` |
| `verified` | "Changes confirmed" / "Morrow checked Canvas and confirmed the requested result." | None. This is the end state | `packages/mcp-server/src/approval-server.ts:595` |
| `cancelled` | "Request cancelled" / "Morrow will not start more changes for this request. Changes already sent may still finish…" | Ask the assistant to check the result | `packages/mcp-server/src/approval-server.ts:596` |
| `expired` | "Review expired" | Ask the assistant for a new review | `packages/mcp-server/src/approval-server.ts:597` |
| `dispatching` | "Applying your changes" / "Morrow will check the saved result in Canvas. This page updates automatically." plus "Keep your assistant and Chrome open while Morrow works." | None. Wait | `packages/mcp-server/src/approval-server.ts:598`, instruction `packages/mcp-server/src/approval-server.ts:589` |
| `running` | The same as `dispatching`. An approved request with work in flight is shown as running | None. Wait | `packages/mcp-server/src/approval-server.ts:599`, mapped at `packages/mcp-server/src/approval-server.ts:679` |
| `awaiting_verification` | "Check the result" / "Morrow could not confirm the saved result in Canvas. Return to your assistant and ask Morrow to check this saved request. Do not repeat the change." | Ask the assistant to check it | `packages/mcp-server/src/approval-server.ts:600` |
| `awaiting_inner_approval` | "Review needed" / "This request needs another approval before it can finish…" | Return to the assistant for the next review | `packages/mcp-server/src/approval-server.ts:601` |
| `applied_or_unknown` | "Result unconfirmed" / "Canvas may have received the changes… If Morrow cannot check it, open the item in Canvas and confirm it yourself. Do not repeat the change." | Ask the assistant to check it, or open the item and confirm it | `packages/mcp-server/src/approval-server.ts:602` |
| `closed_by_person` | "Closed after your check" / "Morrow did not check this change itself. It is closed because you read the item and confirmed the saved state…" | None | `packages/mcp-server/src/approval-server.ts:603` |
| `inspection_required` | "Check results" / "Canvas may have received some changes… Do not repeat the group of changes." | Ask the assistant to check each result | `packages/mcp-server/src/approval-server.ts:604` |
| `partial` | "Changes stopped" / "Return to the assistant where you started this request to see which changes finished and which still need attention…" | Ask the assistant which changes finished | `packages/mcp-server/src/approval-server.ts:605` |
| `paused` | "Work is paused" / "Morrow is not starting more changes. Work already sent may still finish…" | Ask the assistant to check or continue | `packages/mcp-server/src/approval-server.ts:606` |
| `completed` | "Check results" / "The work has stopped, but not every requested change has a confirmed result…" | Ask the assistant to check the saved results | `packages/mcp-server/src/approval-server.ts:607` |
| `failed` | "Request stopped" / "Return to the assistant where you started this request to find out what happened…" | Ask the assistant what happened | `packages/mcp-server/src/approval-server.ts:608` |
| `interrupted` | "Work stopped" / "Morrow is not running this request now. Return to your assistant and ask Morrow to check the saved result before trying again." | Ask the assistant to check the saved result | `packages/mcp-server/src/approval-server.ts:609`, mapped at `packages/mcp-server/src/approval-server.ts:680` |
| `no-change-sent` | "No change was sent" / "Morrow did not change anything in Canvas. Return to your assistant and ask Morrow to read the latest Canvas content and prepare a new review." | Ask the assistant for a new review | `packages/mcp-server/src/approval-server.ts:622`, condition `packages/mcp-server/src/approval-server.ts:611` |
| `same-target-blocked` | "Check earlier change" / "Morrow has not sent this change. An earlier change to the same target is still unresolved…" | Ask the assistant to check the earlier request | `packages/mcp-server/src/approval-server.ts:617`, condition `packages/mcp-server/src/approval-server.ts:612` |
| `historical-target-blocked` | "An earlier change from an older Morrow version is still unresolved, so Morrow has not sent this change. That earlier change has no saved check. Open the item it changed in Canvas, confirm it yourself, then ask Morrow for a new review." | Open the item and confirm it, then ask for a new review | `packages/mcp-server/src/approval-server.ts:615`, condition `packages/mcp-server/src/approval-server.ts:613` |
| `unknown-state` | "Check this request" / "The request has changed or can no longer be approved here. Return to your assistant and ask Morrow to check its current status." | Ask the assistant to check the status | `packages/mcp-server/src/approval-server.ts:623` |
| `group-progress` | How many of the group's changes are confirmed, beneath the state, and **Stop remaining changes** while the group is active | **Stop remaining changes**, or wait | `packages/mcp-server/src/approval-server.ts:686`, `packages/mcp-server/src/approval-server.ts:798` |
| `poll-failed` | "Morrow cannot refresh this result. Reload this page to check it. Do not repeat the change." | Reload the page | `packages/mcp-server/src/approval-server.ts:155` |

A state page names the platform the request belongs to, so a Moodle or Blackboard request does not
say Canvas (`packages/mcp-server/src/approval-server.ts:624`,
`packages/mcp-server/src/approval-server.ts:684`).

---

## 9. States with no next action

Every state in sections 2 to 8 has a next action. **There is no dead end on the first-run path in this
source.** Three groups need naming, because "has a next action" means something different in each:

1. **The action is on this surface.** Most states. The control is named in the row.
2. **The action is on another surface, and this surface names it in words.** `no-course`,
   `not-paired`, `pair-approved`, `pair-denied`, `pair-unavailable`, popup `pairing`,
   `paired-not-connected`, `connected-no-site`, `detected-platform`, `site-stale`, `course-tab-closed`, setup guide
   `not-paired`, `paired-not-connected`, `connected-no-site`, `site-saved-not-verified`, and every
   result-page row. These are not dead ends, and each names the surface and the control, but a
   person cannot act without leaving the page they are on.
3. **No action is needed.** `first-paint`, `updates-checking`, `updates-downloading`,
   `updates-installing`, `updates-held`, popup `connecting`, setup guide `connecting`, result
   `dispatching` and `running`. Each ends by itself, and each says so.

Two states in group 3 depend on something outside their own code to end them, and neither has a
timeout: `first-paint` ends only when the main process answers `installer:get-state`
(`installer/renderer/renderer.js:333`; `installer/main.cjs:411` always answers unless
`installer.state()` never settles), and `updates-installing` ends only when the update process
restarts Morrow. Neither was observed here.

One state has a control but no working one: `no-assistant` on a computer with no supported assistant
shows "No supported assistant was found" with the setup button disabled
(`installer/shared/setup-view.mjs:126`, `installer/shared/setup-view.mjs:251`). The next action
(install an assistant, then check status) is named in the text, and the header **Check status** works.

---

## 10. Terminology: every user-facing control name

One row per control name per surface. `scripts/test/first-run-state-inventory.test.mjs` requires each
name to be on the line cited beside it, so a renamed control fails the test rather than leaving a
stale name here.

| Control name | Surface | Source |
| --- | --- | --- |
| `Check status` | Morrow app | `installer/renderer/index.html:15` |
| `Repair Morrow` | Morrow app | `installer/shared/setup-view.mjs:254` |
| `Check again` | Morrow app | `installer/shared/setup-view.mjs:256`, `installer/shared/setup-view.mjs:256` |
| `Open Claude Desktop` | Morrow app | `installer/shared/setup-view.mjs:205`, `installer/shared/setup-view.mjs:205` |
| `Show Morrow extension` | Morrow app | `installer/shared/setup-view.mjs:206`, `installer/shared/setup-view.mjs:206` |
| `Check setup` | Morrow app | `installer/shared/setup-view.mjs:207`, `installer/shared/setup-view.mjs:207` |
| `Choose an assistant` | Morrow app | `installer/shared/setup-view.mjs:160` |
| `Choose folder` | Morrow app | `installer/shared/setup-view.mjs:181`, `installer/shared/setup-view.mjs:181` |
| `Change folder` | Morrow app | `installer/shared/setup-view.mjs:189` |
| `Remove` | Morrow app | `installer/shared/setup-view.mjs:210`, `installer/renderer/renderer.js:252` |
| `Show Bridge folder` | Morrow app | `installer/shared/setup-view.mjs:311` |
| `Check Bridge` | Morrow app | `installer/shared/setup-view.mjs:297` |
| `Check connection` | Morrow app | `installer/shared/setup-view.mjs:348` |
| `Check for updates` | Morrow app | `installer/renderer/renderer.js:172` |
| `Restart to update` | Morrow app | `installer/renderer/renderer.js:199` |
| `Try restart again` | Morrow app | `installer/renderer/renderer.js:195` |
| `Retry the update` | Morrow app | `installer/renderer/renderer.js:211` |
| `Try again` | Morrow app | `installer/renderer/renderer.js:194` |
| `Save Blackboard connection` | Morrow app | `installer/renderer/index.html:78` |
| `Remove Morrow&#39;s data` | Morrow app | `installer/shared/setup-view.mjs:418` |
| `Allow connection` | Chrome connection page | `packages/bridge-loopback/src/index.ts:439` |
| `Cancel connection` | Chrome connection page | `packages/bridge-loopback/src/index.ts:439` |
| `About this connection` | Chrome connection page | `packages/bridge-loopback/src/index.ts:439` |
| `Connect Morrow` | Popup | `connector/extension/popup/popup.html:26`, `connector/extension/popup/popup-view.js:59` |
| `Try again` | Popup | `connector/extension/popup/popup-view.js:56` |
| `Waiting for approval` | Popup | `connector/extension/popup/popup-view.js:41` |
| `Waiting for your assistant` | Popup | `connector/extension/popup/popup-view.js:61` |
| `Choose courses` | Popup | `connector/extension/popup/popup-view.js:60` |
| `Open Canvas or Moodle` | Popup | `connector/extension/popup/popup-view.js:63` |
| `Connect Canvas` | Popup | `connector/extension/popup/popup-view.js:106` |
| `Connect Moodle` | Popup | `connector/extension/popup/popup-view.js:106` |
| `Check or switch course` | Popup | `connector/extension/popup/popup.html:27` |
| `Disconnect Morrow` | Popup | `connector/extension/popup/popup.html:28` |
| `Open Plan and Edit settings` | Popup | `connector/extension/popup/popup.html:30` |
| `Open setup guide` | Popup | `connector/extension/popup/popup.html:32` |
| `How to connect` | Popup | `connector/extension/popup/popup.html:34` |
| `Guide me` | Setup guide | `connector/extension/onboarding/onboarding.html:29` |
| `Setup overview` | Setup guide | `connector/extension/onboarding/onboarding.html:30` |
| `Open Plan and Edit settings` | Setup guide | `connector/extension/onboarding/onboarding.html:51`, `connector/extension/onboarding/onboarding.html:51` |
| `Refresh connected courses` | Plan and Edit settings | `connector/extension/settings/settings.html:31` |
| `Find available courses` | Plan and Edit settings | `connector/extension/settings/settings.html:42` |
| `Select this page` | Plan and Edit settings | `connector/extension/settings/settings.js:750` |
| `Select this page to connect` | Plan and Edit settings | `connector/extension/settings/settings.js:750` |
| `Clear this page` | Plan and Edit settings | `connector/extension/settings/settings.js:749` |
| `Previous page` | Plan and Edit settings | `connector/extension/settings/settings.html:60` |
| `Next page` | Plan and Edit settings | `connector/extension/settings/settings.html:62` |
| `Load more available courses` | Plan and Edit settings | `connector/extension/settings/settings.html:66`, `connector/extension/settings/settings.js:702` |
| `View connected courses` | Plan and Edit settings | `connector/extension/settings/settings.html:74` |
| `Connect selected courses in Plan` | Plan and Edit settings | `connector/extension/settings/settings.html:75`, `connector/extension/settings/settings.js:782` |
| `Enable course file access` | Plan and Edit settings | `connector/extension/settings/settings.html:93`, `connector/extension/settings/settings.js:888` |
| `Turn on course file access` | Plan and Edit settings | `connector/extension/settings/settings.js:888` |
| `Remove HTTPS file access` | Plan and Edit settings | `connector/extension/settings/settings.html:94` |
| `Return selected courses to Plan` | Plan and Edit settings | `connector/extension/settings/settings.html:142` |
| `Save Edit access` | Plan and Edit settings | `connector/extension/settings/settings.html:143`, `connector/extension/settings/settings.js:439` |
| `Keep reviewing` | Plan and Edit settings | `connector/extension/settings/settings.html:152` |
| `Save Edit access anyway` | Plan and Edit settings | `connector/extension/settings/settings.html:153` |
| `Apply this change` | Review page | `packages/mcp-server/src/approval-server.ts:844` |
| `Add this question` | Review page | `packages/mcp-server/src/approval-server.ts:844` |
| `Change this text` | Review page | `packages/mcp-server/src/approval-server.ts:844` |
| `Add alternative text` | Review page | `packages/mcp-server/src/approval-server.ts:844` |
| `Mark as decorative` | Review page | `packages/mcp-server/src/approval-server.ts:844` |
| `Cancel` | Review page | `packages/mcp-server/src/approval-server.ts:666` |
| `Technical details` | Review page | `packages/mcp-server/src/approval-server.ts:834` |
| `Find a change` | Review page | `packages/mcp-server/src/approval-server.ts:831` |
| `Stop remaining changes` | Result page | `packages/mcp-server/src/approval-server.ts:833` |

Names a person reads as landmarks rather than presses:

| Name | Surface | Source |
| --- | --- | --- |
| `Set up Morrow on this computer` | Morrow app | `installer/renderer/index.html:20` |
| `Setup you can change` | Morrow app | `installer/shared/setup-view.mjs:232` |
| `Materials folder` | Morrow app | `installer/shared/setup-view.mjs:181` |
| `Where to get help` | Morrow app | `installer/shared/setup-view.mjs:468` |
| `Assistant` | Morrow app progress rail | `installer/shared/setup-view.mjs:14` |
| `Morrow Bridge` | Morrow app progress rail | `installer/shared/setup-view.mjs:89` |
| `Course` | Morrow app progress rail | `installer/shared/setup-view.mjs:51` |
| `Connect a Blackboard Learn site (optional)` | Morrow app | `installer/renderer/index.html:50` |
| `Morrow setup` | Setup guide | `connector/extension/onboarding/onboarding.html:6` |
| `Plan and Edit settings` | Plan and Edit settings | `connector/extension/settings/settings.html:6` |
| `Morrow Bridge: Plan and Edit settings` | Plan and Edit settings browser tab | `connector/extension/settings/settings.html:6` |
| `Connected courses` | Plan and Edit settings | `connector/extension/settings/settings.html:28` |
| `Course access` | Plan and Edit settings | `connector/extension/settings/settings.html:102` |
| `Course file access` | Plan and Edit settings | `connector/extension/settings/settings.html:83` |

---

## 11. Findings

The first-run setup inconsistencies recorded in the earlier inventory are resolved in the current
source. The Chrome outcome, popup, setup guide, desktop app, README, and public setup pages use
**Connect Canvas** or **Connect Moodle** after detection. All setup summaries use three high-level
stages. The materials folder is optional. The desktop rail marks no ordinary stage as current while
repair is required. Plan and Edit settings reports a failed status read as not checked and offers
**Refresh connected courses**.

One earlier finding remains outside the setup work:

**F-1. "This page has not approved any changes" can appear beside an approve button.**
`packages/mcp-server/src/approval-server.ts:810-811` shows the split-into-smaller-groups copy whenever
any review context is `limited`, and `packages/mcp-server/src/approval-server.ts:815` removes the
approve control only when a named target is missing. On the usual path both happen together. A
limited context that still returns named targets can leave the copy and the control in conflict.
This approval-page issue does not block first-run setup and was not changed in this setup pass.

---

## 12. What this file does not settle

- Nobody ran the installed app. The Mac and Windows first-run experience, the installers, signing,
  notarization, update and rollback are unproven here.
- Nobody opened Chrome. Whether Chrome shows its permission request after the awaited work in
  `connector/extension/popup/popup.js:133-150` needs a person in Chrome. The popup has a state for
  Chrome not showing it (`connector/extension/popup/popup-view.js:27`), and that state has not been
  seen.
- Nobody used a screen reader. Live-region behaviour, reading order, and how the popup's four regions
  (`connector/extension/popup/popup.html:14`, `connector/extension/popup/popup.html:15`,
  `connector/extension/popup/popup.html:27`, `connector/extension/popup/popup.html:28`) sound in
  sequence are unverified.
- No live LMS was used. Every course state above comes from a state built in a test, not from Canvas,
  Moodle or Blackboard.
- Rendered layout, contrast in the real windows, and focus visibility were not inspected.
