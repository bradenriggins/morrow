# Setting up Morrow for Muse: the guided walkthrough

*V1 (2026-09-22). For the busy educator who has never heard of Muse. About 15 minutes, start to finish. You do everything by talking to Muse; there is no software to install and no settings page to find.*

## Before you start: what you need

- A Muse account and the Muse app open.
- Your normal Canvas login: the username and password you already use, and your phone nearby if your school uses Duo or push MFA.
- One honest heads-up before anything else: Meta uses eligible Muse interaction data for model training by default. There is an opt-out in Muse's settings; check there for the data-sharing opt-out. We name it here because you are about to trust this agent with your courses, and buried defaults are how trust dies.

## Step 1: Ask Muse to connect your Canvas account

In Muse, type:

> Connect my Canvas account.

That is the whole setup command. Everything below happens as a conversation; you never touch a terminal or a settings page.

## Step 2: Read the consent moment

Before anything connects, Muse shows you the consent page (`content/consent.md`): what Morrow can and cannot do, where your sign-in lives, how to revoke it, your school's policy, and the training-data default. Read it. It is one page and it is the whole deal. Nothing connects until you say so.

## Step 3: Tell Muse your school's Canvas address

Muse needs your school's Canvas URL. It looks like `canvas.school.example.edu`, where "school" is your own school (for example, your school's Canvas login page address). If Muse can determine it safely from what you have already told it, it will confirm it with you instead of asking. If the address does not load or does not look like a Canvas login page, Muse says so plainly and asks you to check it, rather than failing mysteriously later.

## Step 4: Sign in yourself on the login helper page

Muse opens your school's Canvas login page in the login helper: a private browser window that lives on your Muse's own computer, not on your laptop. You sign in exactly as you normally would, including Duo or push MFA on your phone. Your password goes only into the Canvas page; Muse never sees it, never asks for it, and never stores it. What Morrow keeps is the signed-in session (the same way your own browser stays logged in), and nothing else.

## Step 5: Muse verifies it is really you

The moment you finish signing in, Muse checks the connection by reading your own Canvas profile (your name, from your account) and confirms it matches. This is the setup-complete gate: a successful profile read means the connection works. If the check shows a login page instead, the sign-in did not stick; Muse asks you to try once more, then stops and tells you exactly what it found instead of looping forever.

## Step 6: Your first real task

Ask for something small and harmless first, so you can see how Morrow works before trusting it with anything bigger:

> Show me my courses.

That is a read: it changes nothing. Then try something slightly bigger, like listing the assignments in one course. In plan mode (the default), Morrow asks your permission before every change it makes in Canvas. When it finishes, you get a receipt: what was created, a link to it, and whether it can be undone.

## Step 7: Choose how much Morrow asks you

Morrow has two modes, and you switch between them by talking to the agent:

- **Plan mode** (the default): Morrow asks your permission before every change. Reads never need approval.
- **Edit mode**: you have told Morrow it may make changes without asking each time. That is the only difference between the two modes: reads never need approval in either one, and if Morrow is ever unsure which course you mean, it asks you to confirm instead of guessing, in either mode.

Say "make edit mode my default", "use edit mode for this conversation", or "switch to plan mode". There is no settings page; the conversation is the settings page.

## Weeks later: what session expiry looks like

Your connection needs regular activity to stay alive, and a few ordinary things end it: signing out of Canvas inside the helper browser, your admin ending sessions, or your school's single sign-on logging you out in the background. Logging out on your laptop or phone does not end the helper's own session, because Canvas sessions are per-device. None of these are errors; they are re-authentication events.

When it happens, Morrow notices the expired connection, stops any new changes immediately, tells you in plain language that your Canvas sign-in expired and that nothing was lost, and walks you through signing in once more on the helper page. After sign-in it checks that it is still you before resuming anything, and paused work resumes only with your fresh approval.

## If something goes wrong during setup

Setup failures are specific, never cryptic. If Morrow cannot reach your school's address, it tells you the address did not load and asks you to check it. If the helper page is not running, it tells you so and restarts it. If your sign-in did not stick, it tells you and asks you to try once more. You will never see a bare error code or a message that says the cause is unknown for one of these ordinary setup states; if you do, that is a bug, and we want to hear about it.
