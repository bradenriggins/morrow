# Before we connect: what you are agreeing to

*Plain-language summary for a busy, non-technical educator. This
is the whole deal; there is no fine print hiding behind it. Shown
before any sign-in happens.*

## What Morrow can do

Morrow can do a defined set of Canvas tasks when you ask it to. The
dispatch catalog lists 457 Canvas operations (437 course-level, 20
Item Bank). Of those, 210 are live-proven through the Chromium lane,
and 10 of the 11 New Quiz creation sequence steps are live-proven as
well (step 7, whole-quiz archive, is unsupported by the provider);
those 220 are what this build will dispatch, and anything not
live-proven it refuses rather than guessing (checked 2026-09-22
against proof-battery/OPERATION_CATALOG.md). Live-proven examples
include listing your courses, assignments, and enrollments; creating
draft quizzes and assignments; managing modules and pages; and
reading course files. Morrow acts with exactly the permissions
your own account has. Nothing more.

What it will not do in v1, even if you ask:

- post announcements, send messages to people, or open support
  tickets (these are standing exclusions);
- change anything at the subaccount level or outside the
  live-proven catalog rows;
- act as anyone other than you.

For every change, Morrow shows you a receipt: what was created, a
link to it, and whether it can be undone.

## What Morrow cannot do

Morrow cannot act without your instruction, and it cannot grant
itself new permissions. If you ask for something it cannot verify is
within your permissions and within the proven catalog, it refuses
rather than guessing.

And whether it asks before changing things depends on your mode,
and the mode is the only thing that decides. In plan mode (the
default), Morrow asks your permission before every change in Canvas.
The exact layout of the approval prompt on your screen can vary;
asking first is the product commitment in plan mode, regardless of
how it looks. In edit mode, you have told Morrow it may make changes
without asking each time. That is the entire difference between the
two modes: reads never need approval in either one, and every other
protection, student-data privacy, refusing unproven operations, and
never guessing which course you mean, works exactly the same in
both. You choose the mode by talking to the agent ("use edit mode",
"use edit mode for this conversation", "turn off edit mode"). Edit
mode has no time limit: it stays on until you turn it off, and
turning it off puts you back in plan mode everywhere. If Morrow is ever unsure which course you mean, it asks you
to confirm the course instead of guessing, in either mode.

## Your students' privacy

Student data is de-identified by default. When Morrow reads rosters,
submissions, or grades, the agent sees stable labels like "Student
A1" instead of names, emails, logins, or Canvas ID numbers (including
the ones inside links), and the journal records the same labels,
never the names. The labels stay consistent across sessions on this
computer.

You can still work with a student by name. When you name a student
("extend Jane Doe's due date by two days"), the agent looks that name
up in your course roster and, for the rest of that conversation,
shows that student as "Jane Doe (Student A3)". If more than one
student could match, the agent asks you which one you mean. It never
guesses.

One thing Morrow cannot do: it cannot intercept what you type to
Muse. The names you type reach the Muse model, because you typed
them. Morrow keeps every other student identifier from Canvas (the
names you did not type, emails, logins, and ID numbers) away from the
model.

To see real names from a Canvas read for one course, ask the agent in
your own words. It records your request, sealed, for that one course
only, for at most 30 minutes, and your words are kept in the journal.
There is no other way to lift de-identification.

## Where your sign-in lives

> **The warning that matters most:** your sign-in is the session
> cookie in the helper Chromium profile (`<tree>/helper/profile/`)
> on your Muse's own computer. **Anyone with access to that profile
> directory on this computer could act as your Canvas session.**
> Guard this computer's login the way you would guard your Canvas
> password.

Morrow stores no Canvas credential, no password, and no API token
anywhere. Your sign-in is the session cookie in the helper Chromium
profile (`<tree>/helper/profile/`) on your Muse's own computer. You
typed your password into the Canvas sign-in page during setup; Morrow
never saw it and never saved it. That directory lives only
on your Muse's own computer, never in a download or update.

## How to revoke

- Sign out of Canvas inside the helper browser. That ends the
  session Morrow uses.
- For a full disconnect, say "disconnect Morrow from Canvas". Muse
  asks you to confirm, then runs `bin/morrow disconnect --yes`, which
  stops the helper, removes its restart schedule (otherwise it would
  restart the signed-in helper within five minutes), deletes the
  helper profile (`<tree>/helper/profile/`, which holds the session
  cookies), and checks each step before it reports done.

Logging out of Canvas on your laptop or phone does not reliably end
the helper's own session, because Canvas sessions are per-device.
There is no token to delete: v1 creates no API token, so there is
no "Morrow for Muse" entry in your Canvas account's Approved
Integrations.

Once disconnected, Morrow cannot reach Canvas at all. Reconnecting
means going through the short setup again. (Full steps: `revoke.md`.)

## Your school's rules

Your school's acceptable-use policy applies to Morrow exactly as it
applies to you. If your school has rules about automated tools, or
about who may touch student records, they cover this connector too.
When in doubt, ask your IT help desk before connecting.

## The part we would rather you hear from us

Meta uses eligible Muse interaction data to train its models by
default. That means your conversations with Muse, including anything
you type about your courses, may be used for training unless you opt
out. We have not yet verified the exact location of the opt-out
switch in Muse's settings ourselves; check Muse's settings for the
data-sharing opt-out. We are naming the default now because
discovering it later would make everything above read as dishonest,
and we will update this page the moment our own walkthrough
is done.
