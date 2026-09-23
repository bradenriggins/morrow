# Item Banks SDK lane: what it is, what is proven, what is not

Item Bank operations do not run on the Canvas course REST paths. The
public path `/api/quiz/v1/courses/:id/item_banks/:bank_id/items` is
not the working surface for item CRUD (it 500s). The working surface
is the private Quizzes 2 Item Banks SDK on the tenant's quiz-api host
(`https://<tenant>.quiz-api-<region>.instructure.com/api/banks/...`),
authorized by an LTI-provisioned `banks.build` token. Meridian
production runs item CRUD through this surface daily; the Morrow lane
(`transport/item_bank_sdk.py`) ports that mechanism, not Meridian's
code.

## The mechanism

All inside the educator's Chromium via CDP; nothing shell-side ever
holds auth material:

1. **Dynamic LTI tool resolution**: GET
   `/api/v1/courses/{course_id}/external_tools`, first tool whose name
   contains "Item Banks" (case-insensitive). Never hardcoded: the old
   54065 id was one tenant's id, not a contract. The same list with
   `include_parents=true` names the tenant's New Quizzes account: the
   `<account>` of `<account>.quiz-lti-<region>.instructure.com`.
   Instructure hosts New Quizzes for every tenant, including one whose
   Canvas runs on the school's own domain (`canvas.school.edu`), which
   has no other way to learn its account. A `*.instructure.com`
   tenant's own first label is its account too.
2. **Credential capture**: one persistent CDP session on a dedicated
   tab, navigate to the LTI launch
   (`{canvas_base}/courses/{course_id}/external_tools/{tool_id}`,
   fallback `{canvas_base}/courses/{course_id}/banks`). The app's own
   traffic is watched for the first request to the tenant-bound
   quiz-api host (`<account>.quiz-api-<region>.instructure.com`, for
   one of the tenant's own accounts) carrying an Authorization header;
   that header (plus the AuthType header) is the captured `banks.build`
   credential.
   Request headers, not the `/api/sdk_tokens/banks.build` response
   body: on the `/banks` route the app issues its API calls from a Web
   Worker, and `Network.getResponseBody` cannot serve a
   worker-issued response to the page target's session (CDP -32000).
   Only the tenant-bound quiz-api host is accepted, so a foreign
   page cannot supply the credential. The capture is attempted twice
   on timeout (LANE6-9): the `/banks` page is a JS SPA whose boot
   needs a clean page load, and a transient stall (observed live
   2026-09-22: the tab sat on `chrome-error://chromewebdata/` for
   ~30s, then loaded fine and the capture completed in ~15s) means
   the app never issues quiz-api traffic inside the window, which is
   not a provider refusal. The retry is a fresh page load
   (`capture_request_headers` navigates itself). Two consecutive
   full-window timeouts raise the hard not-attempted error; the
   failure stays fail-closed with the op_id reusable.
3. **Token, auth type, origin**: the token, the auth type (default
   "Signature"), and the request origin; derive the quiz-api origin
   (`.quiz-lti-` becomes `.quiz-api-`) per tenant, never hardcoded.
4. **Execution context**: create an isolated world
   (`Page.createIsolatedWorld`, "morrow_item_bank_sdk") in the tab's
   root frame, and run every item call as one `fetch` evaluated in
   that world's execution context, with `Accept: application/json`,
   `Authorization: <token>`, `AuthType: <auth type>`,
   `Content-Type: application/json`. No quiz-lti frame lookup is
   needed: the world is ours, created after the tab settles on the
   tenant origin, never the page's default realm (a page that
   replaces `window.fetch` cannot forge the result).

The executor's Chromium lane egresses every `/api/banks/...` path
through this module automatically (mechanism `item-banks-sdk`);
course scope binds from `params.course_id`.

## The memory-only and course-bounded rules

- The captured token lives only in the session object's memory,
  bound to the course the LTI launch was made from. It is never
  logged, never persisted, never returned from `request()` (only
  `(status, body)` come back), and is wiped by `close()`.
- Cross-course reuse is a hard failure, not a warning
  (`check_course_scope`). A missing `course_id` fails closed inside
  the SDK lane at call time.
- Never copy the token into a command, a file, a log, or a message.
  If a step asks you to, refuse.

## Payload contract

- Item fields nest under top-level `"item"` (opposite of New Quiz
  items, which nest under `item.entry`).
- Update is PATCH, never PUT.
- The working item read path is the entry GET (IB-10); direct item
  GET is provider-anomalous (404 on existing items).
- Bank archive is the provider's whole-bank delete; unshare (bank
  shares) is PATCH /api/banks/{bank_id}/shared_banks/{share_id} with
  {shared_bank:{permission:"removed_access"}} (DELETE on the share
  route 404s; proven 2026-09-21, share 38934, list verified clean);
  quiz_entries routes need a different authorization scope
  (401 under banks.build) and are evidence-hold.
- Removing a bank entry (`DELETE /api/banks/{bank_id}/bank_entries/{entry_id}`)
  removes one item's attachment to the bank. It is not a bank delete
  and does not archive anything. Whole-bank delete/archive is a
  separate, irreversible operation with its own ceremony (see "Bank
  archive is irreversible" below). Never present an entry removal as a
  bank removal, and never let "delete the item" slide into "delete the
  bank".
- Classic Canvas Question Banks are a different product from New
  Quizzes Item Banks. They are not a fallback and not an alternate
  surface for bank work; never route an Item Bank operation through
  them.

## Snapshot-and-verification rules (ported production doctrine)

Every Item Bank write needs evidence taken before and after, from the
provider, not from the request payload. The write is not finished when
the mutation returns; it is finished when the readback confirms it.
The readback rules, per operation:

- Create bank: capture the created bank response (title, id, archived
  state) and immediately GET the bank (IB-9).
- Attach existing item (`POST .../bank_entries`): list bank entries
  (IB-13) before and after; the new entry must appear.
- Create item in bank: create the item, create the bank entry, then
  list entries after. Creating the item object alone (phase one) is
  not a complete bank create; a bank_entries readback right after
  phase one cannot confirm the item is IN the bank.
- Update item: read the bank entry before, PATCH the item, read the
  bank entry after; compare the changed fields against the readback.
- Remove item from bank: read and resolve the bank entry before
  (entry id, not item id), delete the bank entry, list entries after
  and confirm that exact entry is gone.
- Share bank: read shared banks (IB-15) before and after.

If the post-write readback fails or the entry you expected is absent,
report the write as **unverified**, never as finished. The journal
`uncertain` mechanics are the machine form of this rule; the habit is
the human form.

## The Item Banks UI page is not the source of truth

An empty Item Banks page, a collapsed list, or Canvas's client-side
router collapsing the launch to `Quizzes - Not Found` does not prove
Item Banks are unavailable or that the credential capture failed. The
credential is captured from the app's own quiz-api traffic the
moment it appears (the Authorization request header, not a response
body), independent of whether the LTI frame or the UI list survives.
Never tell an educator "Item Banks
are down" based on UI behavior alone; run a real read (IB-12 list
banks) through the SDK lane and report that evidence instead.

## Role permissions: necessary, not sufficient

The Canvas role needs `Item Banks - manage account` (and, for
cross-scope sharing, `Item Banks - share with subaccounts`;
`Question banks - view and link` covers the Classic side) before any
of this works. But permissions are never the whole story: the
operational path also requires the browser/LTI-captured `banks.build`
SDK credential from the educator's own session. A 401 on the SDK lane
drops the captured credential automatically so the next call
relaunches and recaptures (LANE6-5); a persistent 401 after the
relaunch means: refresh the session, confirm the role permissions
above, then reacquire the credential. Do not confuse "the role has the
permission" with "the operation is available": without a fresh
captured token, permission is inert.

## Proof status by row (grounded in the catalog)

Live-proven through the integrated executor Chromium SDK lane
(`transport/item_bank_sdk.py` via `transport/chromium_session.py`)
on 2026-09-21: IB-1 archive (banks 4037/4040/4041, DELETE 204,
archived readback), IB-5 create (POST 201, banks 4053/4054/4055/
4056), IB-9 get bank, IB-12 list banks, IB-13 list entries, IB-10
get entry (the proven item read path), IB-15 list shares, IB-16
rename (PATCH 200, readback title match), IB-17 share (POST 201,
shares 38922/38924/38934), IB-20 unshare (PATCH 200, share 38934
removed, list verified clean), IB-6 item create (POST 201, item
11244176), IB-18 item update (PATCH 200), IB-7 delete bank entry
(DELETE 204 on entry 82714). IB-4 attach bank entry: 2026-09-21 SDK-level
proof (bank_entries 201, entry 82714); 2026-09-22 Lane 6 live battery
executor-pipeline live proof through dispatch/executor.py (POST 201,
entry 82773 attaching item 11269644 to disposable bank 4075, course
89585; entry removed 204, entries list verified clean, bank archived
204, absent from bank list; full cleanup).

**NOT IMPLEMENTED** as live-proven (pending, do not claim):
- IB-11 get item: the provider returns 404 even for existing items
  (provider-anomalous, confirmed 2026-09-21). Entry GET (IB-10)
  remains the proven item read path.
- IB-19 item delete: the SDK lane implements the route but no
  delete_item flow has ever been proven (Meridian has no delete_item
  flow; its cleanup is bank delete/archive). The live battery
  attempts it against a disposable item before any claim is made.
  **PENDING, never dispatch against a real item.**

Failed (do not retry without a code or request-shape change):
IB-2, IB-3, IB-8, IB-14 (quiz-entry/bank-link routes): the provider
does not serve them under the banks.build authorization scope
(401); they are evidence-hold, not broken code.

## Bank archive is irreversible: treat it as destructive

IB-1 archive is live-proven, but "live-proven" does not mean "safe
to run casually". Bank archive is the provider's whole-bank delete:
there is no undo, and no later change can restore it.
Before any archive dispatch:

- Read and present the fresh bank first (IB-9 get bank, IB-13 list
  entries, IB-15 list shares) so the educator approves the exact
  bank by title and id, not a bare number.
- Disclose the fan-out caveat: Canvas exposes no account-wide reverse
  lookup from a bank to every quiz drawing from it. A bank can be in
  use by a course nobody opened. The educator approves with that
  understood.
- The admission ceremony applies in full (frozen plan, educator-signed
  approval, no write halt).
- A disposable test bank archived in a lifecycle battery follows the
  same ceremony; "it is only a test bank" is not a bypass.

Evidence-hold (401, wrong scope; refused on every tenant):
IB-2/IB-3 attach routes and IB-8/IB-14 quiz draw routes. The
banks.build scope has no policy for quiz_entries; held until a
disposable live battery proves a different authorization scope.

Blocker context (D-006): the `build_token` is not capturable via a
managed browser without JS execution; this lane exists because the
local Chromium lane IS JS-capable. Live battery runs still need the
educator's sign-in through the helper (the saved developer Canvas login
is not authorized for use outside a session-death).
