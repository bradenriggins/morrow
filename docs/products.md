# Products

The Morrow family ships two products from this monorepo. They share a philosophy and nothing else: separate directories, separate version lines, and separate local check suites.

## Morrow Desktop (`desktop/`)

The desktop app plus Morrow Bridge, its Chrome extension. An educator downloads Morrow Desktop for a Mac with Apple silicon and macOS 13 or later, or for Windows 10 or Windows 11, follows the in-app setup, and connects the assistant they already use: the ChatGPT desktop app, Claude Desktop, Claude Code, or Gemini CLI. So far, only OpenAI's Codex CLI, which uses Morrow's ChatGPT setup, has been checked on a live Canvas test course. The ChatGPT desktop app, Claude Desktop, Claude Code, and Gemini CLI setups have passed Morrow's own tests only.

- Works with Canvas and Moodle through the Chrome window where the educator is already signed in. Selected Canvas tasks have been checked on live test courses, and part of the Moodle catalog on a Moodle test course.
- Can also connect to a Blackboard course once the school's Blackboard administrator sets up Morrow's connection, but no live Blackboard site has been tested yet.
- Every course starts in Plan: changes are reviewed before they are saved. Edit access can be granted per course and per type of change, and it stays on until the educator turns it off.
- After each approved change, Morrow checks what the LMS actually saved and reports back.

Start: [`desktop/README.md`](../desktop/README.md). Current limits: [`desktop/LIMITATIONS.md`](../desktop/LIMITATIONS.md).

## Morrow for Muse (`morrow-for-muse/`)

The 0.4.6 release includes the Canvas connector and a separate
Moodle HTTPS module. Canvas uses the educator's browser sign-in and the
live-proven operation catalog. The Moodle module has public-demo proof and a
site capability probe, but this package does not connect a signed-in Muse
browser session to that module or enforce Plan/Edit approval for its writes.
See `morrow-for-muse/SCOPE.md` for each provider's exact scope and evidence.

- Canvas Plan and Edit: reading a course never needs approval, and Plan asks before each change. Edit is one grant, for the account or for one conversation, to make changes without asking each time. It has no time limit: it stays on until the educator turns it off.
- Morrow Direct: our open format that describes each course-site action Morrow can take and how it runs. It lives inside Morrow for Muse until a second product uses it.
- Privacy boundary: Canvas student identifiers are replaced with course-scoped labels before supported records reach the assistant. Moodle instructions restrict analytics to approved course-level aggregates. See `morrow-for-muse/privacy/`.
- Capability claims follow provider-specific evidence. Canvas actions use the live-proven operation catalog; the Moodle module probes site capabilities after it has a session. See `morrow-for-muse/SCOPE.md` and `morrow-for-muse/moodle/README.md`.

Start: [`morrow-for-muse/SKILL.md`](../morrow-for-muse/SKILL.md). Current scope: [`morrow-for-muse/SCOPE.md`](../morrow-for-muse/SCOPE.md).
