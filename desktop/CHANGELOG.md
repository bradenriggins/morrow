# Changelog

Release notes for Morrow Desktop. Tags use the form `desktop/vX.Y.Z` (see [docs/versioning.md](../docs/versioning.md)). Installers are on [GitHub Releases](https://github.com/bradenriggins/morrow/releases). Releases before 1.0.5 have no entry here.

## 1.0.5 (2026-09-23)

Unsigned installers: `Morrow-1.0.5-mac-arm64.dmg`, `Morrow-1.0.5-mac-arm64.zip`, and `Morrow-1.0.5-win-x64.exe`. Ships with Morrow Bridge 1.0.123.

This release fixes the problems a full review of Morrow found before release. Technical notes for developers are at the end.

### Approvals and Edit access

- A change is approved only from Morrow Bridge in your own Chrome tab. Another program on your computer can no longer approve a change.
- Morrow Bridge pairs with Morrow only when you select Connect Morrow, and only with a proof from the Bridge folder Morrow set up. Another program on your computer can no longer connect itself to Morrow in place of Morrow Bridge and then approve changes. The Chrome page that asked you to allow the connection is gone.
- Edit access has no time limit. Old timed grants fall back to Plan and are never extended.
- When your assistant asks to turn on Edit, it gives you a link to a Morrow page that names each course and kind of change. Edit turns on only when you open that page in Chrome, with Morrow Bridge connected, and select Turn on Edit. Before, Edit turned on when you accepted a prompt in your assistant. Actions that remove content are turned on only in Morrow Bridge Plan and Edit settings.
- Turn on Edit on an Edit access review adds the kinds of change your assistant asked for to what the course already has. It used to end every other Edit choice for that course, including removals you turned on in Plan and Edit settings. After you turn Edit on, the page lists every change Morrow now makes without asking.
- Your assistant can no longer ask for Edit on an action that can change many settings at once, such as Edit an assignment. Edit never covered those actions, and Morrow still asks before each one, but the review page used to list them as changes Morrow makes without asking.
- A review that is waiting ends when its Morrow connection ends.
- A change Morrow could not check is closed only by you, on its page in Chrome, with "I checked it in Canvas: close this change". Morrow Bridge confirms your own click, as for an approval. Your assistant can no longer close it for you.
- When Morrow reads the learning platform after a change and the platform does not hold the approved result, the change shows Did not save as approved and the assistant is told it failed. Before, it showed Needs checking, as if Morrow could not read the result. A change Morrow could not compare still shows Needs checking.
- Routine Edit and the publish choice no longer create a Canvas page, or publish a new front page, without your review. When the page is not there, or Morrow cannot read it, the change waits for your review.
- The Routine edits description names every change the routine set makes with no review, including making Canvas folders, moving files between folders, and moving module items. It describes only the platforms you selected.
- The date choice is named Change due dates and availability dates, and says what it changes on each platform.
- In Plan, a course's detail says that "Edit. Routine edits." turns on every routine edit, and that Customize or "do not ask again" on a review turns on a single kind.
- When a course connection closes before a change goes out, or Morrow cannot first read the course's Edit access, Morrow says nothing was sent. It no longer says the platform may have received the change and holds that item for a check.
- In a group of changes, a change whose answer from the learning platform was lost shows Needs checking instead of Did not finish, and the group pauses before its next change.
- In a group of changes, a change that the learning platform did not save as approved is reported to your assistant as failed, as its review page shows, and the group pauses before its next change. It used to be reported as one that needs checking.
- Recent changes offers a Reverse change request only for a change that was sent. A cancelled or failed request says nothing was sent, so there is nothing to undo.
- While a review of a group of changes is open, or Morrow is applying approved work, the assistant keeps waiting. It says you approved only when you did.
- After your computer sleeps, Chrome restarts, or Morrow Bridge reloads, the popup lists the reviews that still wait, and an open review tab can approve again.
- Replies about a group of requests no longer name Canvas for a Moodle or Blackboard course.

### Morrow Bridge

- The popup shows Edit status and can return a course to Plan.
- Settings and the popup show the Edit actions a course allows, and one course can be disconnected on its own.
- Course lists are read again after they expire, keep every site's courses, show true counts, and use natural order.
- When a course site is closed, Morrow names the right button: Open Canvas or Open Moodle.
- Long permission and privacy text is behind disclosures. Setup, recovery, and help text name only controls that exist.
- Open Canvas and Open Moodle reopen the course's own site. They used to open another saved site's home page and report success.
- When Morrow and Morrow Bridge versions do not match, the popup says Reload needed, and the popup and the setup guide give the same reload step.
- Connect Morrow with the Morrow app closed says Morrow is not running.
- When Morrow refuses the saved connection, the setup guide offers Reconnect Morrow, as the popup does. The popup's main button does what its label says.
- The settings page is named Plan and Edit settings, the name every link to it uses. Its error messages stay on screen after the page reads the course list again.
- The course search also finds a site address, a term, or a platform.
- With no course connected, Plan and Edit settings names the step that connects one: Connect this course in the Morrow Bridge popup.
- A closed course is listed as closed, with Open Canvas or Open Moodle, even when its Edit access is out of date.
- The popup says when a course was connected. It used to call that date the last check.
- The setup guide no longer says every change waits for your review when a course is in Edit.
- When Chrome keeps site access after Disconnect Morrow, the popup says to remove it on the Chrome extensions page.
- Private Chat waits up to 9 minutes for your next message and up to 10 minutes for the assistant's reply. It used to end after one minute.
- After you send a Private Chat message, the drawer says it is waiting for the assistant's reply.
- A Private Chat follow-up that names no student, such as "Make it shorter", can be sent without a student list.
- A Private Chat message that was not sent says why and what to do, and keeps your text.
- At its 100-message limit, Private Chat ends after the last reply, and the drawer says how to start a new chat.
- When Morrow Bridge is not connected, or another Private Chat is already open, Private Chat says so and names the step that fixes it.

### Setup

- ChatGPT and Codex now start even when Morrow cannot. Morrow finds, repairs, and removes its own entry in their settings file and leaves the rest of the file as it was. When it cannot change the file, it says why.
- A "Quit and reopen" step checks that the assistant really connected.
- On a Mac, Morrow offers to move itself to Applications when it runs from somewhere else.
- The start, repair, Bridge update, and move steps use plain words. Update Bridge says that Morrow asks Chrome to reload Morrow Bridge, and the move step says Morrow is not in your Applications folder. It used to say Morrow ran from a disk image or a download folder.
- The exact Bridge folder is shown with a Copy button. Long folder paths wrap.
- Morrow really checks whether Claude Desktop is installed, including Claude Desktop from the Microsoft Store on Windows.
- Removal keeps a settings file's own permissions and refuses a read-only file.
- On a busy Windows computer, confirming the Claude Desktop app could take longer than Morrow waited, and Morrow then asked for approval in Claude Desktop again. Morrow now waits up to 10 seconds, says it is still checking, and checks again on its own. Messages between Claude Desktop and Morrow keep flowing during the check.
- Morrow starts faster on Windows: it checks each private file once per start instead of once per read.
- A newer Morrow Bridge in the app no longer stops setup when Chrome has not loaded the Bridge or is closed. Update Bridge appears only while Morrow Bridge is connected. With no Bridge connected, Check Bridge replaces the Bridge folder with the newer files. A failed update names only the steps on the Update screen.
- When an open assistant or a running change keeps Morrow busy, saving, choosing, or removing a Blackboard connection says so. It no longer blames the web address, key, or secret.
- Remove Morrow's data, and any other step an open assistant blocks, says to quit the assistant. It no longer says to wait for work that never ends.
- When the materials folder is moved, renamed, deleted, or on a drive that is not connected, Home names the folder and offers Choose folder, and Make the folder again for Morrow's own folder. It no longer says Morrow is getting ready.
- What stays on this computer, the uninstall steps, and the removal confirmation name the copy of the Morrow extension Claude Desktop keeps, and say to remove Morrow in Claude Desktop under Settings, Extensions. They no longer say that Remove Morrow's data stops every assistant from starting Morrow.
- Morrow finds Gemini CLI by reading its installed package instead of running it, so detection no longer writes to your Gemini folder and no longer misses a slow first start.
- The app says where unsigned builds get updates. The Mac note now says that moving Morrow to Applications can ask for an administrator password.
- Setting up or updating Morrow Bridge no longer fails when Windows is slow.
- Errors from the Settings page now show on the Settings page.
- The Materials folder row has Show folder and Copy path, because the folder Morrow makes sits inside a folder macOS and Windows hide.
- Canvas file uploads can use files you put in the Materials folder, as Moodle uploads already could.
- Check connection says when Morrow could not read your course, with the step to fix it. It no longer calls that course connected.
- Selecting Check Bridge before Chrome reloaded Morrow Bridge names the reload step.
- Blackboard error steps name only the fields and buttons the form shows. The saved connection note says a new secret needs the application key too.
- The Windows uninstall steps name the Settings page each version shows: Installed apps, then More and Uninstall on Windows 11, and Apps & features, then Uninstall on Windows 10.
- "What stays on this computer" lists only what is on this computer, and says which part Remove Morrow's data removes and which part Morrow never removes.
- After Change folder, "What stays on this computer" names the Materials folder Morrow made first, and Remove Morrow's data removes it with its files. It used to leave that folder behind and say Morrow removed its data.
- Repair Morrow finishes when Claude Desktop is set up. It used to stop with "Morrow has work in progress".
- Morrow starts more reliably on a slow or busy computer. Its course connection starts faster, and Morrow waits the full 30 seconds its first start is allowed instead of giving up after 15.

### Privacy

- Student IDs inside grade, submission, and profile links are replaced with labels.
- Each student has one label everywhere. Real names appear only in Morrow Bridge in your own Chrome tab (Private Chat and the review tab). Any other program on your computer that asks Morrow for course information gets labels only.
- Private Chat reads a sentence start correctly through quotes and line breaks.
- Morrow Bridge forgets the student names a review page showed 15 minutes after the page last showed them, even when nothing else changes, and a Bridge that reconnects no longer gets old names back.
- A first name used alone, such as Will or Grace, is replaced only where it is written with a capital letter, as a family name already was. In small letters it is usually an ordinary word, and replacing it put the student's full name into text the assistant saved. A name part in a script with no capital letters, such as Korean, is now replaced wherever it appears.
- A student's family name written alone, such as "Adams replied.", is replaced with the student's label in Private Chat and in course text the assistant reads, where it is written with a capital letter. A suffix such as Jr. is not taken for the family name.
- Private Chat replaces a student's ID number or a login made only of numbers, and refuses a message that still holds one.
- A student's name is replaced inside running text in Chinese, Japanese, and Thai, with a Korean particle attached, and after a one-letter Arabic or Hebrew prefix, in Private Chat and in course text the assistant reads. Before, it reached the assistant as written.
- A student's name is replaced when it is written with a curly apostrophe or another hyphen, as in O’Brien or Smith‑Jones, with a capital İ, or without its accents. Private Chat and course text the assistant reads now replace the same names.
- A student's name is replaced when it is written without a letter's stroke or with a letter written as two letters, as in Lukasz for Łukasz, Soren for Søren, Dorde for Đorđe, Yildiz for Yıldız, or Weiss for Weiß. These reached the assistant as written.
- A Chinese, Japanese, or Korean name the roster stores with no space, such as 王小明 or 김민준, is split after its family name, so the given name used alone, such as 小明 or 민준, is replaced. It reached the assistant as written.

### Interface

- Supporting text uses the full width of its area instead of wrapping early.
- Each setup state has one primary action, and the connected Home is clearer.
- In "Try asking", every Copy button sits in the same place: at the right edge, or under its example in the narrowest windows.
- The Edit banner in Plan and Edit settings stacks in a narrow window, so its sentence uses the full width.
- What a screen reader announces in the header matches the step on screen.
- Manage on Home moves focus to the Settings heading.

### Not verified for this release

- The new steps on live Canvas, Moodle, or Blackboard courses.
- Connect Morrow in an everyday Chrome with the Bridge folder an installed Morrow set up. Morrow's own tests run the same step in a test copy of Chrome with a test folder.
- The Windows-only cases, such as Claude Desktop from the Microsoft Store and files another program keeps open, on a real Windows computer.
- Signed installers: this release is not signed by Apple or Microsoft.

### Technical notes

- CI runs the repository text checks (no em dash and no retired phrase anywhere in the repository) on every change. When the desktop changes, it runs the desktop suite on Linux, and the installer contracts and every desktop test Linux skips on Windows and on macOS. When Morrow for Muse changes, it runs the Muse suite. A workflow change runs every suite, and the required check fails when change detection fails.
- Morrow no longer writes `required = true` into the Codex configuration, and it finds its own entry there by the file's structure, not by text matching.
- Claude Desktop detection covers the Microsoft Store (MSIX) install.
- Dependabot reads the real manifests and groups its updates into weekly pull requests, and workflow actions run on their current releases. The pre-commit hook runs each product's suite from its own directory.
- Both release jobs preflight the signed release configuration. The installer layout check runs with the browser harnesses. The release procedure smoke-tests the exact installers it publishes.
- Morrow builds with TypeScript 7 and tests with Vitest 5, type-checked against the Node release the app embeds.
- An installed Morrow ignores the start settings that only Morrow's own tests use.
- The Windows packager starts pnpm with no shell.
