# Morrow

You should not have to wait for your institution to buy and roll out a separate course assistant.

Morrow connects the AI assistant you already use to your Canvas and Moodle courses, so you can build and review real course work: plan courses and create approved lessons, activities, discussions, assignments, and modules; build, review, and improve New Quizzes and Item Banks down to each question and setting; check course items for accessibility problems and fix them, map curriculum, and prepare accreditation evidence. After each approved change, Morrow checks what your course site saved.

Selected Canvas tasks have been checked on live test courses, and part of the Moodle catalog on a Moodle test course. Morrow Desktop can also connect to Blackboard, but no live Blackboard site has been tested yet. Working with several connected courses at once has not been tested on live courses yet.

Morrow is and always will be free and open source.

## The products

This is a monorepo. Each product lives in its own directory, ships on its own version line, and is tested by its own CI suite.

| Product | Directory | What it is |
|---|---|---|
| Morrow Desktop | `desktop/` | The desktop app plus Morrow Bridge, its Chrome extension. Download it for a Mac with Apple silicon or for Windows, connect ChatGPT, Claude, or Gemini, and work with the courses your account can open. Start at [`desktop/README.md`](desktop/README.md). |
| Morrow for Muse | `morrow-for-muse/` | The connector that runs Morrow on your Muse computer. You sign in to Canvas on your Muse computer, and sign in again if Canvas ends the session. Version 1 supports Canvas only. Includes Morrow Direct, our open format that describes each course-site action Morrow can take and how it runs. Start at [`morrow-for-muse/SKILL.md`](morrow-for-muse/SKILL.md). |

## How Morrow works, in every product

**Choose. Ask. Review.** Choose the courses your account can open, ask for the work, and review the result. Morrow checks each approved change against the course and tells you when something still needs attention.

**Plan first.** Morrow starts each course in Plan, so you review proposed changes before they are saved. Edit lets your assistant save changes without asking each time: in Morrow Desktop you grant it per course and per type of change, and in Morrow for Muse you turn it on for your account or for one conversation. After each approved change, Morrow checks what the LMS saved, and your assistant tells you what happened.

**Your sign-in stays yours.** Morrow never sees or saves your password, and your assistant never receives your password, cookies, or other sign-in details. In Morrow Desktop, your Canvas or Moodle sign-in stays in Chrome, and Morrow Bridge uses it there. Blackboard works differently: your administrator gives you an application key and secret, and the Morrow app keeps them in a file on your computer that only your user account can open. In Morrow for Muse, you sign in to Canvas in Morrow's own browser on your Muse computer, and that browser keeps your sign-in there. If Canvas ends the session, you sign in again.

**Student identities stay out of your assistant.** Before course information reaches your assistant, Morrow replaces student names, email addresses, usernames, and school or course account IDs with labels such as Student A1, and it stops if it cannot protect every student in those records. Names you type to your assistant reach it as you typed them. Each product lists what it cannot replace, such as a nickname the course roster does not hold: see the [Morrow Desktop limits](desktop/LIMITATIONS.md#learner-privacy) and the [Morrow for Muse privacy limits](morrow-for-muse/privacy/FERPA_POLICY.md#known-limitations-honest-scope).

**Start with the course access you already have.** Morrow gives educators direct tools for the courses they already manage. It never gives anyone new access.

## Repository layout

- `desktop/`: Morrow Desktop. The app, the Bridge extension, the MCP server, the installer, and product docs.
- `morrow-for-muse/`: Morrow for Muse. The connector, Morrow Direct, the dispatch engine, the privacy boundary, and the proof battery.
- `docs/`: family-level docs, the [product overview](docs/products.md) and [versioning](docs/versioning.md).
- `.github/workflows/`: CI with path filters. Changes under `desktop/**` run the desktop suite on Linux, and its installer suites and every desktop test Linux skips on Windows and on macOS. Changes under `morrow-for-muse/**` run the Muse suite. The required `check` job aggregates every suite.

To run the same suites before each commit, install the pre-commit hook once from the repository root: `git config core.hooksPath desktop/.githooks`. It runs the desktop gate when a commit changes `desktop/` or `.github/`, and the Muse suite when a commit changes `morrow-for-muse/`.

## Versioning

Each product versions and tags independently:

- `desktop/vX.Y.Z` for Morrow Desktop
- `muse/vX.Y.Z` for Morrow for Muse

See [`docs/versioning.md`](docs/versioning.md).

## License

MIT. See [`LICENSE`](LICENSE).
