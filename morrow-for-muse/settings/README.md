# Morrow for Muse: modes and settings

You shape exactly how your agent operates. Everything below can be
changed by talking to the agent in plain language. Nothing here is
hidden in a config file you have to hunt down.

## The mode model, in one sentence

The ONLY difference between plan mode and edit mode is whether writes
surface approval to you. In plan mode, writes require your approval. In
edit mode, they do not. Reads are unrestricted, with no approval, in
both modes. That is the whole model.

## Plan mode (the default)

In plan mode the agent reads freely and shows you a plan before
anything is written. Every write goes through an approval ceremony: you
see exactly what will change, and nothing runs until you say so. This
is the starting default, and it is the right choice when you want full
oversight.

## Edit mode

In edit mode writes do not surface approval. The agent does the work
and reports what it did. Making edit mode your default is a standing
edit grant: it is recorded in your settings journal, and the agent
tells you plainly what it means before it applies. Say "make edit mode
my default" and confirm when it echoes back.

There are two lighter-weight ways to get edit behavior without changing
your default:

- **Standing edit grant.** Say "use edit mode" and the agent sets your
  default to edit (no time limit), during which writes do not surface
  approval. Say "use plan mode" to go back. You can still request timed
  sessions explicitly if you want them:
  "set my edit sessions to 60 minutes" (allowed: 5 to 480).
- **This conversation only.** Say "use edit mode for this conversation"
  or "use plan mode for this conversation". The override lasts for that
  conversation and is never saved. Your default is untouched.

When more than one of these is in play, the last thing you said wins.
"What mode am I in" always tells you the effective mode right now and
where it comes from.

## The safety rules that stay on

Two guardrails are always in force, and the agent enforces them no
matter the mode:

1. **Student privacy.** Student data is de-identified before the agent
   can see it. This is not a setting and cannot be turned off.
2. **Safe operations in Canvas.** Destructive writes (deletes and the
   like) still ask for confirmation even in edit mode. This one IS
   yours to control: say "stop asking me to confirm deletions" to turn
   it off, or "always confirm deletions" to turn it back on. Turning it
   off requires your explicit confirmation, and it is journaled.

And three rules about the agent itself:

- The agent can never grant itself edit mode, start an edit session,
  or change a consequential setting on its own. Anything that changes
  whether writes surface approval needs your explicit "yes" after the
  agent echoes the exact change back to you. An agent-side attempt
  without your confirmation is refused outright.
- Every settings change is journaled with the old value, the new
  value, and your identity, including edit sessions and conversation
  overrides.
- Nothing here is restricted by which Canvas tenant you are on.
  Settings are yours, per educator, everywhere.

## Everything you can change by talking

| Setting | What it does | Default |
|---|---|---|
| default_mode | Your saved mode: plan or edit. Edit is the standing edit grant. | plan |
| edit_grant_duration_min | Length of timed edit sessions (explicit duration requests), in minutes (5 to 480). | 30 |
| verbosity | How much the agent says: concise, balanced, or detailed. | balanced |
| confirm_destructive_writes | Ask before deletes and destructive writes, even in edit mode. | off |
| write_approval_style | One approval per write, or one ceremony covering a listed set of writes in a single validated plan. | per_write |
| failure_verbosity | Failure reports: concise (what failed, next step) or detailed (what was tried, evidence, recovery options). | detailed |
| proactivity | reactive (only does what you ask) or suggestive (may suggest follow-ups unprompted). | reactive |
| read_confirmations | Narrate reads before doing them. Reads never need approval either way. | off |
| work_summary | How the agent reports completed work: brief (one short line per task) or full (every change listed). In edit mode this summary is your oversight. | full |
| auto_cleanup_test_objects | Temporary objects the agent creates to verify something works (proof pages, test items) are deleted when the check is done instead of left behind. | on |
| default_course_id | Your go-to course id. When you do not name a course, the agent starts here without an extra "is this the right course?" check, as long as it is unambiguous. If the target is genuinely ambiguous or conflicts with what you named, it asks. Plan/Edit mode still governs write approval as usual. Empty means no default: the agent asks. | empty |
| timezone | Your timezone for date math ("last week's quiz", due-date windows). An IANA name like America/Denver; empty means unset, and the agent asks or falls back to the course default. | empty |
| confirm_bulk_actions | Actions that touch many students or items at once (mass messages, bulk edits) ask for confirmation first, even in edit mode. | on |

Try: "be more concise", "use batched approvals", "suggest follow-ups",
"keep failure reports short", "show me my settings".

## Where it lives

Your settings live at `~/.morrow/settings/<your-id>.json`, with the
change journal alongside it. They survive restarts, reinstalls, and
upgrades, and they are never inside the connector's own files. Timed
edit sessions are real persisted edit grants (tamper-sealed, like
approval records), so they survive a restart too; per-conversation
overrides are the exception, held in memory on purpose, so a restart
always fails safe back toward plan mode.
