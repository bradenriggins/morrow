# Moodle through installed Chromium

Use `bin/morrow moodle` for Moodle operations. Use the Chromium installed in
the Muse VM, normally `/opt/meta-chromium/chrome`. The managed Browser is not
the API execution path. Cookies and sesskeys stay inside Chromium. Never
export them, use a shell HTTP client with school authentication, or ask the
educator to put credentials in chat.

## Pair the account once

The educator signs in through the private native helper. Confirm that the
helper owns this tree's persistent browser profile.

First configure this tree's `helper/env` with `MORROW_LMS_PROVIDER=moodle`
and `MOODLE_BASE` set to the school's exact HTTPS Moodle site, including its
path when needed. Run `bash install.sh`. Present the private card using
[`helper/MUSE-SETUP.md`](../helper/MUSE-SETUP.md). Require its provider, site,
profile, version, and tree checks before the educator types. This is one
account setup step; it does not select or limit courses.

After the helper verifies the sign-in, run:

```
bin/morrow moodle pair --site https://school.edu/moodle
bin/morrow moodle status
```

Pairing discovers the educator ID from fresh provider configuration. Moodle
4.1 uses the parameter-free own-profile page. Pairing selects no course.
It persists one exact site and account; repeating it with that account is
safe. A different account is refused and cannot replace the pairing.
With multiple paired sites, pass `--site` to select the intended account.

If no attended helper session exists, resolve private Moodle sign-in setup
first. The CLI refuses to launch a substitute browser. Do not use the old
Python form-login module. Native Moodle onboarding must be verified on the
installed package and owner card; an already authenticated profile is not
first-use proof.

## Select courses through conversation

Ask the assistant to use a course name, course ID, or course link. Discover
courses with `bin/morrow moodle courses`. Follow `next_offset` with `--offset`
until `complete` is true. The page size is a transport bound; there is no
course-count limit. Resolve ambiguous names before a write. Do not ask the
educator to pair each course or manage a course list in the Bridge.

The catalog's `moodle_list_my_courses` operation is also an account read.
It needs only `limit` and `offset`; do not invent a course ID for it.
Both course discovery paths project each title through that course's private
roster. The account and session are checked again before any results return.
If `name_unavailable` is true, the title could not be checked safely. Morrow
shows `Course ID` instead. Keep the course ID and explain the access limit;
do not recover the raw title through a browser or shell bypass.

Read `bin/morrow moodle catalog` to get the pinned public operation schemas.
Use `read --operation KEY --arguments JSON` for reads. The read command
refuses writes. Results pass through the complete private roster and
encrypted learner vault before the assistant sees them. Use issued learner
labels; never invent a label or send a raw learner identity.

## Plan and Edit modes

`bin/morrow moodle mode status` shows the account's mode. Change it only when
the educator asks: `mode set plan` or `mode set edit`. Plan is the default.
Account modes use the full site and educator identity; another Canvas or
Moodle account does not inherit the mode. Conversation overrides use
`MORROW_CONVERSATION_ID` when supplied.

For Plan mode, read the target and use its current `snapshot_digest` as
`expected_digest`. Run `plan --operation KEY --arguments JSON`. Show the
returned course, change, complete values, and undo disclosure. Keep the
returned operation ID. After the educator approves in chat, run
`approve --op-id UUID --authorization "their exact reply"`. Never fabricate
approval or require a special phrase. No approval-channel bypass is exposed.

In Edit mode, run `execute --operation KEY --arguments JSON` with a fresh
digest. The existing admission, scope, halt, privacy, claim, and verification
gates still apply. A changed source refuses before approval is consumed.
Immutable learner tokens bind labels to the identities the plan saw.

Only `ok: true` with `verification.status: verified` proves a write. A lost
response or failed readback remains uncertain. Inspect the operation journal
and current provider state; never replay its operation ID or assume that a
new ID makes a duplicate safe. A changed account, site, login, or course
refuses operation preparation. Sign in again through the same private helper
and verify the pinned account before new work.

## Add reviewed files

Use a local file in the agent VM. Stage it with
`bin/morrow moodle stage-file --course-id ID --path /absolute/path/file`.
Use `--filename` to set its LMS file name. The result contains the reviewed
`filename`, `size_bytes`, and `sha256`. File bytes stay in encrypted private
state for this account, site, and course. Source paths do not enter the
plan or response. If a file name contains learner information, use the
projected name that Morrow returns.

Use the catalog to select the file operation and its review operation.
Read the native target first. Include the returned manifest and fresh
`expected_digest` in the write arguments. For a Folder file set, stage each
file and put the manifests in the requested order in `files`. Each set must
have unique file names. The current canonical adapters accept one file or
1–8 files with a total of at most 1 MiB. This is a file transfer bound.
There is no course-count limit.

Plan and Edit use the same reviewed bytes. Changes to the source file after
staging do not change those bytes. Stage the changed file and read and
prepare the target again when the educator asks to use a newer file.
Morrow refuses missing or altered private records before dispatch. It
verifies the native draft copy before save and reads the saved file bytes
before reporting success. A lost upload or save reply remains uncertain;
inspect provider state before proposing another operation.

## Capability boundaries

The canonical registry contains 249 public operations and one internal
privacy roster operation. Presence in the catalog is not proof that a
school enables that operation. Roles, plugins, site version, native forms,
and feature settings still control access. Report a provider refusal and
prepare a draft when needed. Do not bypass the governed path with UI writes.
Broader native file/provider qualification and first-use Moodle helper
setup remain release gates. Historical Python HTTPS proof
stays in the source repository; its authentication modules do not ship.
