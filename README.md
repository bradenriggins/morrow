# Morrow

You should not have to wait for your institution to buy and roll out a separate course assistant.

Morrow connects the AI assistant you already use to your Canvas and Moodle courses, so you can build and review real course work: plan courses and create approved lessons, activities, discussions, assignments, and modules; build, review, and improve New Quizzes and Item Banks down to each question and setting; check course items for accessibility problems and fix them, map curriculum, and prepare accreditation evidence. After each approved change, Morrow checks what your course site saved.

Selected Canvas tasks have been checked on live test courses, and part of the Moodle catalog on a Moodle test course. Morrow Desktop can also connect to Blackboard, but no live Blackboard site has been tested yet. Working with several connected courses at once has not been tested on live courses yet.

Morrow is and always will be free and open source.

## The products

This is a monorepo. Each product lives in its own directory, ships on its own version line, and has its own local check suite.

| Product | Directory | What it is |
|---|---|---|
| Morrow Desktop | `desktop/` | The desktop app plus Morrow Bridge, its Chrome extension. Download it for a Mac with Apple silicon and macOS 13 or later, or for Windows 10 or Windows 11, connect the ChatGPT desktop app, Claude Desktop, Claude Code, or Gemini CLI, and work with the courses your account can open. So far, only OpenAI's Codex CLI, which uses Morrow's ChatGPT setup, has been checked on a live Canvas test course. The ChatGPT desktop app, Claude Desktop, Claude Code, and Gemini CLI setups have passed Morrow's own tests only. Start at [`desktop/README.md`](desktop/README.md). |
| Morrow for Muse | `morrow-for-muse/` | The connector that runs on your Muse computer. It supports Canvas and Moodle through separate sign-in and session lanes. Canvas actions use the Canvas catalog; Moodle checks each site's available capabilities before it acts. Start at [`morrow-for-muse/SKILL.md`](morrow-for-muse/SKILL.md). |

## How Morrow works, in every product

**Choose. Ask. Review.** Choose the courses your account can open, ask for the work, and review the result. Morrow checks each approved change against the course and tells you when something still needs attention.

**Plan first.** Morrow starts each course in Plan, so you review proposed changes before they are saved. Edit lets your assistant save changes without asking each time: in Morrow Desktop you grant it per course and per type of change, and in Morrow for Muse you turn it on for your account or for one conversation. After each approved change, Morrow checks what the LMS saved, and your assistant tells you what happened.

**Your sign-in stays yours.** Morrow does not store your school password, and your assistant never receives your password, cookies, or other sign-in details. In Morrow Desktop, your Canvas or Moodle sign-in stays in Chrome, and Morrow Bridge uses it there. Blackboard works differently: your administrator gives you an application key and secret, and the Morrow app keeps them in a file on your computer that only your user account can open. In Morrow for Muse, you sign in to Canvas or Moodle on your Muse computer. Each platform has a separate connection flow.

**Student privacy is built into each connection.** Morrow Desktop and the Canvas lane for Muse replace known student identifiers with course-specific labels before course records reach the assistant. Muse's Moodle analytics use approved course-level aggregates instead of individual student records. Each product documents the limits of its privacy protections: see the [Morrow Desktop limits](desktop/LIMITATIONS.md#learner-privacy) and the [Morrow for Muse privacy limits](morrow-for-muse/privacy/FERPA_POLICY.md#known-limitations-honest-scope).

**Start with the course access you already have.** Morrow gives educators direct tools for the courses they already manage. It never gives anyone new access.

## Repository layout

- `desktop/`: Morrow Desktop. The app, the Bridge extension, the MCP server, the installer, and product docs.
- `morrow-for-muse/`: Morrow for Muse. The connector, Morrow Direct, the dispatch engine, the privacy boundary, and the proof battery.
- `docs/`: family-level docs, the [product overview](docs/products.md) and [versioning](docs/versioning.md).
- `desktop/.githooks/`: local commit checks. GitHub Actions are disabled for this repository. The pre-commit hook runs repository text gates and the affected product's local checks for staged changes.

Install the pre-commit hook once from the repository root: `git config core.hooksPath desktop/.githooks`. A change to `desktop/` runs `pnpm check`; a change to `morrow-for-muse/` runs its Python tests, development suites, and carved-package install suites. The hook runs both product suites for shared files that both products use. Release and versioning details are in [`docs/versioning.md`](docs/versioning.md).

## Versioning

Each product versions and tags independently:

- `desktop/vX.Y.Z` for Morrow Desktop
- `muse/vX.Y.Z` for Morrow for Muse

See [`docs/versioning.md`](docs/versioning.md).

## Security

To report a security problem, email [hello@meetmorrow.app](mailto:hello@meetmorrow.app). Do not open a public issue for it. See [`SECURITY.md`](SECURITY.md).

## License

MIT. See [`LICENSE`](LICENSE).
