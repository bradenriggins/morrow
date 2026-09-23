# Before we connect: what you are agreeing to

*A plain summary for a busy educator. This is the whole deal; there is
no fine print behind it. Muse shows it to you before you sign in.*

## What Morrow can do

Morrow does Canvas tasks when you ask it to. It can do more than 200
Canvas tasks that we have tested on a real Canvas site, for example:
listing your courses and assignments; creating assignments, classic
quizzes, pages, and modules; editing pages; and reading course files.
It refuses anything we have not tested, instead of guessing. Morrow
acts with exactly the permissions your own Canvas account has. Nothing
more.

What it will not do in this version, even if you ask:

- post announcements, send messages to people, or open support
  tickets;
- change anything above your courses (such as settings for your whole
  school), or anything we have not tested;
- act as anyone other than you.

After every change, Morrow reads it back from Canvas and tells you
one of three things: the change is saved as asked, Morrow could not
confirm it, or it did not work. This version cannot undo a change
automatically. To reverse a change, Morrow makes the opposite change
as a new change, and in plan mode it asks you first.

## What Morrow cannot do

Morrow cannot act without your instruction, and it cannot give itself
more permissions. If you ask for something it cannot confirm is within
your permissions and among the tasks we have tested, it refuses rather
than guessing.

Whether it asks before changing things depends on your mode, and only
the mode decides. In plan mode (the default), Morrow asks your
permission before every change in Canvas. The request can look
different on your screen from time to time; asking first is the
promise. In edit mode, you have told Morrow it may make changes
without asking each time. That is the only difference between the two
modes: reads never need approval in either one, and everything else
(your students' privacy, refusing untested tasks, and never guessing
which course you mean) works the same in both. You choose the mode by
talking to Muse ("use edit mode", "use edit mode for this
conversation", "turn off edit mode"). Edit mode has no time limit: it
stays on until you turn it off, and turning it off puts you back in
plan mode everywhere. If Morrow is ever unsure which course you mean,
it asks you to confirm the course instead of guessing, in either mode.

## Your students' privacy

Student details are hidden from the assistant. When Morrow reads
rosters, submissions, or grades, the assistant sees labels like
"Student A1" instead of names, emails, logins, or Canvas ID numbers
(including the ones inside links). Morrow's own records on your Muse
computer use the same labels, never the names. A student keeps the
same label every time on this computer.

You can still work with a student by name. When you name a student
("extend Jane Doe's due date by two days"), Morrow looks that name up
in your course roster and, for the rest of that conversation, shows
that student as "Jane Doe (Student A3)". If more than one student
could match, it asks you which one you mean. It never guesses.

One thing Morrow cannot do: it cannot hide what you type to Muse. The
names you type reach the Muse assistant, because you typed them.
Morrow keeps every other student detail in Canvas (the names you did
not type, emails, logins, and ID numbers) away from the assistant,
with two limits you should know:

- Looking up a name tells the assistant something. When the assistant
  looks a name up and gets a label back, that confirms that a student
  with that name is enrolled in the course. The assistant could look
  up a name you did not type. Nothing technical stops that, but every
  lookup is recorded on your Muse computer (which course, which
  conversation, and whether it matched; never the name itself), so a
  guess leaves a trail.
- Course content is not hidden. If a page body, announcement,
  discussion post, or file names a student, the assistant reads that
  name as written.

The assistant never sees the names of students you did not name, and
this cannot be turned off. To check who a label is, tell the assistant
the name of the student you have in mind: it looks that name up and
tells you whether it is the same label.

## Where your sign-in lives

> **The warning that matters most:** your Canvas sign-in is kept in
> the helper's private browser on your Muse computer. **Anyone who can
> get into that computer's files could act as you in Canvas.** Guard
> this computer's login the way you would guard your Canvas password.

Morrow stores no Canvas password and no access token anywhere. Your
sign-in is kept by the helper's private browser on your Muse computer,
the same way your own browser stays signed in. You typed your password
into the Canvas sign-in page during setup; Morrow never saw it and
never saved it. Your sign-in stays on your Muse computer only, never
in a download or update.

## How to revoke

- Sign out on the helper page: open the helper page (Muse can show it
  to you) and use Canvas's own menu: Account, then Logout. That ends
  the sign-in Morrow uses.
- For a full disconnect, say "disconnect Morrow from Canvas". Muse
  asks you to confirm, then stops the helper, removes its restart
  schedule (otherwise it would restart the signed-in helper within
  five minutes), deletes the helper's private browser (which holds your
  sign-in), and checks each step before it tells you it is done.

Signing out of Canvas on your laptop or phone does not end the
helper's own sign-in, because each device has its own Canvas sign-in.
There is no access token to delete: this version creates none, so
there is no "Morrow for Muse" entry under Approved Integrations in
your Canvas account.

Once disconnected, Morrow cannot reach Canvas at all. Reconnecting
means going through the short setup again. (The "Disconnecting Morrow"
page has every step.)

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
