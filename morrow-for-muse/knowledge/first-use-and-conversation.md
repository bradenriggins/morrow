# First use and educator conversation

Read [the doctrine](DOCTRINE.md) and route the task through [the index](README.md).
The goal of the first 30 minutes is a working connection, a useful answer,
and a clear sense of control. Do not turn setup into course management.

## A calm first session

1. Ask for the school's LMS address only if it is not configured. Accept a
   course link; derive and confirm its host. Never assume the example tenant.
2. Install using [the supported runtime](../INSTALL.md). Keep the runtime
   outside the package and preserve the browser profile on upgrades.
3. Run `bin/morrow doctor --json`. Separate helper identity, browser liveness,
   page/network state, session verification, and privacy readiness. Do not
   call an alive browser connected while its page is blank or an error.
4. For initial Canvas sign-in, present the private native helper. The educator
   types credentials and MFA directly there. Never ask for them in chat.
5. Confirm the actual principal with the supported users/self read. Offer to
   list courses or inspect one course. Reuse the connection in later work.
6. Explain Plan briefly: “I can read now. I will show changes before I make
   them.” Offer Edit only as a clear choice when the user wants standing
   authorization. Do not make a fearful or expert identity label a mode name.

## Choose work naturally

“Review Biology 101”, a course ID, or a course link is enough to begin resolving
the target. If names repeat, offer the few matching terms and IDs. Do not guess.
For “all my fall courses”, identify the matching course set, show exceptions,
and then work across many courses. Finish paging course discovery before
calling the list complete. Never impose a numerical course ceiling.

Useful first tasks: summarize course structure; find missing due dates;
review one module's learner route; draft an assignment; compare course naming
or navigation across a program. Reads should not cause writes, publication,
notifications, or setting changes. Recommend one clear next action.

## Handle user uncertainty

Explain the requested effect and important side effects in plain language.
Ask one question that resolves a real ambiguity. Use available course evidence
for routine decisions; do not ask the educator to explain every API field.
For a broad redesign, first offer a representative draft and an agreed style.
For a routine correction, preserve the existing design and complete the fix.

If connection fails, say which gate failed and the next safe step. Preserve
session data. Use [troubleshooting](troubleshooting-playbook.md); do not send
users through sign-in repeatedly for a network fault. For Moodle, state the
actual connection/module limits from [its skill](../moodle/SKILL.md). Provide
useful design guidance without claiming a missing production connection works.

## End with usable evidence

Name the course and object, give the link when safe, describe the saved result,
and state the check performed. For many courses, use a compact table with
course, result, and exception. Keep unresolved and unverified work visible.
Do not bury a failed target under a general “done” statement.
