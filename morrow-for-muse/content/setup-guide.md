# Setting up Morrow for Muse with Canvas

*Version 0.4.4. Canvas setup takes about 15 minutes. You set it up by talking
to Muse; there is no software to install on your own computer.*

## Before you start

- A Muse account and the Muse app open.
- Your school's Canvas sign-in page and your usual sign-in method.
  Keep your phone nearby if your school uses Duo or push MFA.
- Meta uses eligible Muse conversations for model training by default. Muse
  has a data-sharing opt-out in its settings.
- On some Muse computers, the network that carries traffic out of the VM
  can read that traffic, including the Canvas sign-in session and the course
  pages. Morrow cannot prevent that. If your school has rules about where
  course content may go, check them before you connect.

## Step 1: Ask Muse to set up Morrow

In Muse, type:

> Set up Morrow for Muse with Canvas by following https://meetmorrow.app/morrow-for-muse

If Morrow is already set up, say “Connect my Canvas account.”

## Step 2: Review how Morrow works

Before the first connection, Muse explains what Morrow can do, where your
sign-in stays, and how to disconnect. Continue when you are ready.

## Step 3: Name your Canvas site

Give Muse your Canvas site address. Morrow checks the address before it
connects.

## Step 4: Sign in through your school

The Canvas helper opens your school's sign-in page in the browser on the Muse
computer.
Sign in as you normally do, including SSO and MFA. Enter your password only
on your school's sign-in page. Do not send it to Muse chat.

## Step 5: Confirm the connection

Morrow checks your Canvas account and confirms the connection. If the sign-in
did not finish or the site needs another step, it explains what to do and
stops. It does not keep retrying with an uncertain session.

## Step 6: Start with a read

Try:

> Show me my courses.

This reads your Canvas course list and changes nothing. Ask a follow-up about a
course to explore its content. In Plan mode, Morrow asks before each change.
After an approved change, it reads the result back from Canvas. Morrow does
not undo a change automatically; a reversal is a new change that needs your
approval in Plan mode.

## Step 7: Choose how Morrow handles changes

- **Plan mode:** Morrow asks before each change. Reads do not need approval.
- **Edit mode:** Morrow can make changes without asking each time. You can
  switch modes by asking Muse.

Morrow still checks which Canvas course you mean and verifies each change after
it saves.

## Canvas sign-in: what session expiry looks like

If your Canvas sign-in expires, Morrow stops work and asks you to sign in
again. A change may already be in Canvas. Morrow checks the course first before
it prepares the change again, and waits for your approval when Plan mode
requires it.

## Moodle

Moodle uses a separate part of Morrow. This package does not move a signed-in
Muse browser session into that part. The included test sign-in is for Moodle's
public demo site, not your school. Do not send school passwords or sign-in
details to Muse chat.

If your Muse VM already has a Moodle connection, use its existing sign-in.
Confirm how it asks before a change and how it checks the saved result on your
Moodle site. These Canvas steps do not set up Moodle.

## Get help

Email hello@meetmorrow.app or see meetmorrow.app/support. Include the Morrow
for Muse version and the step where setup stopped. Do not send student
information, passwords, sign-in details, or screenshots that show students.
