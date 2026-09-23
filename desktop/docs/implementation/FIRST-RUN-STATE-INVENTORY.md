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

One page, two views, reached through a two-item nav (`installer/renderer/index.html:19`): Home
(`installer/renderer/index.html:24`) and Settings (`installer/renderer/index.html:47`). Only one is on
screen at a time; the other is inert, `display: none` (D8, D9).

**Home** carries the setup wizard, and once it is done, status and example requests, and nothing to
change: header (`installer/renderer/index.html:12`), welcome (`installer/renderer/index.html:25`),
progress rail (`installer/renderer/index.html:32`), action panel (`installer/renderer/index.html:36`).

**Settings** carries the setup a person can change (`installer/renderer/index.html:48`), an updates
section that appears only when there is an update record (`installer/renderer/index.html:53`), two
closed disclosures (Blackboard (`installer/renderer/index.html:61`) and what stays on this computer at
`installer/renderer/index.html:102`), and a support footer that names this Morrow and where to write
(`installer/renderer/index.html:112`).

Two facts apply to every row, so they are stated once:

- **Keyboard.** Every control in the action panel is a `<button>`. `render()` replaces the whole panel
  (`installer/renderer/renderer.js:586`), and it saves the focused control's `data-action` before the
  replacement and restores it after (`installer/renderer/renderer.js:166`,
  `installer/renderer/renderer.js:581`, `installer/renderer/renderer.js:602`). A control that is
  disabled while Morrow works keeps its place: the key is held
  (`installer/renderer/renderer.js:607`) and focus returns when the step finishes. The header
  **Check status** button (`installer/renderer/index.html:15`) is outside the panel and survives every
  re-render. The Home and Settings nav buttons (`installer/renderer/index.html:19-22`) are outside the
  panel too, and follow the same rule.
- **If a step fails.** Every step goes through `invoke()` (`installer/renderer/renderer.js:636`), which
  writes one message and one recovery into `#problem`, a `role="alert"` region
  (`installer/renderer/index.html:38`, `installer/renderer/renderer.js:240`): no preload bridge gives
  "Morrow setup is unavailable." / "Restart Morrow, then check status again."
  (`installer/renderer/renderer.js:638`); a malformed answer gives "Morrow returned an incomplete setup
  state." / "Check status again." (`installer/renderer/renderer.js:646`); a rejected call gives
  "Morrow could not check setup." / "Check status again." (`installer/renderer/renderer.js:653`); a
  handled failure shows the step's own message (`installer/renderer/renderer.js:649`). The alert is
  rewritten only when its text changes (`installer/renderer/renderer.js:233`), so returning to the
  window does not read the same error again.

| State | What the person sees | Next action | Renders at |
| --- | --- | --- | --- |
| `first-paint` | "Checking Morrow setup…" alone; the action panel is hidden; the rail shows three stages, each "Not checked yet"; the header live region says "Checking setup"; **Check status** is disabled | None. The read answers and replaces this state. `respond()` catches its own failures and always answers, so this state ends unless the main process never settles `installer:get-state` | `installer/renderer/index.html:39`, `installer/renderer/renderer.js:577`, `installer/shared/setup-view.mjs:101` |
| `setup-unavailable` | "Morrow could not read its setup state." / "Morrow could not read the setup record it keeps on this computer, so it cannot show which steps are complete. No setup step ran." and "No setup state was returned" | **Check again** in the panel | `installer/shared/setup-view.mjs:637` |
| `repair` | "Repair Morrow before you connect a course." / "Morrow did not confirm that its local runtime is ready. No course connection or course action will start from this state." The three-stage rail marks no ordinary setup stage as current and says the assistant is waiting for repair. | **Repair Morrow**, or **Check again** | `installer/shared/setup-view.mjs:339` |
| `claude-checking` | "Morrow is checking the Claude Desktop connection." / "Claude Desktop started Morrow, and Morrow is confirming that the Claude Desktop app on this computer started it. On a busy computer this can take a minute. Morrow keeps checking on its own. Select Check setup to see the result." | **Check setup**, or **Open Claude Desktop**. The Claude Desktop launcher asks again on its own until it can confirm the app. | `installer/shared/setup-view.mjs:352` |
| `claude-pending` | "Finish setting up Claude Desktop." / "Morrow prepared its extension for Claude Desktop. Install it there, then return here to check the connection." | **Open Claude Desktop**, install **Morrow.mcpb** through **Settings > Extensions > Advanced settings > Install Extension**, then **Check setup**. **Show Morrow extension** opens its folder. | `installer/shared/setup-view.mjs:360` |
| `no-assistant` | "Choose your assistant." / "Morrow configures only the assistant you choose. Your course sign-in remains separate in Chrome." with one card per assistant. The optional materials-folder choice is closed by default. | Select a card, then **Set up ChatGPT** (the button names the chosen assistant). With no supported assistant, install one and use the header **Check status**. | `installer/shared/setup-view.mjs:370` |
| `materials-default-missing` | "Morrow cannot find its Materials folder." / "Morrow keeps course materials in its own Materials folder, and that folder is gone. Your assistant cannot use Morrow until Morrow has a materials folder again." with the folder's path. Shown instead of `runtime-not-ready`, because the runtime cannot start without the folder. | **Make the folder again** makes a new, empty folder in the same place and writes no assistant, or **Choose folder**. | `installer/shared/setup-view.mjs:381` |
| `materials-chosen-missing` | "Morrow cannot find your materials folder." / "The folder may have been moved, renamed, or deleted, or it may be on a drive that is not connected. Your assistant cannot use Morrow until Morrow has a materials folder again." with the folder's path. Morrow never makes a folder the person chose. | Connect the drive, then **Check again**, or **Choose folder**. | `installer/shared/setup-view.mjs:389` |
| `runtime-not-ready` | "Morrow is getting ready." / "Morrow will show the next Bridge step when its local runtime is ready. It will not open Chrome setup before then." | Keep Morrow open, then use the header **Check status**. | `installer/shared/setup-view.mjs:397` |
| `delivery-blocked` | "Morrow Bridge is not available yet." / "Your assistant can be ready while the Chrome connection is still unavailable. Morrow will not suggest an unverified installation route." | Use the header **Check status** after Bridge delivery is available. | `installer/shared/setup-view.mjs:405` |
| `reload-required` | "Reload Morrow Bridge." and three exact Chrome actions | Reload it on **Manage Extensions**, then **Check Bridge**. | `installer/shared/setup-view.mjs:413` |
| `bridge-update-available` | "Update Morrow Bridge." / "This Morrow app includes newer Bridge files. Update the app-owned Bridge folder, then reload the extension in Chrome. This does not change your course." | **Update Bridge**. Morrow updates the folder and asks Morrow Bridge to reload; when it cannot, the `reload-required` steps follow. Shown only while a Bridge is connected; a failed update names only **Update Bridge** and Chrome's **Reload**. | `installer/shared/setup-view.mjs:421` |
| `folder-not-ready` | "Morrow Bridge is not ready to open." / "Morrow could not verify its Bridge folder." | **Repair Morrow**, or **Check again**. | `installer/shared/setup-view.mjs:429` |
| `dev-temporary` | "Add Morrow Bridge." and the temporary Chrome method in five exact substeps | **Show Bridge folder**, use **Manage Extensions**, **Developer mode**, and **Load unpacked**, then select **Connect Morrow** and **Check Bridge**. Also shown when the app has newer Bridge files and no Bridge is connected: **Check Bridge** then replaces the folder with the newer files first. | `installer/shared/setup-view.mjs:437` |
| `store-available` | "Install Morrow Bridge." / "Morrow Bridge uses the learning platform where you are already signed in. It asks Chrome for access only to the exact learning platform you choose." | Add it from the Chrome Web Store, select **Connect Morrow**, then **Check Bridge**. | `installer/shared/setup-view.mjs:445` |
| `not-paired` | "Connect Morrow Bridge." / "<assistant> is configured. Open Morrow Bridge in Chrome and select Connect Morrow." | Select **Connect Morrow**, then **Check Bridge**. | `installer/shared/setup-view.mjs:454` |
| `no-course` | "Open your course in Chrome." / "Morrow Bridge identifies Canvas or Moodle after you open a signed-in course." | Open and sign in to a course. In Morrow Bridge select **Connect Canvas** or **Connect Moodle**, allow the exact address, then in **Plan and Edit settings** select **Connect selected courses in Plan**. | `installer/shared/setup-view.mjs:462` |
| `preview-ready` | "Check your course connection." / "Morrow will read <course> to confirm the connection. This check does not change the course." | **Check connection**. | `installer/shared/setup-view.mjs:480` |
| `preview-preparing` | "Morrow cannot read your course yet." / "Open your Canvas or Moodle course in Chrome and make sure you are signed in, then select Check status." Also shown after a **Check connection** read fails, with the problem "Morrow could not read your course." | Open the course in Chrome, sign in, then use the header **Check status**. | `installer/shared/setup-view.mjs:490` |
| `preview-completed` | "Your course is connected." / "Morrow read <course> successfully. Continue in <assistant> and ask what you want to do, for example:" | Three status lines (Assistant, Morrow Bridge, Courses), each one state word and one action (**Manage**, **Check Bridge**, **Check connection**), then continue in the assistant or select **Copy** on one of the three example requests (D8). Setup is complete. | `installer/shared/setup-view.mjs:472` |
| `move-required` | "Move Morrow to Applications." / "Morrow is running from the disk image or a download folder. An assistant set up from here would lose Morrow when that place goes away." Setup offers nothing else on a Mac copy outside Applications. | **Move to Applications**; Morrow moves itself and opens again from there | `installer/shared/setup-view.mjs:526` |
| `assistant-repoint` | "Update your assistant settings." / "Your assistant still starts Morrow from the place Morrow was before it moved." | **Repair Morrow**, or **Check again** | `installer/shared/setup-view.mjs:535` |
| `assistant-restart` | "Quit and reopen your assistant." / "<assistant> reads its settings only when it starts. It cannot use Morrow until you open it again." Shown instead of `preview-completed` until the assistant's own Morrow session has connected once. | Quit and reopen the assistant, start a new chat, then **Check <assistant>** | `installer/shared/setup-view.mjs:517` |

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
- "Update Morrow Bridge."
- "This Morrow app includes newer Bridge files. Update the app-owned Bridge folder, then reload the extension in Chrome. This does not change your course."
- "Morrow Bridge is not ready to open."
- "Morrow could not verify its Bridge folder. Repair Morrow to restore the folder from the copy included with the app."
- "Add Morrow Bridge."
- "Use this temporary Chrome method until Morrow Bridge is available in the Chrome Web Store."
- "Install Morrow Bridge."
- "Morrow Bridge uses the learning platform where you are already signed in. It asks Chrome for access only to the exact learning platform you choose."
- "Connect Morrow Bridge."
- "<assistant> is configured. Open Morrow Bridge in Chrome and select Connect Morrow."
- "Open your course in Chrome."
- "Morrow Bridge identifies Canvas or Moodle after you open a signed-in course."
- "Check your course connection."
- "Morrow will read <course> to confirm the connection. This check does not change the course."
- "Morrow cannot read your course yet."
- "Open your Canvas or Moodle course in Chrome and make sure you are signed in, then select Check status."
- "Your course is connected."
- "Morrow read <course> successfully. Continue in <assistant> and ask what you want to do."
- "Morrow could not read its setup state."
- "Morrow could not read the setup record it keeps on this computer, so it cannot show which steps are complete. No setup step ran."

The progress rail runs Assistant, Morrow Bridge, Course
(`installer/shared/setup-view.mjs:113`) and marks one step current
(`installer/shared/setup-view.mjs:134`, `installer/shared/setup-view.mjs:161`). The header live region
follows the same order (`installer/shared/setup-view.mjs:94`) so it never announces a step later than
the panel. The rail stays on screen after setup too, all three steps marked done; the action panel
below it is what changes to the three status lines and the example requests (D8).

On the Settings view. "Setup you can change", Updates, the Blackboard connection, what stays on this
computer and Support all moved off Home onto Settings (D8, D9), reached through the app nav
(`installer/renderer/index.html:19-22`). `setupManagementView` shows the materials folder and one row
per assistant in every state once an assistant is configured or waiting for approval, and never in
`repair` (`installer/shared/setup-view.mjs:275-282`), so neither the folder nor the assistant list is
reachable only from the first screen, and removal options no longer follow the success message on
Home. The Blackboard and retention panels are disclosures reachable through their `<summary>`.

| State | What the person sees | Next action | Renders at |
| --- | --- | --- | --- |
| `home-settings-nav` | Two buttons, **Home** and **Settings**, the active one marked current | Select **Settings** to reach the setup a person can change, Updates, Blackboard, what stays on this computer and Support; select **Home** to return | `installer/renderer/index.html:19-22`, `installer/renderer/renderer.js:533-539` |
| `home-status-lines` | Once the first read is complete: three status lines (Assistant "Ready", Morrow Bridge "Connected", Courses "Connected"), each with one action | **Manage** opens Settings; **Check Bridge** reconciles the Bridge; **Check connection** re-runs the first read | `installer/shared/setup-view.mjs:292-299` |
| `manage-setup` | "Setup you can change", the materials folder, and one row per assistant on this computer | Change the folder, add another assistant, or remove one | `installer/shared/setup-view.mjs:275-282` |
| `folder-unset` | "Materials folder" says Morrow creates and uses its own Materials folder unless the person wants another location. On the first screen it is inside **Optional: Choose another materials folder**, closed by default. | **Choose folder** | `installer/shared/setup-view.mjs:225` |
| `folder-missing` | The path of the folder Morrow was using and "Morrow cannot find this folder." No sentence says Morrow makes a folder here. | **Make the folder again** (Morrow's own folder only), or **Choose folder** | `installer/shared/setup-view.mjs:205-208` |
| `folder-set` | The folder's path, and what changing it does to each configured assistant | **Change folder** | `installer/shared/setup-view.mjs:228-233` |
| `assistant-configured` | The assistant's name and "Morrow is set up in this assistant." | **Remove**, and for Claude Desktop the note that it must also be removed inside Claude Desktop | `installer/shared/setup-view.mjs:238`, `installer/shared/setup-view.mjs:254`, `installer/shared/setup-view.mjs:261` |
| `assistant-pending` | "Waiting for your approval in Claude Desktop." | **Open Claude Desktop**, **Show Morrow extension**, **Check setup**, or **Remove** | `installer/shared/setup-view.mjs:239`, `installer/shared/setup-view.mjs:249` |
| `assistant-available` | "Not set up yet." | **Set up <assistant>** | `installer/shared/setup-view.mjs:241`, `installer/shared/setup-view.mjs:256` |
| `assistant-absent` | "Not found on this computer." or "Not available in this Morrow version." | None. The row carries no control | `installer/shared/setup-view.mjs:240` |
| `updates-hidden` | Nothing | None. No update record | `installer/renderer/renderer.js:254-259` |
| `updates-unavailable` | "This copy of Morrow does not update itself. Get newer versions from meetmorrow.app/download." | None. Newer versions come from the download page | `installer/renderer/renderer.js:248-253` |
| `updates-idle` | "Morrow checks for updates automatically. You can also check now." or "Morrow is ready to check for an update." | **Check for updates** | `installer/renderer/renderer.js:263-266` |
| `updates-checking` | "Morrow is checking for an update." | None. It answers itself | `installer/renderer/renderer.js:268-271` |
| `updates-downloading` | "Morrow found version N and will download it in the background." or "Morrow is downloading … You can keep working while it finishes." | None. It answers itself | `installer/renderer/renderer.js:273-278` |
| `updates-held` | "Morrow will restart after course work finishes or its current state is clear." | None. Morrow restarts when the work is settled | `installer/renderer/renderer.js:281-284` |
| `updates-install-failed` | "Morrow could not install the update. Try again when course work is idle." | **Try restart again** | `installer/renderer/renderer.js:286-289` |
| `updates-ready` | "Version N is ready." and "Restart Morrow when course work is idle to finish the update." | **Restart to update** | `installer/renderer/renderer.js:291-292` |
| `updates-installing` | "Morrow is installing its update. It will reopen when the update is complete." | None. Morrow reopens | `installer/renderer/renderer.js:295-298` |
| `updates-rolled-back` | "The update did not start; Morrow is running version N." | **Retry the update** | `installer/renderer/renderer.js:300-305` |
| `updates-no-space` | "Morrow could not download the update: this computer does not have enough free space for it." | Free space, then **Try again** | `installer/renderer/renderer.js:307-310` |
| `updates-check-failed` | "Morrow could not check for an update." | **Try again** | `installer/renderer/renderer.js:312-313` |
| `blackboard-hidden` | Nothing | None. The panel appears only after an assistant is configured and the local runtime is ready, so the first screen never asks for credentials | `installer/shared/setup-view.mjs:47-49`, `installer/renderer/renderer.js:425` |
| `blackboard-empty` | "Connect a Blackboard Learn site (optional)", "Most people do not need this…" and four fields | Ask a Blackboard administrator for the key and secret, then **Save Blackboard connection** | `installer/renderer/index.html:61-92`, `installer/renderer/renderer.js:442` |
| `blackboard-invalid` | One message under each field that is not ready, and focus moves to the first of them | Correct the named field. Messages clear as the value becomes right | `installer/renderer/renderer.js:926-935`, `installer/renderer/renderer.js:1004-1007` |
| `blackboard-saved` | "Blackboard REST API configured. Live Blackboard access has not been tested.", and the saved site, account and stored name in one row | Saving verifies the integration account and opens a native chooser for the courses returned by Blackboard. **Remove connection** takes the connection and its secret off this computer | `installer/renderer/renderer.js:440-441`, `installer/renderer/renderer.js:398-418` |
| `blackboard-save-failed` | The step's own problem in `#problem`; the secret field is cleared and the web address and key keep what was typed | Correct the value and save again | `installer/renderer/renderer.js:979-986` |
| `blackboard-removal-failed` | The step's own problem in `#problem`; the saved connection row and its courses stay exactly as they are | Check status, then remove it again | `installer/renderer/renderer.js:838-854`, `installer/main.cjs:761-778` |
| `retention` | "What stays on this computer", every path this installation keeps, and which ones Morrow can remove. When Claude Desktop has its own copy of the Morrow extension, that folder is listed as kept, with the step that removes it in Claude Desktop under Settings, Extensions | Optional: **Remove Morrow's data** | `installer/shared/setup-view.mjs:605-627` |
| `retention-partial` | "Morrow could not remove everything", the paths removed and the paths still on this computer | Close what is using them, then remove again, or remove them by hand | `installer/shared/setup-view.mjs:569` |
| `removal-announced` | Nothing on screen. The result of a removal is read once in a `role="status"` region, in the words the section shows, because focus stays on the button that ran it | None. It repeats what the section already shows | `installer/shared/setup-view.mjs:662-660`, `installer/renderer/index.html:109`, `installer/renderer/renderer.js:504` |
| `support` | "Where to get help", the Morrow version, the materials folder, the folder Morrow keeps its setup record in, and the support address | Select **Support** to open the support page in the default browser; Morrow opens no other page from here (D5) | `installer/shared/setup-view.mjs:637-646`, `installer/renderer/renderer.js:494-498` |

---

## 3. Chrome connection page

There is none. **Connect Morrow** in the popup, or **Reconnect Morrow** in the popup or setup guide,
pairs in one step. Morrow sends a challenge, and Morrow Bridge signs it with the secret in the
active-folder marker of the Bridge folder Morrow set up, which no HTTP request can read. Morrow
answers only that proof with its token (`packages/bridge-loopback/src/index.ts`,
`connector/extension/src/service-worker.js`). The Morrow app serves no page that approves a
connection.

---

## 4. Morrow Bridge popup

The popup reads the current Bridge state, then uses a read-only active-tab probe when it needs to
name the active signed-in platform. The probe returns only `canvas`, `moodle`, or no match; it saves
no course or account value (`connector/extension/src/service-worker.js:3611`).

Every control is a native button. A control that does not apply is hidden, which removes it from the
tab order (`connector/extension/popup/popup.js:60`). The help disclosure uses the same three stages as the app and website:
choose the assistant, finish Morrow Bridge, then open and connect the course
(`connector/extension/popup/popup.html:33-35`).

**One primary action for the present tab (WI-5.8).** Once Morrow is paired and connected, the popup
keeps exactly one of three outcomes: **Connect this course** (a Canvas or Moodle course is detected
in the active tab and not yet connected), **Open Canvas** or **Open Moodle** (the saved course or
site's own tab needs reopening), or no primary action at all. The wording never names a platform for
the connect case, because the person already sees what the active tab shows; reopening the saved
connection keeps the platform's own name, because that is a specific, already-granted place to return
to (`connector/extension/popup/popup-view.js:160-175`, `connector/extension/popup/popup.js:157-162`).

**The popup as home (WI-5.8).** Below the status line, up to 5 connected courses show by name with
their own D7 state text ("Plan. Asks first.", "Edit. Routine edits.", and so on, the
same wording Plan and Edit settings uses), then **All courses**, which opens Plan and Edit
settings. With no connected course the list stays out of the page entirely
(`connector/extension/popup/popup-view.js:19-52`, `connector/extension/popup/popup.js:90-101`).

**The privacy text (WI-5.8).** "What Morrow Bridge can read" shows in full until the person accepts
it. After acceptance the popup keeps one link with that same name instead of repeating the paragraph
(`connector/extension/popup/popup.html:13-17`, `connector/extension/popup/popup.js:112-115`).

| State | What the person sees | Next action | Renders at |
| --- | --- | --- | --- |
| `read-failed` | Morrow and Course are "Not checked". The detail names the failed read and retry. | **Try again**. | `connector/extension/popup/popup-view.js:201` |
| `not-paired` | Morrow "Not connected", Course "Not connected", and the detail says to add Morrow to the assistant and that connecting approves no change. | **Connect Morrow**. | `connector/extension/popup/popup-view.js:210` |
| `connecting` | Morrow "Connecting…" and a settled waiting detail. | No action. Return in a moment. | `connector/extension/popup/popup-view.js:212` |
| `paired-not-connected` | Morrow "Not available" and the popup says the assistant must be open. | Open the assistant. | `connector/extension/popup/popup-view.js:214` |
| `runtime-mismatch` | Morrow "Reload needed", Course "Not available", and a version-mismatch detail. | Reload Morrow Bridge on the Chrome extensions page, then open the popup; if the versions still differ, follow the Morrow app's Morrow Bridge step. **Open setup guide** shows the same step. | `connector/extension/popup/popup-view.js:202` |
| `authentication-failed` | Morrow "Reconnect needed", Course "Not connected", and the detail says Morrow refused the saved connection. | **Reconnect Morrow**, which connects again in one step. | `connector/extension/popup/popup-view.js:208` |
| `connected-no-site` | Morrow "Connected", Course "Not connected", no primary action, and instructions to open a signed-in course. | Open a signed-in Canvas or Moodle course in this tab. | `connector/extension/popup/popup-view.js:225` |
| `detected-platform` | The active course is detected. The primary action and detail both say **Connect this course**, on Canvas or Moodle alike. | Select **Connect this course** and allow the exact address Chrome shows. | `connector/extension/popup/popup-view.js:191` |
| `site-ready-no-course` | Course "Ready", **Choose courses**, and a Plan explanation. | **Choose courses**, which opens Plan and Edit settings. | `connector/extension/popup/popup-view.js:220` |
| `site-stale` | Course "Canvas is closed" and the detail names the saved Canvas connection. | Select **Open Canvas** to reopen it (WI-1.1). | `connector/extension/popup/popup-view.js:197` |
| `course-ready` | Course "Connected", the selected course and last-check time, and a detail that names the Canvas course tab. | Ask the assistant, or use **Check or switch course**. | `connector/extension/popup/popup-view.js:216` |
| `course-tab-closed` | Course "Canvas is closed" and a detail that names the closed Canvas tab. | Select **Open Canvas** to reopen it (WI-1.1). | `connector/extension/popup/popup-view.js:193` |

The exact status, course, action, and detail strings emitted for these branches are:

- "Not checked"
- "Try again"
- "Morrow could not read this connection state. Select Try again. If the state does not change, close this popup and open it again."
- "Not connected"
- "Connect Morrow"
- "Add Morrow to your assistant, then open it. Select Connect Morrow to connect this extension to Morrow. Connecting does not approve changes to your courses."
- "Connecting…"
- "Waiting for your assistant"
- "Connecting to Morrow. Keep this popup open or return in a moment."
- "Not available"
- "Open the assistant where you added Morrow. This popup will reconnect when Morrow is ready."
- "Reload needed"
- "Open setup guide"
- "The Morrow app and Morrow Bridge versions do not match. Reload Morrow Bridge on the Chrome extensions page, then open the Morrow Bridge popup. If the versions still do not match, open the Morrow app and follow its Morrow Bridge step."
- "Reconnect needed"
- "Reconnect Morrow"
- "Morrow refused the connection Morrow Bridge saved. Select Reconnect Morrow to connect again. Your selected courses stay saved."
- "Connected"
- "" (no primary action)
- "Open a signed-in Canvas or Moodle course in Chrome. Morrow Bridge will detect the platform and show Connect this course."
- "Connect this course"
- "Morrow Bridge detected Moodle. Select Connect this course to allow access to this signed-in course."
- "Ready"
- "Choose courses"
- "Choose courses in Plan and Edit settings. Plan keeps changes ready for your review."
- "Canvas is closed"
- "Open Canvas"
- "The saved Canvas connection is no longer open. Select Open Canvas to reopen it."
- "This selected course is connected. Keep one signed-in Canvas course tab open while you work in Morrow."
- "This selected course is connected, but its Canvas tab is no longer open. Select Open Canvas to reopen it."

A saved Canvas course with an active Moodle tab gives a separate mismatch detail. It tells the person
to select **Open Canvas** to reopen the selected course, or open the detected Moodle course
themselves (`connector/extension/popup/popup-view.js:183`).

Failures reach one `role="alert"` banner as stable problem codes. Each known code gives what happened,
why, and one next action; an unknown code remains visible instead of becoming a generic success
(`connector/extension/src/bridge-problem-copy.js:17`, `connector/extension/src/bridge-problem-copy.js:309-314`).

**Waiting for your review (WI-2.4, D1b).** When the runtime's `ui_state` command has left one or more
reviews with the Bridge, the popup shows a section named "Waiting for your review" above the rest of
the connection state, with one button per review reading "Review: `<label>`"
(`connector/extension/popup/popup.html:22-24`, `connector/extension/popup/popup-view.js:26`). With no
review waiting the section is absent from the page (`connector/extension/popup/popup.js:60-66`). A
click opens the address named on the button; a tab already open at that exact address is made active
instead of a second one being opened (`connector/extension/popup/popup.js:68-75`). The Bridge never
opens a review tab by itself; the person always starts from a click here or from the link the
assistant gave them. The runtime supplies this list only after a review's state changes; a source not
in this card's files, `connector/extension/src/service-worker.js`, must add `reviews` to the object its
`status()` function answers (`connector/extension/src/service-worker.js:5977`) before this list is
populated outside a test.

---

## 5. Morrow Bridge setup guide

The guide opens after Bridge installation or from **Open setup guide**. **Guide me** shows one next
action. **Setup overview** shows the same three stages as the app, popup, and website
(`connector/extension/onboarding/onboarding.html:19-47`). The five readiness checks remain detailed evidence inside those three stages.

| State | What the person sees | Next action | Renders at |
| --- | --- | --- | --- |
| `read-failed` | "Setup state not checked", five explicit not-checked lines, and a detail that names **Setup overview**. | **Setup overview**, or return to this tab to read again. | `connector/extension/onboarding/onboarding-state.js:57` |
| `not-paired` | "Setup in progress" and "Open Morrow" with the exact assistant and Bridge connection action. | Open Morrow, choose the assistant, then **Connect Morrow**. | `connector/extension/onboarding/onboarding-state.js:205` |
| `authentication-failed` | "Reconnect needed" / "Reconnect Morrow", with the same detail the popup shows. | **Reconnect Morrow**, which connects again in one step. | `connector/extension/onboarding/onboarding-state.js:192` |
| `connecting` | "Connecting Morrow" and a waiting detail. | No action. Return in a moment. | `connector/extension/onboarding/onboarding-state.js:199` |
| `paired-not-connected` | "Open Morrow again" and the assistant recovery. | Open Morrow and choose the assistant again. | `connector/extension/onboarding/onboarding-state.js:211` |
| `runtime-mismatch` | "Morrow Bridge needs a reload" / "Reload Morrow Bridge" with version detail. | Reload Morrow Bridge, then open the Morrow Bridge popup; if the versions still differ, follow the Morrow app's Morrow Bridge step. | `connector/extension/onboarding/onboarding-state.js:217` |
| `connected-no-site` | "Open Canvas or Moodle" and the exact platform-detection behavior. | Open a signed-in course, then select **Connect this course** in the popup. | `connector/extension/onboarding/onboarding-state.js:225` |
| `site-saved-not-verified` | "Reconnect Canvas" and a detail that names the saved Canvas course. | Select **Open Canvas** in the popup, or open the course, and sign in if asked. | `connector/extension/onboarding/onboarding-state.js:224` |
| `site-ready-no-course` | "Select a course in Plan" and the exact final course-selection control. | **Open Plan and Edit settings**, then **Connect** on a course under Not connected. | `connector/extension/onboarding/onboarding-state.js:231` |
| `course-ready` | "One step left" / "Try a first read" and the exact request to ask. | Ask the assistant for the read. | `connector/extension/onboarding/onboarding-state.js:237` |
| `ready` | "Ready to use" / "Plan your first change" after a named first read. | Ask the assistant for a change. Plan holds it for review. | `connector/extension/onboarding/onboarding-state.js:185` |

The exact heading, summary, next action, detail, and checklist strings emitted for these branches are:

- "Setup state not checked"
- "Morrow could not read this setup state, so no line below states a current result."
- "Follow the setup steps"
- "Morrow could not read this setup state, so it cannot name one next step. Select Setup overview to see the three stages. This guide reads the state again when you return to this tab."
- "Connection to Morrow is not checked"
- "Morrow Bridge connection is not checked"
- "Morrow version is not checked"
- "Course connection is not checked"
- "First read is not checked"
- "Setup in progress"
- "Morrow checks the assistant, this connection, your selected course and the first read each time this guide opens."
- "Open Morrow"
- "Open Morrow and choose your assistant. Then return to Morrow Bridge and select Connect Morrow."
- "Morrow Bridge is not set up to work with Morrow yet"
- "Morrow Bridge is not connected to Morrow"
- "Morrow version is checked when Morrow Bridge connects"
- "No Canvas or Moodle course is connected"
- "No first read is completed yet"
- "Reconnect needed"
- "Morrow no longer accepts the connection Morrow Bridge saved, so it needs to connect again."
- "Reconnect Morrow"
- "Morrow refused the connection Morrow Bridge saved. Select Reconnect Morrow to connect again. Your selected courses stay saved."
- "Morrow no longer accepts this saved connection, so it needs to connect again"
- "Connecting Morrow"
- "Morrow is connecting. This guide reads the state again when you return to this tab."
- "Keep your assistant open while Morrow connects. Return here in a moment."
- "Morrow Bridge is set up to work with Morrow on this computer. Morrow Bridge sees the connection, not your assistant itself."
- "Morrow Bridge is connecting to Morrow"
- "Open Morrow again"
- "Open Morrow and choose your assistant again. Then return to Morrow Bridge."
- "Morrow Bridge needs a reload"
- "Morrow and Morrow Bridge report different versions, so Morrow Bridge cannot confirm which course actions Morrow can use."
- "Reload Morrow Bridge"
- "Morrow and Morrow Bridge report different versions. Reload Morrow Bridge on the Chrome extensions page, then open the Morrow Bridge popup. If the versions still do not match, open the Morrow app and follow its Morrow Bridge step."
- "Morrow Bridge reached Morrow, and Morrow expects a different version"
- "Morrow Bridge is connected to Morrow"
- "Morrow reports a different version from this Morrow Bridge"
- "Open Canvas or Moodle"
- "Open a Canvas or Moodle course in Chrome and sign in. The Morrow Bridge popup then shows Connect this course. Select it and allow Chrome access to the exact address shown."
- "Morrow matches this Morrow Bridge version and its list of course actions"
- "Reconnect Canvas"
- "Select Open Canvas in the Morrow Bridge popup, or open the saved Canvas course in Chrome yourself, and sign in if Canvas asks."
- "Saved Canvas needs sign-in or reconnection"
- "Select a course in Plan"
- "Open Plan and Edit settings. The courses on your signed-in site are listed under Not connected. Select Connect on a course. It connects in Plan."
- "Canvas is ready; select courses in Plan"
- "One step left"
- "1 selected course is ready in this Chrome session. One read from your assistant completes this setup."
- "Try a first read"
- "Return to your assistant and ask: Use Morrow to list the modules in my selected course."
- "1 selected course is ready"
- "Ready to use"
- "1 selected course is ready in this Chrome session. Morrow completed a first read in Biology 101."
- "Plan your first change"
- "Ask your assistant for a change in your selected course. Each change waits for your review unless you turned on Edit for that kind of change in that course."
- "First read completed in Biology 101"

The status dot is decorative, and every state also carries a heading, so colour alone never separates
waiting from ready (`connector/extension/onboarding/onboarding.html:26`).

### The five checks

The checklist reports the five states the completion goal names
(`connector/extension/onboarding/onboarding.html:28-34`). "Ready to use" is all five, so a connection
that has never read a course is not ready
(`connector/extension/onboarding/onboarding-state.js:164`).

| Element | What it reports | Renders at |
| --- | --- | --- |
| `assistant-check` | The connection the person made with **Connect Morrow**. Morrow Bridge cannot see the assistant window itself, and the line says so | `connector/extension/onboarding/onboarding.html:37` |
| `connection-check` | Whether Morrow Bridge holds an open connection to Morrow | `connector/extension/onboarding/onboarding.html:38` |
| `runtime-check` | Whether the Morrow this connection reached is the same build as this extension. Morrow names the connector identity it accepted, and the status read compares it with this extension, this connector revision and this exact list of course actions (`connector/extension/src/service-worker.js:2472-2481`) | `connector/extension/onboarding/onboarding.html:39` |
| `course-check` | How many selected courses are ready in this Chrome session | `connector/extension/onboarding/onboarding.html:40` |
| `read-check` | The course of the last read that returned. The service worker records the course and the time after a read answers ok, and replaces the record when a read succeeds in a different course (`connector/extension/src/service-worker.js:2066-2082`) | `connector/extension/onboarding/onboarding.html:41` |

Every line the five checks can render:

- `assistant-check`: "Connection to Morrow is not checked", "Morrow Bridge is not set up to work with Morrow yet", "Morrow no longer accepts this saved connection, so it needs to connect again", "Morrow Bridge is set up to work with Morrow on this computer. Morrow Bridge sees the connection, not your assistant itself."
- `connection-check`: "Morrow Bridge connection is not checked", "Morrow Bridge is not connected to Morrow", "Morrow Bridge is connecting to Morrow", "Morrow Bridge is connected to Morrow"
- `runtime-check`: "Morrow version is not checked", "Morrow version is checked when Morrow Bridge connects", "Morrow reports a different version from this Morrow Bridge", "Morrow matches this Morrow Bridge version and its list of course actions"
- `course-check`: "Course connection is not checked", "No Canvas or Moodle course is connected", "Saved Canvas needs sign-in or reconnection" (or Moodle), "Canvas is ready; select courses in Plan" (or Moodle), "1 selected course is ready" (or "2 selected courses are ready", and so on)
- `read-check`: "First read is not checked", "No first read is completed yet", "First read completed in Biology 101" (the recorded course, by name, or by "course" and its id when the record carries no name)

---

## 6. Plan and Edit settings

This page carries more than first-run setup. The rows below are the states a person meets while
connecting their first course. The Edit stage that follows them (choosing individual actions, a
duration, and confirming a flagged selection) is rendered at
`connector/extension/settings/settings.js:666-715` and
`connector/extension/settings/settings.html:98-155`, and is outside first run.

Every control on this page is a native `<button>`, `<select>`, `<input>` or `<label>`, so all of it is
keyboard reachable. One `role="alert"` (`connector/extension/settings/settings.html:21`) carries
failures and one polite `role="status"` (`connector/extension/settings/settings.html:22`) carries
announcements; a failure arrives as a stable code, and its title, cause and next action are read
from `connector/extension/src/bridge-problem-copy.js:17` and written into the alert at
`connector/extension/settings/settings.js:344-347`, with the unexplained-code fallback at
`connector/extension/src/bridge-problem-copy.js:309-314`.

| State | What the person sees | Next action | Renders at |
| --- | --- | --- | --- |
| `settings-first-paint` | "Checking connected courses…", "Loading connected courses…", "Checking Chrome permission…"; **Refresh connected courses** is disabled during the read | None. The read answers and replaces these lines | `connector/extension/settings/settings.html:28`, `connector/extension/settings/settings.html:56`, `connector/extension/settings/settings.html:88`, disabled at `connector/extension/settings/settings.js:843` |
| `settings-read-failed` | The alert names the failure. The page says "Connected courses were not checked." and "Course access was not checked. Select Refresh connected courses." It shows no false loading state. | **Refresh connected courses**, re-enabled when the read ends | `connector/extension/settings/settings.js:556`, `connector/extension/settings/settings.js:618`, `connector/extension/settings/settings.js:712`, state set at `connector/extension/settings/settings.js:927` |
| `settings-no-anchor` | "Open a course in Canvas or Moodle. Morrow Bridge finds it." and, once a site is saved, **Open Canvas** or **Open Moodle** | Open a signed-in course in Chrome, then **Connect this course** in the popup | `connector/extension/settings/settings.js` `renderCourseList` |
| `settings-available-list` | Each signed-in site's own available courses under "Not connected", read by itself when the page opens | **Connect** on a course row | `connector/extension/settings/settings.js` `autoStartDiscovery`, `renderCourseRow` |
| `settings-more-available` | **Load more available courses** while any site has another page | **Load more available courses** | `connector/extension/settings/settings.js` `loadMoreCourses` |
| `settings-discovery-expired` | Nothing changes on screen. The rows stay; **Connect** or **Load more available courses** reads that site's list again first, and Connect tries once more if the Bridge answers that the list is old or missing | **Connect** again only if the course left the list | `connector/extension/settings/settings.js` `connectCourse`, `currentDiscoveryFor` |
| `settings-discovery-failed` | The alert names the failure and says to select **Refresh connected courses**; a background refresh does not retry it | **Refresh connected courses**, which reads every site's list again | `connector/extension/settings/settings.js` `readDiscovery`, refresh button listener |
| `settings-connected` | How many connected courses are ready to use, and how many need an open course tab or a reconnected site | Select a course, then keep Plan or choose Edit | `connector/extension/settings/settings.js:596-600` |
| `settings-file-access-off` | "Off. Morrow cannot access course file content." | Optional: **Enable course file access** | `connector/extension/settings/settings.js:729`, `connector/extension/settings/settings.html:92` |
| `settings-file-access-revoked` | "Off. Chrome permission was removed, so Morrow keeps course file access off." | Optional: **Enable course file access** again | `connector/extension/settings/settings.js:726` |

---

## 7. Review page

Reached from the assistant, on this computer only (`packages/mcp-server/src/approval-server.ts:67`).
Approve and cancel are `<button>` elements inside `<form method="post">`
(`packages/mcp-server/src/approval-server.ts:822-823`), so the decision works by keyboard and without
JavaScript; the search and pagination controls (`packages/mcp-server/src/approval-server.ts:803`) come
from the deferred script and only filter what is already on the page.

| State | What the person sees | Next action | Renders at |
| --- | --- | --- | --- |
| `review-awaiting` | A title naming the change, who asked for it, the destination, the requested values, any risk warning, and when approval expires | **Apply this change** (the label names the change; for a group, "Apply all N changes"), or **Cancel** | `packages/mcp-server/src/approval-server.ts:815-823` |
| `review-missing-names` | "Morrow could not identify the course or a selected item in Canvas." and "Nothing can be approved here until those details load. Check your Canvas connection, then reload this page." | Reload the page after the connection is working. The approve control is absent by design, and the server also refuses an approval in this state (`packages/mcp-server/src/approval-server.ts:1002`) | `packages/mcp-server/src/approval-server.ts:819-820`, `packages/mcp-server/src/approval-server.ts:822` |
| `review-target-absent` | "Canvas does not have the item this change names. It may have been renamed, moved, or removed since this change was prepared." and "Return to your assistant and ask Morrow to read the latest Canvas content and prepare a new review. This page has not changed anything." | Ask Morrow for a new review against the current content. The connection is working: Canvas answered and does not hold this item, so reloading changes nothing. | `packages/mcp-server/src/approval-server.ts:979` |
| `review-limited` | "Too many different courses or activities to review at once." and "Return to your assistant and ask Morrow to split this into smaller groups. This page has not approved any changes." | Ask the assistant for smaller groups. See finding F-6 | `packages/mcp-server/src/approval-server.ts:817-818` |
| `review-expired` | "Review expired" and "Return to the assistant where you started this request and ask Morrow for a new review. Check the new request before approving it." | Ask the assistant for a new review. The page has no control | `packages/mcp-server/src/approval-server.ts:604`, reached at `packages/mcp-server/src/approval-server.ts:705` |
| `review-unavailable` | "Review unavailable" and "This review may have expired or the request may have changed… Do not repeat the change until Morrow checks the saved result." | Ask the assistant to check the saved result. The page has no control | `packages/mcp-server/src/approval-server.ts:1037` |

---

## 8. Result page

One page per request after approval (`packages/mcp-server/src/approval-server.ts:806`). The state
region is `role="status"` and updates itself once a second while work is active
(`packages/mcp-server/src/approval-server.ts:140-158`). Except for **Stop remaining changes** on an
active group (`packages/mcp-server/src/approval-server.ts:805`), these states carry no control: the
next action is in the assistant, or is reloading the page. That is deliberate: the page reports what
Morrow saved and refuses to offer a repeat.

| State | What the person sees | Next action | Renders at |
| --- | --- | --- | --- |
| `approved` | "Changes not started" / "Your approval was saved, but this request is not running. Return to your assistant and ask Morrow to check this saved request before starting anything else." | Ask the assistant to check the saved request | `packages/mcp-server/src/approval-server.ts:601` |
| `verified` | "Canvas saved the change. Morrow checked the result." with the success mark, the item name, "Return to your assistant. It continues on its own." and "See recent changes" | None. This is the end state | `packages/mcp-server/src/approval-server.ts:602` |
| `cancelled` | "Request cancelled" / "Morrow will not start more changes for this request. Changes already sent may still finish…" | Ask the assistant to check the result | `packages/mcp-server/src/approval-server.ts:603` |
| `expired` | "Review expired" | Ask the assistant for a new review | `packages/mcp-server/src/approval-server.ts:604` |
| `dispatching` | "Applying your changes" / "Morrow will check the saved result in Canvas. This page updates automatically." plus "Keep your assistant and Chrome open while Morrow works." | None. Wait | `packages/mcp-server/src/approval-server.ts:605`, instruction `packages/mcp-server/src/approval-server.ts:596` |
| `running` | The same as `dispatching`. An approved request with work in flight is shown as running | None. Wait | `packages/mcp-server/src/approval-server.ts:606`, mapped at `packages/mcp-server/src/approval-server.ts:686` |
| `awaiting_verification` | "Check the result" / "Morrow could not confirm the saved result in Canvas. Return to your assistant and ask Morrow to check this saved request. Do not repeat the change." | Ask the assistant to check it | `packages/mcp-server/src/approval-server.ts:607` |
| `awaiting_inner_approval` | "Review needed" / "This request needs another approval before it can finish…" | Return to the assistant for the next review | `packages/mcp-server/src/approval-server.ts:608` |
| `applied_or_unknown` | "Result unconfirmed" / "Canvas may have received the changes… If Morrow cannot check it, open the item in Canvas and confirm it yourself. Do not repeat the change." | Ask the assistant to check it, or open the item and confirm it | `packages/mcp-server/src/approval-server.ts:609` |
| `closed_by_person` | "Closed after your check" / "Morrow did not check this change itself. It is closed because you read the item and confirmed the saved state…" | None | `packages/mcp-server/src/approval-server.ts:610` |
| `inspection_required` | "Check results" / "Canvas may have received some changes… Do not repeat the group of changes." | Ask the assistant to check each result | `packages/mcp-server/src/approval-server.ts:611` |
| `partial` | "Changes stopped" / "Return to the assistant where you started this request to see which changes finished and which still need attention…" | Ask the assistant which changes finished | `packages/mcp-server/src/approval-server.ts:612` |
| `paused` | "Work is paused" / "Morrow is not starting more changes. Work already sent may still finish…" | Ask the assistant to check or continue | `packages/mcp-server/src/approval-server.ts:613` |
| `completed` | "Check results" / "The work has stopped, but not every requested change has a confirmed result…" | Ask the assistant to check the saved results | `packages/mcp-server/src/approval-server.ts:614` |
| `failed` | "Request stopped" / "Return to the assistant where you started this request to find out what happened…" | Ask the assistant what happened | `packages/mcp-server/src/approval-server.ts:615` |
| `interrupted` | "Work stopped" / "Morrow is not running this request now. Return to your assistant and ask Morrow to check the saved result before trying again." | Ask the assistant to check the saved result | `packages/mcp-server/src/approval-server.ts:616`, mapped at `packages/mcp-server/src/approval-server.ts:687` |
| `no-change-sent` | "No change was sent" / "Morrow did not change anything in Canvas. Return to your assistant and ask Morrow to read the latest Canvas content and prepare a new review." | Ask the assistant for a new review | `packages/mcp-server/src/approval-server.ts:629`, condition `packages/mcp-server/src/approval-server.ts:618` |
| `same-target-blocked` | "Check earlier change" / "Morrow has not sent this change. An earlier change to the same target is still unresolved…" | Ask the assistant to check the earlier request | `packages/mcp-server/src/approval-server.ts:624`, condition `packages/mcp-server/src/approval-server.ts:619` |
| `historical-target-blocked` | "An earlier change from an older Morrow version is still unresolved, so Morrow has not sent this change. That earlier change has no saved check. Open the item it changed in Canvas, confirm it yourself, then ask Morrow for a new review." | Open the item and confirm it, then ask for a new review | `packages/mcp-server/src/approval-server.ts:622`, condition `packages/mcp-server/src/approval-server.ts:620` |
| `unknown-state` | "Check this request" / "The request has changed or can no longer be approved here. Return to your assistant and ask Morrow to check its current status." | Ask the assistant to check the status | `packages/mcp-server/src/approval-server.ts:630` |
| `group-progress` | How many of the group's changes are confirmed, beneath the state, and **Stop remaining changes** while the group is active | **Stop remaining changes**, or wait | `packages/mcp-server/src/approval-server.ts:693`, `packages/mcp-server/src/approval-server.ts:805` |
| `poll-failed` | "Morrow cannot refresh this result. Reload this page to check it. Do not repeat the change." | Reload the page | `packages/mcp-server/src/approval-server.ts:155` |

A state page names the platform the request belongs to, so a Moodle or Blackboard request does not
say Canvas (`packages/mcp-server/src/approval-server.ts:631`,
`packages/mcp-server/src/approval-server.ts:691`).

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
(`installer/renderer/renderer.js:355`; `installer/main.cjs:411` always answers unless
`installer.state()` never settles), and `updates-installing` ends only when the update process
restarts Morrow. Neither was observed here.

One state has a control but no working one: `no-assistant` on a computer with no supported assistant
shows "No supported assistant was found" with the setup button disabled
(`installer/shared/setup-view.mjs:143`, `installer/shared/setup-view.mjs:291`). The next action
(install an assistant, then check status) is named in the text, and the header **Check status** works.

---

## 10. Terminology: every user-facing control name

One row per control name per surface. `scripts/test/first-run-state-inventory.test.mjs` requires each
name to be on the line cited beside it, so a renamed control fails the test rather than leaving a
stale name here.

| Control name | Surface | Source |
| --- | --- | --- |
| `Check status` | Morrow app | `installer/renderer/index.html:15` |
| `Home` | Morrow app | `installer/renderer/index.html:20` |
| `Settings` | Morrow app | `installer/renderer/index.html:21` |
| `Manage` | Morrow app | `installer/shared/setup-view.mjs:280` |
| `Repair Morrow` | Morrow app | `installer/shared/setup-view.mjs:341` |
| `Check again` | Morrow app | `installer/shared/setup-view.mjs:341`, `installer/shared/setup-view.mjs:431` |
| `Open Claude Desktop` | Morrow app | `installer/shared/setup-view.mjs:362`, `installer/shared/setup-view.mjs:236` |
| `Show Morrow extension` | Morrow app | `installer/shared/setup-view.mjs:362`, `installer/shared/setup-view.mjs:237` |
| `Check setup` | Morrow app | `installer/shared/setup-view.mjs:362`, `installer/shared/setup-view.mjs:238` |
| `Choose an assistant` | Morrow app | `installer/shared/setup-view.mjs:172` |
| `Choose folder` | Morrow app | `installer/shared/setup-view.mjs:220`, `installer/shared/setup-view.mjs:220` |
| `Make the folder again` | Morrow app | `installer/shared/setup-view.mjs:207`, `installer/shared/setup-view.mjs:383` |
| `Change folder` | Morrow app | `installer/shared/setup-view.mjs:220` |
| `Show folder` | Morrow app | `installer/shared/setup-view.mjs:220` |
| `Copy path` | Morrow app | `installer/shared/setup-view.mjs:220`, `installer/shared/setup-view.mjs:327` |
| `Remove` | Morrow app | `installer/shared/setup-view.mjs:248`, `installer/renderer/renderer.js:405` |
| `Show Bridge folder` | Morrow app | `installer/shared/setup-view.mjs:439` |
| `Check Bridge` | Morrow app | `installer/shared/setup-view.mjs:281`, `installer/shared/setup-view.mjs:415` |
| `Update Bridge` | Morrow app | `installer/shared/setup-view.mjs:423` |
| `Check connection` | Morrow app | `installer/shared/setup-view.mjs:282`, `installer/shared/setup-view.mjs:482` |
| `Check for updates` | Morrow app | `installer/renderer/renderer.js:265` |
| `Restart to update` | Morrow app | `installer/renderer/renderer.js:292` |
| `Try restart again` | Morrow app | `installer/renderer/renderer.js:288` |
| `Retry the update` | Morrow app | `installer/renderer/renderer.js:304` |
| `Try again` | Morrow app | `installer/renderer/renderer.js:309` |
| `https://meetmorrow.app/support` | Morrow app | `installer/shared/setup-view.mjs:655` |
| `Save Blackboard connection` | Morrow app | `installer/renderer/index.html:92` |
| `Remove Morrow&#39;s data` | Morrow app | `installer/shared/setup-view.mjs:625` |
| `Connect Morrow` | Popup | `connector/extension/popup/popup.html:41`, `connector/extension/popup/popup-view.js:175` |
| `Try again` | Popup | `connector/extension/popup/popup-view.js:172` |
| `Waiting for your assistant` | Popup | `connector/extension/popup/popup-view.js:177` |
| `Choose courses` | Popup | `connector/extension/popup/popup-view.js:176` |
| `Connect this course` | Popup | `connector/extension/popup/popup-view.js:178` |
| `Open Canvas` | Popup | `connector/extension/popup/popup-view.js:137` |
| `Open Moodle` | Popup | `connector/extension/popup/popup-view.js:138` |
| `All courses` | Popup | `connector/extension/popup/popup.html:38` |
| `What Morrow Bridge can read` | Popup | `connector/extension/popup/popup.html:17` |
| `Waiting for your review` | Popup | `connector/extension/popup/popup.html:24` |
| `Ask first in all courses` | Popup | `connector/extension/popup/popup.html:29` |
| `Check or switch course` | Popup | `connector/extension/popup/popup.html:42` |
| `Disconnect Morrow` | Popup | `connector/extension/popup/popup.html:44` |
| `Open Plan and Edit settings` | Popup | `connector/extension/popup/popup.html:46` |
| `Open setup guide` | Popup | `connector/extension/popup/popup.html:48` |
| `How to connect` | Popup | `connector/extension/popup/popup.html:50` |
| `Guide me` | Setup guide | `connector/extension/onboarding/onboarding.html:29` |
| `Setup overview` | Setup guide | `connector/extension/onboarding/onboarding.html:30` |
| `Open Plan and Edit settings` | Setup guide | `connector/extension/onboarding/onboarding.html:49`, `connector/extension/onboarding/onboarding.html:49` |
| `Ask first in all courses` | Plan and Edit settings | `connector/extension/settings/settings.html:23` |
| `Refresh connected courses` | Plan and Edit settings | `connector/extension/settings/settings.html:35` |
| `Open Canvas or Moodle when Morrow needs it.` | Plan and Edit settings | `connector/extension/settings/settings.html:148` |
| `Select` | Plan and Edit settings | `connector/extension/settings/settings.html:50` |
| `Connect` | Plan and Edit settings | state set at `connector/extension/settings/settings.js:909` |
| `Show more` | Plan and Edit settings | `connector/extension/settings/settings.html:57` |
| `Load more available courses` | Plan and Edit settings | `connector/extension/settings/settings.html:60` |
| `Plan. Ask first.` | Plan and Edit settings | `connector/extension/settings/settings.html:65` |
| `Edit. Routine edits.` | Plan and Edit settings | `connector/extension/settings/settings.html:66` |
| `Enable course file access` | Plan and Edit settings | `connector/extension/settings/settings.html:161`, `connector/extension/settings/settings.js:1536` |
| `Turn on course file access` | Plan and Edit settings | `connector/extension/settings/settings.js:1536` |
| `Remove HTTPS file access` | Plan and Edit settings | `connector/extension/settings/settings.html:162` |
| `Return selected courses to Plan` | Plan and Edit settings | `connector/extension/settings/settings.html:121` |
| `Save Edit access` | Plan and Edit settings | `connector/extension/settings/settings.html:122`, `connector/extension/settings/settings.js:840` |
| `Review and save` | Plan and Edit settings (WI-5.5 Customize view summary bar) | `connector/extension/settings/settings.js:1510` |
| `Keep reviewing` | Plan and Edit settings | `connector/extension/settings/settings.html:131` |
| `Save Edit access anyway` | Plan and Edit settings | `connector/extension/settings/settings.html:132` |
| `Open Canvas` | Plan and Edit settings | `connector/extension/settings/settings.js:436` |
| `Open Moodle` | Plan and Edit settings | `connector/extension/settings/settings.js:437` |
| `Apply this change` | Review page | `packages/mcp-server/src/approval-server.ts:1192` |
| `Add this question` | Review page | `packages/mcp-server/src/approval-server.ts:1192` |
| `Change this text` | Review page | `packages/mcp-server/src/approval-server.ts:1192` |
| `Add alternative text` | Review page | `packages/mcp-server/src/approval-server.ts:1192` |
| `Mark as decorative` | Review page | `packages/mcp-server/src/approval-server.ts:1192` |
| `Cancel` | Review page | `packages/mcp-server/src/approval-server.ts:1210` |
| `Technical details` | Review page | `packages/mcp-server/src/approval-server.ts:1176` |
| `Find a change` | Review page | `packages/mcp-server/src/approval-server.ts:1173` |
| `Stop remaining changes` | Result page | `packages/mcp-server/src/approval-server.ts:1175` |

Names a person reads as landmarks rather than presses:

| Name | Surface | Source |
| --- | --- | --- |
| `Set up Morrow on this computer` | Morrow app | `installer/renderer/index.html:28` |
| `Setup you can change` | Morrow app | `installer/shared/setup-view.mjs:268` |
| `Materials folder` | Morrow app | `installer/shared/setup-view.mjs:220` |
| `Where to get help` | Morrow app | `installer/shared/setup-view.mjs:679` |
| `Assistant` | Morrow app progress rail | `installer/shared/setup-view.mjs:143` |
| `Morrow Bridge` | Morrow app progress rail | `installer/shared/setup-view.mjs:144` |
| `Course` | Morrow app progress rail | `installer/shared/setup-view.mjs:145` |
| `Connect a Blackboard Learn site (optional)` | Morrow app | `installer/renderer/index.html:64` |
| `Morrow setup` | Setup guide | `connector/extension/onboarding/onboarding.html:6` |
| `Plan and Edit settings` | Plan and Edit settings | `connector/extension/settings/settings.html:15` |
| `Morrow Bridge: Plan and Edit settings` | Plan and Edit settings browser tab | `connector/extension/settings/settings.html:6` |
| `Your courses` | Plan and Edit settings | `connector/extension/settings/settings.html:32` |
| `Course access` | Plan and Edit settings | `connector/extension/settings/settings.html:74` |
| `Course file access` | Plan and Edit settings | `connector/extension/settings/settings.html:154` |

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
`packages/mcp-server/src/approval-server.ts:817-818` shows the split-into-smaller-groups copy whenever
any review context is `limited`, and `packages/mcp-server/src/approval-server.ts:822` removes the
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
