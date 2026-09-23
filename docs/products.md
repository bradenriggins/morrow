# Products

The Morrow family ships two products from this monorepo. They share a philosophy and nothing else: separate directories, separate version lines, separate CI suites.

## Morrow Desktop (`desktop/`)

The desktop app plus Morrow Bridge, its Chrome extension. An educator downloads Morrow for a Mac with Apple silicon or for Windows, follows the in-app setup, and connects the assistant they already use: the ChatGPT desktop app, Claude Desktop, Claude Code, or Gemini CLI. So far, only OpenAI's Codex CLI, which uses Morrow's ChatGPT setup, has been checked on a live Canvas test course. The ChatGPT desktop app, Claude Desktop, Claude Code, and Gemini CLI setups have passed Morrow's own tests only.

- Works with Canvas and Moodle through the Chrome window where the educator is already signed in. Selected Canvas tasks have been checked on live test courses, and part of the Moodle catalog on a Moodle test course.
- Can also connect to a Blackboard course once the school's Blackboard administrator sets up Morrow's connection, but no live Blackboard site has been tested yet.
- Every course starts in Plan: changes are reviewed before they are saved. Edit access can be granted per course and per type of change, and it stays on until the educator turns it off.
- After each approved change, Morrow checks what the LMS actually saved and reports back.

Start: [`desktop/README.md`](../desktop/README.md). Current limits: [`desktop/LIMITATIONS.md`](../desktop/LIMITATIONS.md).

## Morrow for Muse (`morrow-for-muse/`)

The connector that runs Morrow on the educator's Muse computer, with nothing to run on their own laptop. The educator signs in to Canvas on their Muse computer, and signs in again if Canvas ends the session. Version 1 supports Canvas only; Moodle is not in this release (see `morrow-for-muse/SCOPE.md`).

- Plan and Edit: reading a course never needs approval, and Plan asks before each change. Edit is one grant, for the account or for one conversation, to make changes without asking each time. It has no time limit: it stays on until the educator turns it off.
- Morrow Direct: our open format that describes each course-site action Morrow can take and how it runs. It lives inside Morrow for Muse until a second product uses it.
- Privacy boundary: student identifiers are replaced with course-scoped labels before course information reaches the assistant. See `morrow-for-muse/privacy/`.
- Capability claims follow the proof battery: an operation ships only when it is marked `live-proven` in `morrow-for-muse/proof-battery/OPERATION_CATALOG.md`.

Start: [`morrow-for-muse/SKILL.md`](../morrow-for-muse/SKILL.md). Exact v1 scope: [`morrow-for-muse/SCOPE.md`](../morrow-for-muse/SCOPE.md).
