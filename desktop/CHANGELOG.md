# Changelog

Release notes for Morrow Desktop. Tags use the form `desktop/vX.Y.Z` (see [docs/versioning.md](../docs/versioning.md)). Installers are on [GitHub Releases](https://github.com/bradenriggins/morrow/releases). Releases before 1.0.5 have no entry here.

## 1.0.5 (2026-09-22)

Unsigned installers: `Morrow-1.0.5-mac-arm64.dmg`, `Morrow-1.0.5-mac-arm64.zip`, and `Morrow-1.0.5-win-x64.exe`. Ships with Morrow Bridge 1.0.120.

This release fixes every Critical and High defect found in the adversarial audits after the 2026-09-22 handoff.

### Approvals and Edit access

- A change is approved only with a Morrow Bridge signature from the educator's own Chrome tab. A local program can no longer approve a change with a bare HTTP request.
- Edit access has no time limit. Old timed grants fall back to Plan and are never extended.
- A review that is waiting ends when its Morrow connection ends.

### Morrow Bridge

- The popup shows Edit status and can return a course to Plan.
- Settings and the popup show the Edit actions a course allows, and one course can be disconnected on its own.
- Course lists are read again after they expire, keep every site's courses, show true counts, and use natural order.
- When a course site is closed, Morrow names the right button: Open Canvas or Open Moodle.
- Long permission and privacy text is behind disclosures. Setup, recovery, and help text name only controls that exist.

### Setup

- The ChatGPT configuration no longer writes `required = true`. Morrow finds, repairs, and removes its own assistant entry by structure, not by text matching, and names each reason it refuses a change.
- A "Quit and reopen" step checks that the assistant really connected.
- On a Mac, Morrow offers to move itself to Applications when it runs from somewhere else.
- The exact Bridge folder is shown with a Copy button. Long folder paths wrap.
- Claude Desktop detection is real, including the Microsoft Store (MSIX) install on Windows.
- Removal keeps a settings file's own permissions and refuses a read-only file.
- On a busy Windows computer, confirming the Claude Desktop app could take longer than Morrow waited, and Morrow then asked for approval in Claude Desktop again. Morrow now waits up to 10 seconds, says it is still checking, and checks again on its own. Messages between Claude Desktop and Morrow keep flowing during the check.
- Morrow starts faster on Windows: it checks each private file once per start instead of once per read.
- A newer Morrow Bridge in the app no longer stops setup when Chrome has not loaded the Bridge or is closed. Update Bridge appears only while Morrow Bridge is connected. With no Bridge connected, Check Bridge replaces the Bridge folder with the newer files. A failed update names only the steps on the Update screen.
- When an open assistant or a running change keeps Morrow busy, saving, choosing, or removing a Blackboard connection says so. It no longer blames the web address, key, or secret.
- Remove Morrow's data, and any other step an open assistant blocks, says to quit the assistant. It no longer says to wait for work that never ends.
- When the materials folder is moved, renamed, deleted, or on a drive that is not connected, Home names the folder and offers Choose folder, and Make the folder again for Morrow's own folder. It no longer says Morrow is getting ready.
- What stays on this computer, the uninstall steps, and the removal confirmation name the copy of the Morrow extension Claude Desktop keeps, and say to remove Morrow in Claude Desktop under Settings, Extensions. They no longer say that Remove Morrow's data stops every assistant from starting Morrow.
- The app says where unsigned builds get updates. The Mac note now says that moving Morrow to Applications can ask for an administrator password.

### Privacy

- Learner ids inside grade, submission, and profile links are replaced with labels.
- Each student has one label everywhere. Real names reach the educator only through Morrow Bridge in their own tab (Private Chat and the review tab). Every HTTP endpoint serves labels only.
- Private Chat reads a sentence start correctly through quotes and line breaks.

### Interface

- Supporting text fills its container instead of wrapping early.
- Each setup state has one primary action, and the connected Home is clearer.

### Build and CI

- CI reads workflows from the repository root, runs each product's suite when it changes, and runs both suites when a workflow changes. The aggregate check fails when change detection fails.
- Dependabot points at the real manifests. The pre-commit hook runs each product's suite from its own directory.
- Both release jobs preflight the signed release configuration. The installer layout check runs with the browser harnesses.

### Not verified for this release

- Live Canvas, Moodle, or Blackboard runs of the new flows.
- Windows-specific paths (Store Claude Desktop detection, locked files) on a real Windows host.
- Signed builds: signing secrets do not exist yet, so this release is unsigned.
