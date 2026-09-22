# Products

The Morrow family ships two products from this monorepo. They share a philosophy and nothing else: separate directories, separate version lines, separate CI suites.

## Morrow Desktop (`desktop/`)

The desktop app plus Morrow Bridge, a Manifest V3 Chrome extension. An educator downloads Morrow for Mac or Windows, follows the in-app setup, and connects the assistant they already use: ChatGPT, Claude Desktop, Claude Code, or Gemini CLI.

- Works with Canvas and Moodle through the Chrome session the educator is already signed into, plus a configured Blackboard course through the Anthology Learn REST API.
- Every course starts in Plan: changes are reviewed before they are saved. Edit access can be granted per course and per type of change.
- After each approved change, Morrow checks what the LMS actually saved and reports back.

Start: [`desktop/README.md`](../desktop/README.md). Current limits: [`desktop/LIMITATIONS.md`](../desktop/LIMITATIONS.md).

## Morrow for Muse (`morrow-for-muse/`)

The VM-native connector for Muse. The educator signs into Canvas or Moodle once on their Muse VM; every lane after that is pure API, with no laptop dependency.

- Plan and Edit modes: reads never need approval, Plan asks before writes, Edit is one blanket grant to make changes without asking each time.
- Morrow Direct: our open manifest standard for direct LMS REST, zero MCP. It lives inside Morrow for Muse until a second consumer exists.
- Privacy boundary: student identifiers are replaced with course-scoped labels before course information reaches the assistant. See `morrow-for-muse/privacy/`.
- Capability claims follow the proof battery: an operation ships only when it is marked `live-proven` in `morrow-for-muse/proof-battery/OPERATION_CATALOG.md`.

Start: [`morrow-for-muse/SKILL.md`](../morrow-for-muse/SKILL.md). Exact v1 scope: [`morrow-for-muse/SCOPE.md`](../morrow-for-muse/SCOPE.md).
