# Morrow

[![CI](https://github.com/bradenriggins/morrow/actions/workflows/ci.yml/badge.svg)](https://github.com/bradenriggins/morrow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/bradenriggins/morrow)](LICENSE)
[![Website](https://img.shields.io/badge/website-meetmorrow.app-1f6feb)](https://meetmorrow.app)

Morrow connects the AI assistant you already use to your Canvas and Moodle courses, and to a configured Blackboard course.

**Current state:** Morrow works with Canvas and Moodle through the signed-in Chrome connection and with Blackboard through the official Anthology Learn REST API; Canvas has selected live test-course proof, part of the Moodle catalog has been checked on a signed-in Moodle test course, and no live Blackboard tenant has been tested. Morrow works with the Canvas and Moodle courses your own signed-in account can open, and it acts only with that account's permissions. The test courses named in this file are Morrow's own verification evidence. They are not a rule about which of your courses you can connect. Of the 250 Moodle operations, 31 have been checked on a signed-in Moodle test course and the other 219 pass local browser fixtures only; the [Moodle capability surface](#moodle-capability-surface) lists both sets. A reviewed Moodle Resource upload takes one workspace file of at most 1 MiB. Moodle file support also replaces the file of a Resource, deletes one extra Resource file, adds up to 8 reviewed files of at most 1 MiB together to one Folder path, creates one empty subfolder, and replaces one hidden H5P package, each with browser-fixture proof only; it has no editor-attachment route. The assistant file planners stage Resource replacement, multiple Folder files, hidden SCORM replacement, and hidden H5P replacement for review. Blackboard needs an Anthology Learn REST application that a Blackboard administrator installs on your Learn site, and local credentials; Morrow then reads a connected Blackboard course and exposes 15 reviewed action planners for its supported REST changes. A planner sends no course write. Blackboard test and question authoring is not available through the public Learn REST API, and every Blackboard statement in this file is proved against local mocked-HTTPS fixtures only. See [current limits](LIMITATIONS.md).

Morrow helps instructors, instructional designers, and course reviewers turn lesson and quiz requests into reviewed changes and checked results. Ask an assistant set up with Morrow for a change, review the exact change in Morrow, and see what the course platform saved. You keep the teaching decisions.

Morrow runs on your computer and connects to an assistant through MCP. The desktop app sets up ChatGPT, Claude Desktop, Claude Code, or Gemini CLI, and the source route sets up the same four. A selected Codex update has passed a live test-course check; each other assistant still needs its own complete live checks. See the [test record](docs/implementation/BT2-LIVE-PROOF.md).

## What a user installs

A user installs two Morrow parts:

1. **The Morrow desktop app** runs on your computer. It carries the Morrow MCP runtime and the Node runtime that runs it, sets up the assistant you choose, and guides the rest of setup. Assistants set up from one installation share one course connection.
2. **Morrow Bridge** is one Manifest V3 Chrome extension. It uses the Canvas or Moodle session already signed in within Chrome.

The app is built for macOS on Apple silicon and for Windows on x64. It needs no separate Node.js, pnpm, or source checkout, and normal setup asks for no command and no typed path. Morrow Bridge has no Chrome Web Store listing yet, so the app guides one temporary Chrome step: it opens the exact folder Chrome must load, and you turn on Developer mode and select **Load unpacked**. [The Morrow desktop app](#the-morrow-desktop-app) states what is built and what is still unproven.

Canvas and Moodle need no platform access token, developer key, OAuth app, hosted Morrow account, or separate approval application. Blackboard is the exception. A Blackboard administrator installs Morrow's REST application on your Learn site and chooses the Learn account it acts as. It then needs an Anthology Learn REST integration key and secret that you supply locally, and Morrow keeps that secret in a private local file, separate from the assistant configuration.

## How a user works with Morrow

1. **Download and open Morrow.** Choose the download for your computer, install it, and open the app.
2. **Follow the setup in the app.** Choose your assistant. Morrow then shows one next action at a time while you add Morrow Bridge to Chrome and connect it to Morrow. The materials folder is optional; Morrow creates a default one unless you choose another.
3. **Open and connect your course.** Open a signed-in Canvas or Moodle course in Chrome. Morrow Bridge identifies the platform and shows **Connect Canvas** or **Connect Moodle**. Select that button, allow the exact platform address Chrome shows, choose courses, select **Connect selected courses in Plan**, and complete the first read. Then return to your assistant and ask it to use Morrow. Plan keeps changes in review. In settings, you can grant Edit access to specific change types in specific courses.

The extension shows two separate states: whether Morrow is connected to your assistant, and whether you have saved a course connection. It shows when the platform was
last checked. A saved connection is not a promise that you are still signed in.
Morrow checks the platform again before each request.

You continue working in your assistant. Morrow does not add another chat interface.
For example, ask it to list the modules in a connected course or show which
assignments have no due date. Be specific about the course and what you want
to change.

Reading a connected course does not need a change approval. For a change, Morrow gives your
assistant a review link. Open it to see the courses, items, and requested values.
For a new quiz question, choose **Add this question** or **Cancel**. A group of
changes lists each request and uses **Apply all changes**, with the total count. Course and activity names
come from the connected platform. If Morrow cannot identify them, approval stays unavailable until
the details load. Internal references stay in **Technical details**.

One click starts the approved work. The review shows progress and the checked
result automatically. You do not need to type “Continue.” Keep your assistant and
Chrome open while Morrow works. If the result is uncertain, ask Morrow in your
chat to check the existing request. Do not repeat the
change. To change your request before approval, cancel it and ask for a new one.

The review page is part of Morrow and runs on your computer. No separate review
app is installed. Morrow does not expose an AI tool that submits approval.

### Continue from your phone

Phone access uses the assistant session on your computer. Morrow and Morrow Bridge
stay on that computer. Keep it awake and online, with your assistant and signed-in
Chrome open. You still need only the two Morrow installs.

Use **Remote** in the ChatGPT mobile app to control a paired Codex host, or **Code**
in the Claude app to open a local Claude Code Remote Control session. The providers
document these host connections; Morrow still needs a complete live phone check.
See the [ChatGPT setup](https://learn.chatgpt.com/docs/remote-connections) and
[Claude setup](https://code.claude.com/docs/en/remote-control).

Before you leave your computer, select your courses in Morrow Bridge. If you want
eligible changes to run without another Morrow review, select their Edit permissions
for those courses. Other changes remain in Plan. A Morrow review link opens on your
computer; it does not open on your phone. An assistant's permission prompt does not
replace that review.

From the remote conversation, you can request reads and check saved operation or
batch results. For example: “Check the selected course pages for missing image
descriptions. Show the page and image for each finding.” If a change needs review,
keep its operation ID and review it on your computer. Do not repeat an uncertain change.

### See the content before you send it

The review renders proposed HTML as formatted content, not source code. Pages,
assignment instructions, discussions, and quiz instructions can show headings,
lists, tables, quotations, emphasis, and embedded image data. Long content flows
down the page. Short content does not leave an empty preview box.

For new multiple-choice, multiple-answer, and true/false questions with complete
supported answer settings, **Answer key** shows the choices, marked answers, and
feedback. **Try the question** lets you select an answer and see the supplied
feedback. This practice stays on your computer. It does not submit a student
attempt, approve the request, or send anything to Canvas. It compares your
selection with the proposed answer key; it does not establish that the key is
educationally correct or calculate a Canvas grade.

These previews use Morrow's layout, not Canvas's student player. Unsupported
question settings remain available below the preview. External images, videos,
and embedded tools are not fetched. Their placeholders remain visible. Links,
scripts, forms, and custom styles do not run inside the content. The exact
original request remains in **Technical details**. These display protections do
not rewrite the content sent to Canvas.

Large requests use a compact item list. Open an item for its full preview. Search
by title or course, or move through ten items at a time. Additions, edits, and
removals have separate labels. The approval button always shows the total number
of changes. Searching and opening previews do not change that total or exclude
items from approval. Removal warnings remain visible when a search hides the
affected item.

After approval, Morrow checks the current connection, course target, reviewed values, and approval again. The connector sends one platform request. It then reads the platform again. Morrow reports a confirmed result only when that fresh check matches the approved change. The result remains on the review page.

If delivery is uncertain, Morrow marks it for attention and refuses automatic replay. A later check reads the saved item without sending the change again.

Morrow makes one explicit dispatch. That is not a guarantee of one network request. A browser can resend a POST after a dropped connection, so a duplicate effect is possible even though Morrow does not retry the operation. When a Canvas create stays unresolved, the later check reads the parent collection and reports a suspected duplicate; it never deletes anything. See the [transport evidence and limits](docs/implementation/BROWSER-POST-TRANSPORT-LIMIT.md).

## Use Morrow with your other tools

You can ask for an outcome that uses more than your learning platform. For
example: “Create a PDF study guide from Week 4 and send it to Michelle Bradley
with a message in my voice.”

Morrow reads the course materials. Your assistant then coordinates its installed
document, PDF, contacts, and email tools. The workflow keeps the source titles
and links, checks the completed file, uses your approved writing preferences,
resolves the correct recipient, and checks the send result. It must identify
missing sources or tools instead of silently skipping them.

Morrow provides these instructions to the assistant when it connects. The assistant
decides which tools and skills to use. This is guidance, not a guarantee that
every assistant will trigger every installed skill. Morrow does not install a second
document editor, access another plugin's credentials, or use course-change
approval to authorize email. End-to-end compatibility requires testing in the
chosen assistant with its actual tools. That cross-plugin workflow is not yet a
verified Morrow release claim.

## Check a New Quiz

Ask your assistant: “Use Morrow to check the Week 3 quiz. It should have 20
questions worth 20 question points. Check for repeated question content in the
Week 2 quiz too.” Your assistant resolves the named course and quizzes, then calls
`morrow_check_new_quiz` with those exact targets.

The report names the course and quizzes. It checks the number of directly listed
questions, their total points, saved choice-based answer settings, and repeated
question content. It can compare up to three other New Quizzes in the same
course. Reads use the existing Chrome connection. No change approval is needed.

This is a structural check, not a complete assessment review. Repeated content
means identical question content apart from extra whitespace, not similar ideas.
The check does not judge answer correctness, learning objectives, accessibility,
bank contents, or student access. Partial reads and bank draws are marked
incomplete. Question points are not the same as Canvas assignment gradebook points.

This workflow has automated connector tests. Live Canvas verification is still
required before treating it as a production-ready feature.

## Review a lesson against your source

Ask: “Compare the Cell Structure lesson and quiz with this revised source.
Show the conflicts and proposed corrections. Do not change the course yet.”

Morrow can request separate lesson and quiz reviews from your assistant. It then
requests a third check of the findings. The report includes exact source quotes,
proposed corrections, disagreements, and limits. You review the proposals before
requesting any changes. Morrow does not make changes during this review.

This feature requires an assistant that supports MCP sampling. It currently covers
one Canvas page and up to 40 directly saved choice, multiple-answer, or true/false
New Quiz questions. It does not review bank draws, essays, media, accessibility,
or student access. Automated tests cover the model-request flow; real client and
model testing is still required.

## Browser-connected platforms

Canvas and Moodle use the same signed-in Chrome connection. Open a course you can edit in Chrome, then connect that course in Morrow. Platform sign-in stays in Chrome. Morrow keeps review, approval, and result checks together. Blackboard does not use this connection; it is described in the [Blackboard capability surface](#blackboard-capability-surface).

| Platform | Current course work | Current evidence |
| --- | --- | --- |
| Canvas | Selected lesson and quiz corrections, pages, module links, and publication work. | Selected live test-course changes and one student route were saved and checked. |
| Moodle | Course reads; Pages, Assignments, Quizzes, Text and media areas, URL Resources, Forums, Choices, Books and their chapters, Lessons, Glossaries, Wikis, Feedback activities, Databases, Folders, Resource files, IMS and SCORM packages; visibility and placement; gradebook renames and bounded gradebook configuration writes; group, Forum-post and aggregate-summary reads. The complete list is in the [Moodle capability surface](#moodle-capability-surface). | 31 of the 250 operations were saved and checked on a signed-in Moodle test course, including Page, Assignment and Quiz creation and edits, dates, activity and section visibility, an activity move, and one reviewed Resource upload with saved-byte verification. The other 219 pass local browser fixtures only and have not run on a signed-in Moodle site. Question-bank authoring is held, except one new question in a dedicated hidden bank that Morrow creates for it, because a bank change can affect random-question references outside the reviewed Quiz. Morrow stops content and date changes when it finds attached files. |

Morrow is working toward the same core features across all three platforms. It does not claim current parity.

## Chrome sign-in connection

Canvas and Moodle sign-in stays inside Chrome.

- The extension requests access to the selected Canvas or Moodle site. Chrome lists the requested sites before access is granted.
- Canvas requests use the page's signed-in session and Canvas CSRF protection. Canvas New Quizzes Item Bank requests run inside the authenticated New Quizzes frame. Item Bank credentials stay inside the extension and browser execution boundary. They never reach extension storage, the Bridge, MCP output, logs, or client configuration.
- For a reviewed Canvas file upload, the extension passively observes only the exact Canvas-issued upload response long enough to obtain its status and Canvas confirmation location. It does not block, alter, log, or retain request headers or signed URLs. The confirmation runs in the selected Canvas page with its signed-in session.
- The MCP receives bounded connection details. It does not receive cookies, passwords, OAuth tokens, CSRF tokens, or Item Bank bearer tokens.
- **Disconnect Morrow** clears the saved connection and requests removal of its granted Canvas or Moodle site permissions. It does not sign you out of the platform or undo changes already sent.

Morrow does not reuse a ChatGPT or Claude in-app browser session. Assistants set up with Morrow use the Chrome connector for available Canvas and Moodle work. The selected Codex workflow has a live Canvas test record; other assistants still need complete live checks.

## Canvas capability surface

Canvas coverage includes course discovery, pages, modules, assignments, discussions, files, Classic Quizzes, New Quizzes, Item Banks, rubrics, outcomes, enrollments, submissions, gradebook work, and other Canvas areas. A listed operation is not proof that it is ready for every course.

New Quizzes accepts all twelve question types its interaction contract covers: Multiple Answer, Matching, Categorization, File Upload, Formula, Ordering, Rich Fill in the Blank, Hot Spot, Multiple Choice, Numeric, True or False, and Essay. A Hot Spot create stages the reviewed image privately, sends it once to the presigned host Canvas names, and refuses the create unless the upload observer confirmed that exact request. See [current limits](LIMITATIONS.md) for what each type still needs before it is live-verified.

Canvas Item Banks expose seven reads and eleven course-bound owner-write shapes. Every operation is bound to the selected course. Bank management reads use a fresh credential from the exact signed-in Item Banks frame. The share read returns one observed page and always reports that pagination is incomplete. The quiz-entry read follows numbered pages to an empty end page and fails closed if it reaches its page or row bound. All eleven writes dispatch to Canvas behind exact snapshots and fresh readbacks. Eight of them can hold a standing Edit grant; the three that remove content (archiving a bank, deleting an entry, and removing a quiz's use of a bank) are approved change by change. Existing-bank changes lack complete downstream reach: Canvas provides no complete record of every course a bank reaches, so the fan-out record is always incomplete. Duplicate, standalone item deletion, stimulus lifecycle, move or copy, tags, QTI import, and broader sharing remain absent. The private routes remain live-unverified.

Four instructor-facing reads answer questions about work in progress as counts only, so no learner row has to be read and redacted: `canvas_get_classic_quiz_submission_summary`, `canvas_get_assignment_submission_summary`, `canvas_get_course_gradebook_summary`, and `canvas_get_course_activity_summary`. Each one counts inside the Canvas page before anything crosses the connection, and returns no learner identity, score, comment, or attachment name. The gradebook summary publishes a score distribution only when the assignment has at least 5 scored submissions and every band it would show holds at least 5, so no individual score can be inferred; otherwise that assignment's distribution is dropped. A read that reaches a byte or page bound reports an explicit incomplete state instead of a partial count. The three course-level reads are proved against local browser fixtures only; no signed-in Canvas course has run them, and real submission and gradebook payloads vary by tenant and role.

Morrow rejects unknown fields, missing required values, cross-site bindings, stale tabs, stale connections, mismatched requests, and expired commands before a provider request.

MindTap and Connect are not available. See the [current inclusion review](docs/release/CONNECT-MINDTAP-INCLUSION-REVIEW-2026-09-05.md). It records evidence reviewed, not a finding that either platform is categorically prohibited.

## Moodle capability surface

The Moodle catalog exposes 250 operations: 123 reads and 127 writes. That count describes implementation breadth only. It does not prove that an operation is ready for your course, role, or site. Every write reads the exact target first, sends once, then checks the saved result. Question-bank updates are held before any Moodle request, and so is question creation outside the dedicated hidden bank route listed below.

The two lists below are the complete surface. Nothing is left out.

### Checked on a signed-in Moodle test course

Dated evidence from the official hourly-reset Moodle 5.2 public sandbox with a standard teacher account. The receipts and screenshots are recorded in the [bridge parity record](docs/implementation/THREE-LMS-BRIDGE-PARITY.md). A public demo course is not a customer course.

- Course discovery and reads: `moodle_list_my_courses`, `moodle_get_course`, `moodle_get_contents`, `moodle_get_course_summary`, `moodle_list_assignments`, `moodle_list_quizzes`
- Pages, including hidden creation and title and content edits: `moodle_get_page`, `moodle_get_page_creation_form`, `moodle_create_page`, `moodle_update_page`
- Assignments, including hidden creation and instruction and due-date edits: `moodle_get_assignment`, `moodle_get_assignment_creation_form`, `moodle_create_assignment`, `moodle_update_assignment`. The wider Assignment settings that this read and this edit now cover, and every Assignment override operation, pass local browser fixtures only.
- Quizzes without questions, including hidden creation and instruction and open/close-date edits: `moodle_get_quiz`, `moodle_get_quiz_creation_form`, `moodle_create_quiz`, `moodle_update_quiz`. The wider Quiz settings that this read and this edit now cover, and every Quiz override operation, pass local browser fixtures only.
- Quiz questions, read only, for one exact slot: `moodle_list_quiz_questions`, `moodle_get_quiz_question`
- Text and media areas, read and content edit: `moodle_get_label`, `moodle_update_label`
- URL Resources, read and external-address and description edit: `moodle_get_url`, `moodle_update_url`
- Visibility and placement: `moodle_show_activity`, `moodle_hide_activity`, `moodle_show_section`, `moodle_hide_section`, `moodle_move_activity`
- Files: read a Resource's root-file metadata, and create one hidden Resource from one reviewed workspace file of at most 1 MiB with saved-byte verification: `moodle_get_resource_files`, `moodle_create_resource_file`

### Implemented and locally tested only, not yet checked on a signed-in Moodle site

Each of these passes a browser fixture that drives Chrome against a local server serving Moodle's own page markup. No signed-in Moodle site has run any of them. Treat them as unproven on a real course.

- Course and section settings, and whole-course visibility: `moodle_get_section`, `moodle_update_section`, `moodle_update_course_summary`, `moodle_show_course`, `moodle_hide_course`. Showing or hiding a course changes whether every enrolled learner can open it.
- Activity and section access restrictions: `moodle_get_activity_restrictions`, `moodle_update_activity_restrictions`, `moodle_get_section_restrictions`, `moodle_update_section_restrictions`. Reads describe the saved restriction tree. A change replaces the complete reviewed tree and preserves every other setting; unknown condition types are refused. These checks establish saved settings, not what a learner can see.
- H5P activity settings and hidden creation from one reviewed package, staged locally with `morrow_plan_moodle_h5p_package` or `morrow_plan_moodle_h5p_package_replacement`: `moodle_get_h5pactivity`, `moodle_get_h5pactivity_creation_form`, `moodle_create_h5pactivity`, `moodle_update_h5pactivity`, `moodle_replace_h5pactivity_package`. Content bank selection is held because its other uses cannot be scoped. Package byte comparison does not prove that a learner can launch the activity.
- The full course settings form: read every control it carries, then change a bounded group of them in one save: name, short name, ID number, start and end dates, the options of the format the course already uses, appearance, files and uploads, completion tracking defaults, groups, tags and course custom fields: `moodle_get_course_settings`, `moodle_update_course_settings`. A change refuses before it sends anything when the course image, or any other file area on that form, is not empty or cannot be proved empty. The course category cannot be changed, and a new tag cannot be created.
- Changing the course format: `moodle_change_course_format`. The new format decides where every section and every activity in the course appears. Morrow reads the complete course state before the change and again after it, reports both, and cannot put the previous layout back.
- Backing up, restoring, importing and copying a whole course: `moodle_list_backup_files`, `moodle_start_course_backup`, `moodle_get_backup_progress`, `moodle_start_course_restore`, `moodle_get_restore_progress`, `moodle_start_course_import`, `moodle_copy_course`. Each of these is a multi-step native workflow: Morrow sends each step once, reads back the stage Moodle answered with before it sends the next one, never repeats a step whose answer was lost, and ends a workflow Moodle did not answer as promised with Moodle's own Cancel. A restore changes the whole course, and the approval names the exact backup file, the exact course and the mode; a delete-and-restore removes every section, every activity and every learner record in the course first, and Morrow cannot undo either mode. An import only merges into the course and deletes nothing. A copy is always created hidden, with no learner data and no kept enrolments. Progress is read one request at a time and is never waited on. A backup and a restore are refused unless the site runs them as scheduled tasks. Backup file contents are never read or compared byte for byte.
- Activity completion and course completion: read every completion control the native form carries, then change the tracking mode, the conditions and the expected completion date of one activity, or the course completion conditions of the course: `moodle_get_activity_completion`, `moodle_update_activity_completion`, `moodle_get_course_completion`, `moodle_update_course_completion`. Moodle applies a completion change to work learners have already done, so each change states the number of enrolled participants in the course and refuses when Morrow cannot establish that number or when it has changed. Morrow refuses every change while Moodle has locked the completion settings because learner completion data already exists, because unlocking them recalculates or deletes that data. It never opens an activity view page, so no read records a completion. Whether a learner then sees the activity as complete cannot be checked without a learner account, and Morrow has not checked it.
- The lifecycle of one activity: copy it, delete it, or move it to an exact position in a section, for an activity of any core module type: `moodle_duplicate_activity`, `moodle_delete_activity`, `moodle_move_activity_to_position`. A copy carries the activity's content and files, and no learner work, and it is visible to learners whenever the original is. A deletion cannot be undone by Morrow: it removes the activity with its files, grades, completion records, and the learner work its module type holds, such as submissions, attempts, responses, or posts. Morrow states that exact list, refuses a module type it cannot state it for, and asks you to approve each deletion on its own.
- The lifecycle of the sections of a course: add one empty section at the end, delete one section with every activity in it, or move one section to an exact place in the course order: `moodle_create_section`, `moodle_delete_section`, `moodle_move_section`. A new section is empty and visible, and it carries the name Moodle builds from its place until you give it one. Moving a section renumbers the sections between its old and its new place, and the General section does not move. A deletion cannot be undone by Morrow: it removes the section, its summary and its files, and every activity in it with the learner work each one holds. Morrow names every activity the deletion removes, refuses a section it cannot name the removals for, and asks you to approve each deletion on its own.
- Subsections, the sections that sit inside a section: read one, list what it holds in the order it is stored, and add one hidden: `moodle_get_subsection`, `moodle_list_subsection_contents`, `moodle_create_subsection`. Moodle makes the subsection and the section it shows in one step, so a new subsection is hidden and empty and sits after everything else until you move it. Morrow reads the whole subsection before it changes anything near one, so hiding a subsection, or the section that holds it, names every activity inside it that the hide also hides. Showing one again is refused while it holds anything, because Moodle puts each activity back to the visibility it had before and Morrow cannot read that stored value.
- Text and media area and URL Resource creation: `moodle_get_label_creation_form`, `moodle_create_label`, `moodle_get_url_creation_form`, `moodle_create_url`
- Forums, settings only: `moodle_get_forum`, `moodle_get_forum_creation_form`, `moodle_create_forum`, `moodle_update_forum`
- Forum discussions and posts. Read one exact posting target, start one discussion, reply once to one post, lock or unlock a discussion, pin or unpin a discussion, and set your own subscription to a discussion. The post text is HTML you write, and Morrow sends no file with a post. A saved discussion or reply is visible to every learner who can see the Forum as soon as Moodle saves it, and Morrow cannot remove it, so a visible Forum refuses an unconfirmed post before it sends anything. The target read returns no author name, no author ID, and no post body: `moodle_get_forum_post_target`, `moodle_create_forum_discussion`, `moodle_reply_to_forum_post`, `moodle_lock_forum_discussion`, `moodle_pin_forum_discussion`, `moodle_set_forum_subscription`
- Choices, settings, the saved option list, and how many learners have responded: `moodle_get_choice`, `moodle_get_choice_creation_form`, `moodle_create_choice`, `moodle_update_choice`, `moodle_get_choice_options`, `moodle_get_choice_response_summary`, `moodle_update_choice_option`. The response summary is a count. It carries no learner and no chosen option. The option write changes one option's text or response limit, bound by that option's own ID and position, and refuses once the Choice has responses.
- Books, settings and chapters. Deleting a main chapter also deletes its following subchapters and their files: `moodle_get_book`, `moodle_get_book_creation_form`, `moodle_create_book`, `moodle_update_book`, `moodle_list_book_chapters`, `moodle_get_book_chapter`, `moodle_get_book_chapter_creation_form`, `moodle_create_book_chapter`, `moodle_update_book_chapter`, `moodle_move_book_chapter`, `moodle_show_book_chapter`, `moodle_hide_book_chapter`, `moodle_delete_book_chapter`
- Lessons: settings, a read-only view of the page and question graph, and page authoring. The graph read returns every page in stored order with its type, title and jumps resolved to page IDs, and one page read returns that page's contents, answers, responses, scores and jumps. Nothing here opens the Lesson view route, so nothing records learner progress; a page whose text carries a draft-file reference or embedded media is refused. Page authoring adds, rewrites, moves and deletes one page of a Content page or a True/false, Short answer or Multichoice question page: each one reads the complete page graph, names every page whose jump destination the change moves, sends one request, and requires the approved graph back. Deleting a page also names every page whose jump the deletion would leave pointing at a page that no longer exists, and refuses unless you name the same pages: `moodle_get_lesson`, `moodle_get_lesson_creation_form`, `moodle_create_lesson`, `moodle_update_lesson`, `moodle_list_lesson_pages`, `moodle_get_lesson_page`, `moodle_create_lesson_page`, `moodle_update_lesson_page`, `moodle_move_lesson_page`, `moodle_delete_lesson_page`
- Glossaries, settings and entries. The list comes from Moodle's own export, which carries no entry ID and leaves out entries waiting for approval, so a change to one entry needs the ID from that entry's Edit link. Adding an entry needs a Glossary that approves entries by default, because Morrow cannot read an unapproved entry back. A Glossary keeps no version history, so an entry change cannot be undone: `moodle_get_glossary`, `moodle_get_glossary_creation_form`, `moodle_create_glossary`, `moodle_update_glossary`, `moodle_list_glossary_entries`, `moodle_get_glossary_entry`, `moodle_create_glossary_entry`, `moodle_update_glossary_entry`
- Wikis, settings and pages. The page list covers the current group's subwiki. Reading or writing a page opens Moodle's own editor, which takes the same 30-second editing lock Moodle takes when a person clicks Edit, and a page another person has locked is refused. A page write binds the exact version and reads the saved version back. Moodle keeps the replaced content in the page history; Morrow has no route that restores it: `moodle_get_wiki`, `moodle_get_wiki_creation_form`, `moodle_create_wiki`, `moodle_update_wiki`, `moodle_list_wiki_pages`, `moodle_get_wiki_page`, `moodle_update_wiki_page`
- Workshops, settings and the stored phase. The settings read returns the grading strategy, both maximum grades, the submission types, the file and feedback settings and the four availability dates. A create makes the Workshop hidden and in Moodle's own setup phase, so it accepts no submission and no assessment until a person moves it on in Moodle. A change is bounded to the name, the four instruction texts and the four availability dates; it refuses a date change while Moodle's own automatic switch to the assessment phase is set, because Moodle would then switch the phase itself once the submission deadline passed. The phase read returns the stored phase and nothing about any learner. Morrow has no route that switches a phase, allocates a submission, writes an assessment or calculates a grade: `moodle_get_workshop`, `moodle_get_workshop_creation_form`, `moodle_create_workshop`, `moodle_update_workshop`, `moodle_get_workshop_phase`
- Feedback activities, settings, the saved question list, and how many responses were submitted: `moodle_get_feedback`, `moodle_get_feedback_creation_form`, `moodle_create_feedback`, `moodle_update_feedback`, `moodle_get_feedback_items`, `moodle_get_feedback_response_summary`, `moodle_create_feedback_item`, `moodle_update_feedback_item`. The response summary is a count. When the Feedback is anonymous, Morrow refuses a per-learner projection of it. The question writes cover the `numeric`, `textarea` and `textfield` types, bind one question by its own ID and position, and refuse once the Feedback has responses.
- Database activities, settings, the saved field list, and the aggregate entry counts: `moodle_get_database`, `moodle_get_database_creation_form`, `moodle_create_database`, `moodle_update_database`, `moodle_get_database_fields`, `moodle_get_database_entry_summary`, `moodle_create_database_field`, `moodle_update_database_field`. The entry summary is a count. It carries no entry content and no learner. The field writes cover the `number`, `text` and `textarea` types and refuse unless Moodle's own overview reports that the Database holds no entry.
- Folders and Resource file preparation: `moodle_get_folder`, `moodle_get_folder_files`, `moodle_get_folder_file_creation_form`, `moodle_create_folder_file`, `moodle_get_resource_file_creation_form`
- Changing the files of a saved activity: replace the one file of a Resource, delete one extra Resource file, add up to 8 reviewed files of at most 1 MiB together to one Folder path, and create one empty subfolder. Replacement and deletion break learner links to the removed file. The assistant file planners stage the replacement and multiple Folder files for review: `moodle_replace_resource_file`, `moodle_delete_resource_file`, `moodle_add_folder_files`, `moodle_create_folder_subfolder`
- IMS content packages, one reviewed ZIP or IMS Common Cartridge of at most 1 MiB into a new hidden activity: `moodle_get_imscp`, `moodle_get_imscp_package_creation_form`, `moodle_create_imscp_package`
- SCORM packages, one reviewed ZIP of at most 1 MiB into a new hidden activity, a bounded settings edit, and one package replacement for a hidden activity. A package change can invalidate the existing learner attempts and tracking data. Saved bytes are compared; that does not establish package validity or learner access. The assistant file planner stages the replacement package for review: `moodle_get_scorm`, `moodle_get_scorm_package_creation_form`, `moodle_create_scorm_package`, `moodle_update_scorm`, `moodle_replace_scorm_package`
- External tool (LTI) activities, for one preconfigured tool the approval names: read one activity or the creation form, create one hidden activity, and rename it or turn its grade passback on. Turning grade passback on lets the external tool write a grade into the course gradebook for every learner; it cannot be turned off here, because Moodle answers that by deleting the activity's gradebook item and the grades in it. Morrow never launches the tool and opens no `/mod/lti` page, so no launch, deep-linking, service or report request is sent, and the consumer key and shared secret stay in Chrome. Morrow cannot verify anything about the external tool: `moodle_get_lti`, `moodle_get_lti_creation_form`, `moodle_create_lti`, `moodle_update_lti`
- BigBlueButton rooms: read one activity or the creation form, create one hidden room, and change an existing closed room's name, opening time, closing time, or wait-for-moderator setting. Each write is reviewed, and an edit is refused unless Moodle's own schedule proves the room is closed. Morrow performs no BigBlueButton server action: it never joins, starts or ends a meeting, never asks for a recording, and opens no `/mod/bigbluebuttonbn` page. Whether a meeting is running is not on the settings form and cannot be read from the browser without asking the BigBlueButton server, so Morrow fails closed on Moodle's own room-open rule and refuses to create a room that would already be open. The guest join link and the guest password stay in Chrome, and the participant role mapping is never returned: `moodle_get_bigbluebuttonbn`, `moodle_get_bigbluebuttonbn_creation_form`, `moodle_create_bigbluebuttonbn`, `moodle_update_bigbluebuttonbn`
- SCORM attempt and learner tracking reads. Moodle 5.2.2 registers its SCORM web-service functions without the AJAX flag, so on a stock Moodle site both reads refuse and return nothing. The learner report returns a stable learner token, never a name or an ID: `moodle_get_scorm_attempt_summary`, `moodle_get_scorm_learner_report`
- Gradebook configuration reads and bounded configuration writes. The reads cover the setup tree, one grade category, one manual grade item, the course scales, the course and site outcomes, and the course grade settings; each returns configuration only, with no student name, no student grade, and no stored grade value. The writes rename one category or one manual item, change one category's aggregation, drop-lowest count and weight, and change one manual item's grade type, grade range, display type, decimal places and parent category; each carries its own protected digest and refuses a grade-range change on an item that already has grades unless the approval names the effect on those grades: `moodle_get_gradebook_setup`, `moodle_get_grade_category`, `moodle_get_grade_item`, `moodle_get_grade_scales`, `moodle_get_grade_outcomes`, `moodle_get_gradebook_settings`, `moodle_update_grade_category`, `moodle_update_grade_item`, `moodle_update_grade_category_settings`, `moodle_update_grade_item_settings`
- Grader report reads. The course summary returns counts and percentage bands for each grade item, category total, and course total, and no learner identity of any kind. The learner report returns one learner's per-item state and whole-percent value, and names that learner only by a stable token; a person who is not on the complete course participant roster is refused. Both require the Moodle grader-report view and view-all-grades capabilities, and both read the grader report page without changing a grade: `moodle_get_grade_report_summary`, `moodle_get_learner_grade_report`
- Group map and Forum posts. Learner identities are projected to stable tokens before any result leaves the browser: `moodle_get_course_groups`, `moodle_get_forum_posts`
- Participants and enrolment, reads. The participant list gives each person's role names and the enrolment methods that placed them in the course; the enrolment-method list gives each method's name, whether it is enabled, and how many users it holds; the single-learner read gives that learner's method, the status label the site rendered, and the start and end. Both learner reads project the identity to a stable token and refuse a user the complete participant roster does not hold: `moodle_get_course_participants`, `moodle_get_enrolment_methods`, `moodle_get_participant_enrolment`
- Enrolment and role writes, one exact person at a time. Enrolment and role assignment stay separate: an enrolment gives only the role the course's manual enrolment method is set to give, and a role change touches no enrolment. Existing participants are selected by course-bound opaque learner tokens. A new participant is selected by the opaque candidate token from `morrow_find_moodle_enrolment_candidate`, which performs an exact native name query and returns no name, email address or Moodle user ID. Gateway resolves either token again inside the exact live course binding immediately before one native request, then reads the participant record back with every other participant unchanged. Unenrolling is the destructive one: it can remove that person's grades, submissions and participation history, Morrow cannot undo it, and it is never a standing Edit grant: `moodle_enrol_participant`, `moodle_suspend_participant`, `moodle_unenrol_participant`, `moodle_assign_role`, `moodle_remove_role`
- Groups and groupings, read and write. Read every grouping of the course with the exact groups in it: `moodle_get_course_groupings`. Create a group, change its name, visibility or participation flag, delete it, and put one learner into it or take one out: `moodle_create_group`, `moodle_update_group`, `moodle_delete_group`, `moodle_add_group_member`, `moodle_remove_group_member`. Create or rename a grouping and set which groups belong to it: `moodle_create_grouping`, `moodle_update_grouping`, `moodle_set_grouping_groups`. Set one activity's group mode: `moodle_set_activity_group_mode`. Moodle freezes a group's visibility and participation once it has a member, and Morrow refuses a change to either while they are frozen. Deleting a group is the destructive one: it takes every member out of the group, takes the group out of every grouping, and removes its calendar events and its group conversation; Morrow lists every member the deletion removes, refuses when that membership is not the one you approved, and cannot undo it. Member identities are projected to stable tokens before any result leaves the browser. A course that forces its own group mode overrides an activity's saved value, so the group-mode result states the mode that is in effect as well as the value it saved.
- Assignment overrides, read and write. The list names each override, whether it is for a user or a group, and its dates; it carries no learner name and no learner ID. Each change reads the complete list back and requires exactly the approved override with every other override unchanged: `moodle_get_assignment_overrides`, `moodle_create_assignment_override`, `moodle_update_assignment_override`
- Quiz overrides, read and write. The list names each override, whether it is for a user or a group, and its open date, close date, time limit and attempts; it carries no learner name, no learner ID, and no override password. Each change reads the complete list back and requires exactly the approved override with every other override unchanged: `moodle_get_quiz_overrides`, `moodle_create_quiz_override`, `moodle_update_quiz_override`
- Quiz slot layout, read and four changes to it. The read returns every slot's position, page, Quiz section, question type, mark, and the native controls the Quiz edit page offers on it. The changes move one question inside its Quiz section, set one question's maximum mark, add or remove the page break before one question, and remove one question from the Quiz. Removing a question from a Quiz does not delete the Question bank entry it uses. Each change reads the complete layout back and requires exactly the approved change with every other slot unchanged. Moodle hides these edit controls on a Quiz that already has attempts, and Morrow then refuses every one of them: `moodle_get_quiz_structure`, `moodle_reorder_quiz_slot`, `moodle_set_quiz_slot_mark`, `moodle_set_quiz_page_break`, `moodle_remove_quiz_slot`
- Quiz attempt records, the manual grading queue, and the regrade state, all read through Moodle's own Quiz report routes. The attempt read returns one exact attempt: its state, the started, completed and duration text Moodle rendered, and each question slot's state and displayed mark. It returns no response text and names the learner only by a stable token; a person who is not on the complete course participant roster is refused. The grading queue and the regrade state are aggregate only and name nobody. None of the three opens the attempt, review, or question-review page, and the regrade read sends no session key and no regrade parameter, so it starts no regrade. Reading a Moodle report records one report-viewed event for you in the course log. Grading a response by hand and running a regrade are not implemented: `moodle_get_quiz_attempt`, `moodle_get_quiz_manual_grading_queue`, `moodle_get_quiz_regrade_report`
- Moodle's own course reports, bounded and aggregate by default. The activity report gives each activity's view count; the activity-completion report gives, per tracked activity, how many of the listed people are complete, incomplete, or neither; the log summary gives entry counts by activity and by request origin and never reads the log's time, user, description, IP address or user agent cells; the dates report counts the course's dated calendar entries by month and by activity. The participation report gives, for one activity and one time window, how many people did the action and how many times; it names nobody unless the request asks for the people it counted, and each identity is then a stable learner token, with a person the complete participant roster does not hold refusing the whole report. Each report requires its own Moodle report capability, except the dates count, because Moodle ships no core dates report: `moodle_get_course_activity_report`, `moodle_get_course_participation_report`, `moodle_get_course_completion_report`, `moodle_get_course_log_summary`, `moodle_get_course_dates_report`
- Aggregate learner summaries, counts only, with no learner row, name, ID, or grade: `moodle_get_assignment_submission_summary`, `moodle_get_quiz_attempt_summary`, `moodle_get_forum_activity_summary`
- Assignment submission and feedback for one exact learner, as metadata and counts only. Moodle 5.2.2 does not enable its Assignment submission-status web-service function for the browser AJAX endpoint, so on a stock Moodle site both reads refuse and return no record. The learner is returned as a stable learner token, never a name or an ID, and no file bytes, file URL, submission text, or feedback text leaves the browser: `moodle_get_assignment_submission`, `moodle_get_assignment_feedback`
- Question Bank filter inventory, which inspects an already-open bank page and reports that the server-side condition class and plugin component are not visible to a browser: `moodle_get_question_bank_filter_inventory`
- System administration inventory, read-only, with no administration write of any kind. The site inventory gives this Moodle's release and every installed plugin's type, name, component, version and enabled or disabled state, and reports the enabled authentication, enrolment, question-bank filter, availability condition, repository and filter plugins as their own sets. The role read gives every role's short name, and, for one named role, its archetype and the capability overrides Moodle shows at the selected course's own context; when Moodle does not serve that role's override form, the overrides stay unknown and are never reported as none. Both read Moodle's own administration pages, which Moodle serves only to a site administrator or to a person holding the exact system-context capability, and both refuse and report nothing when a page is not served. No plugin display name, settings link, uninstall link, notes, role description or hidden form control is read, so no key, token, password or session key can leave the page: `moodle_get_site_inventory`, `moodle_get_role_definitions`
- Question Bank impact scope for one course, which enumerates every Quiz slot's stored direct or random reference and reports every reason the scope is incomplete. A complete scope covers that course only and authorizes no Question Bank write; question authoring stays held: `moodle_get_question_bank_impact_scope`
- Hidden Question bank activity, phase one of the dedicated bank route: read the creation form, create one hidden standard `mod_qbank` activity, read that saved activity, and separately approve opening Moodle's own Question bank route once, which is what makes Moodle create the bank's top and default categories. Morrow reads the category and question context back from the address Moodle returns and requires the bank page's add-question control, which is how `moodle/question:add` is visible to a browser. These two changes create no question and change no Quiz: `moodle_get_qbank_activity_creation_form`, `moodle_create_qbank_activity`, `moodle_get_qbank_activity`, `moodle_realize_qbank_default_category`
- Hidden Question bank questions, phase two of the same route: read the native form that creates one new Multichoice, True/false, or Short answer question in that bank category and create it, then read what one Quiz slot would do and add that one entry to the approved Quiz. Morrow re-derives the course's complete Question Bank impact scope before each change and refuses an incomplete scope, or a stored random filter that uses `jointype = NONE`. It never updates, clones, or moves a saved entry, it carries no file and no tag, and the new Quiz reference always resolves to the latest version, so every later edit to that question stays held. Morrow prepares each of these two changes on its own for your approval: `moodle_get_qbank_question_creation_form`, `moodle_create_qbank_question`, `moodle_get_qbank_quiz_slot_plan`, `moodle_add_qbank_question_to_quiz`
- The calendar of a course, and its dates. List the events of one course month by month, read every date the course carries grouped by the activity that owns it, and read one exact event: `moodle_list_course_events`, `moodle_get_course_dates`, `moodle_get_event`. Moodle ships no core course Dates page, so the grouped read is the course calendar and nothing else, and an activity date the calendar does not carry is not listed. Create, change, and delete one course event: `moodle_create_course_event`, `moodle_update_event`, `moodle_delete_event`. An activity's own due, open, and close dates reach the calendar as activity events, and these reads list and read them; changing one is done on the activity itself. A course event is in the calendar of everyone enrolled in the course as soon as Moodle saves it. Morrow never converts a wall-clock date: every date it reports is the year, month, day, hour, and minute Moodle itself rendered, every date it sends is the one that was approved, every result names the time zone the signed-in person has configured, and it refuses the operation when the page states no time zone. Morrow refuses an event an activity owns, because that date belongs to the activity and Moodle builds the event again, and it refuses a repeating series, a personal, site, or category event, and any event outside the course. Deleting an event cannot be undone; the event read states exactly what a deletion removes and keeps before you approve it.
- The internal privacy roster `moodle_get_course_participant_roster`. Morrow uses it only to redact learner identifiers before a result leaves the browser. It is not offered to an assistant as a participant list.

Morrow claims no Moodle feature that is not in these lists. Missing areas include participants and enrolment, calendar and events, access restrictions, learner completion state and completion reports, import, backup and restore, reports and logs, question authoring outside the dedicated hidden bank route above, and site administration. See the [full functionality scope](docs/implementation/MOODLE-FULL-FUNCTIONALITY.md) for the complete gap list.

## Blackboard capability surface

Blackboard does not use the Chrome connection. Morrow calls the official Anthology Learn REST API with local credentials. It binds every Blackboard request to one configured HTTPS tenant origin, one integration account, and one course, and it refuses a course binding that does not derive from that exact tenant principal and course.

Before any of this works, a Blackboard administrator has to install Morrow's REST application on the Learn site, choose the Learn account the integration acts as, and give that account the entitlements these routes need. Morrow cannot do that part for you, and the entitlement list is not settled: no tenant has confirmed it, so Morrow records every entitlement as unknown. The [Blackboard REST scope](docs/implementation/BLACKBOARD-REST-SCOPE.md) holds the route inventory, the held operations, and the live-tenant acceptance runbook.

These Blackboard reads ship: `blackboard_read_course`, `blackboard_list_course_contents`, `blackboard_read_course_content`, `blackboard_list_content_children`, `blackboard_inventory_course_contents`, `blackboard_get_course_availability`, `blackboard_list_my_courses`, `blackboard_list_content_attachments`, `blackboard_read_content_attachment`, `blackboard_read_integration_account`, `blackboard_list_gradebook_columns`, `blackboard_read_gradebook_column`, `blackboard_list_gradebook_attempts`, `blackboard_read_gradebook_attempt`, `blackboard_read_course_assessment`, `blackboard_list_course_announcements`, `blackboard_read_course_announcement`, `blackboard_list_course_groups`, `blackboard_list_course_group_sets`, `blackboard_read_course_group`, `blackboard_list_group_members`, and `blackboard_course_roster_summary`. The roster summary reports how many people are in the course and returns no name and no contact detail; each person’s role is returned with a protected reference. The identity map stays encrypted on your computer. Two more reads, `blackboard_read_course_membership` and `blackboard_read_gradebook_grade`, read one person's course role and one person's grade, using one of those exact course references. The references survive a restart; a reference from another course is refused. `blackboard_list_group_members` names everyone in one group by one of those references and returns no name and no contact detail. The attempt reads name each person by one of those references and return the score, the status, and the timestamps; they return no submitted work and no feedback, and they do not ask Blackboard for either. `morrow_blackboard_health` reports what is configured; a configured status is not a live connection. `blackboard_unresolved_effects` lists the Blackboard changes Morrow sent and could not confirm, so you can open each item in Blackboard and check it yourself; it sends no Blackboard request and repeats no change. In the Full tool surface an assistant calls each read under its own name. In the compact tool surface the desktop app configures, no catalog tool is registered under its own name, and an assistant reaches each read under that same name through `morrow_capability_read`.

Morrow exposes 15 reviewed Blackboard action planners: `morrow_plan_blackboard_membership_patch`, `morrow_plan_blackboard_gradebook_column_patch`, `morrow_plan_blackboard_gradebook_grade_patch`, `morrow_plan_blackboard_content_attachment`, `morrow_plan_blackboard_ultra_assignment`, `morrow_plan_blackboard_course_announcement`, `morrow_plan_blackboard_course_announcement_patch`, `morrow_plan_blackboard_course_group`, `morrow_plan_blackboard_course_group_patch`, `morrow_plan_blackboard_group_membership`, `morrow_plan_blackboard_group_membership_removal`, `morrow_plan_blackboard_course_availability`, `morrow_plan_blackboard_content_dated_visibility`, `morrow_plan_blackboard_course_copy`, `morrow_plan_blackboard_content_patch`. Each planner freezes the exact selected course, account, credential generation and change. It sends no course write. Approval permits one dispatch, followed by a fresh saved-result comparison. The source apply and verification tools remain private.

Blackboard supports reviewed content metadata and dated visibility, course availability, an existing membership role or availability, gradebook column settings and a person’s score or grade text, one workspace file attachment, a new Ultra assignment, announcement creation and editing, group creation and editing, group membership addition and removal, and an exact course copy into a new course ID. File attachments use one workspace file of at most 1 MiB. Blackboard can notify enrolled learners when an announcement is posted; Morrow cannot recall those notifications. Creating an Ultra assignment also creates its gradebook column, and Morrow has no undo route for either. A course copy is asynchronous and cannot be undone here; Morrow retains Blackboard's task reference and verifies the copied course only after the task reports completion. Content metadata changes are limited to a `resource/x-bb-document` item’s title, description and availability. Document bodies, tests, questions, question banks, discussions, forums, course enrolment creation or removal, standalone gradebook column creation or deletion, and group or group-set deletion remain unavailable. These limits follow the current implementation and the documented REST contract; no live tenant has been tested.

No live Blackboard tenant has been tested. Every Blackboard statement here is proved against local mocked-HTTPS fixtures only. Treat the whole Blackboard route as live-unverified. See [current limits](LIMITATIONS.md).

## Batches and long-running work

Morrow supports durable read and write batches across explicit course sets.

- Every child has an exact course, tool, arguments digest, source binding, dependency set, and operation ID.
- One local page shows the complete frozen target set before approval.
- One click starts the approved write batch through bounded windows. The review updates its confirmed count. It stops starting more work after an unconfirmed result. **Stop remaining changes** cancels unsent operations; a request already sent can still finish.
- Each write child receives its own single-use effect receipt.
- Approved concurrency and rate controls cannot change during execution.
- Child results remain independently true when another child fails or becomes uncertain.
- Pause and cancel stop new child dispatch.
- Restart recovery resumes from durable checkpoints and never replays an uncertain write.
- Large batches use bounded database pages instead of one unbounded MCP response.

## Privacy and local state

Morrow projects results before it returns them to the AI client. It applies field policy, record limits, byte limits, free-text policy, and learner tokenization at the gateway boundary. Sensitive nested errors are scrubbed. The learner vault, operation journal, encrypted batch manifests, pairing state, and verification receipts stay on the user's computer.

Client configuration contains only the local Node command, server entry path, working directory, and `MORROW_UPSTREAMS_FILE`. It contains no Canvas credential, Blackboard secret, or browser secret.

## The Morrow desktop app

Morrow is one desktop application. It carries the Morrow MCP runtime, the Node runtime that runs it, and the Morrow Bridge files Chrome loads. `installer/electron-builder.config.cjs` builds exactly two artifacts.

| System | Artifact | What has been checked |
| --- | --- | --- |
| macOS on Apple silicon | `Morrow-<version>-mac-arm64.dmg`, with a matching `.zip` | The unsigned 1.0.0 disk image was mounted and installed on the MacBook. The packaged runtime passed `scripts/test/desktop-mac-smoke.mjs`, including the Bridge listener and private state modes. |
| Windows on x64 | `Morrow-<version>-win-x64.exe`, a one-click per-user NSIS installer | The unsigned 1.0.0 installer passed install, start, damaged-payload refusal, exact repair, uninstall, and retained-data checks on native Windows `BOOTZ`. `scripts/test/desktop-windows-smoke.mjs` runs on native Windows only. |

There is no Intel macOS build and no Linux build. Nothing is signed or notarized. The public unsigned 1.0.2 release is available from the [Morrow downloads page](https://meetmorrow.app/download). Building the app from this checkout is a maintainer step, described under [development and engineering evidence](#development-and-engineering-evidence).

You need Chrome 116 or later and one supported assistant already installed on the same computer: ChatGPT, Claude Desktop, Claude Code, or Gemini CLI.

### What the app asks you to do

The app presents three stages and shows one next action at a time:

1. **Choose your assistant.** Morrow lists the assistants it found on this computer and configures only the one you select. Claude Desktop receives a generated local extension and asks you to approve it in Claude Desktop. Each of the other three receives one Morrow entry in its own settings file. Morrow keeps a private copy of a settings file before it changes it.
2. **Set up Morrow Bridge.** Select **Show Bridge folder**. Morrow opens the folder Chrome must load. In Chrome, open the three-dot menu, select **Extensions**, then **Manage Extensions**, turn on **Developer mode**, select **Load unpacked**, and select that folder. Open Morrow Bridge, select **Connect Morrow**, then select **Allow connection** on the Morrow page only if you started it. This temporary Chrome step stands until Morrow Bridge has a Chrome Web Store listing. A managed Chrome profile can block it, and Morrow does not work around that restriction.
3. **Open and connect your course.** Open a signed-in Canvas or Moodle course in Chrome. Morrow Bridge identifies the platform and shows **Connect Canvas** or **Connect Moodle**. Select that button and allow the exact platform address Chrome shows. In Plan and Edit settings, choose a course and select **Connect selected courses in Plan**. Morrow then reads the course it names once to confirm the connection. That read changes nothing in the course.

Morrow creates a default materials folder. Choosing another folder is optional, and you can change it after setup.

Morrow does not ask you to open a terminal, type a path, install Node.js or pnpm, build source, or start a separate service.

### After setup

The app keeps the same window for the rest of the installation's life. It carries:

- **Repair Morrow**, which checks the files inside Morrow, replaces the Morrow Bridge folder from the copy Morrow ships when the folder does not match it, and writes your assistant setting again. It leaves a newer assistant setting alone and changes nothing in your course.
- **What stays on this computer**, which names the exact path of every place this installation keeps data, marks which of them Morrow can remove, and states the step this computer uses to remove the application itself. **Remove Morrow's data** first shows a confirmation listing every path it will remove and every path it will keep, then reads each path again and reports which are gone and which are still there.
- Changing the materials folder and removing an assistant after setup.
- Manual installation of a newer unsigned build. Automatic updates remain disabled in unsigned releases.

### What the desktop app has not proved

- The Mac and Windows releases are unsigned, as required for this release. Gatekeeper and SmartScreen behavior after a public download has not been verified.
- Complete live-course setup through the final installed app is still open. The native startup and repair checks use isolated application state.
- Automatic signed updates have not been tested or enabled. They are outside this unsigned release.
- Morrow Bridge has no Chrome Web Store listing. The temporary Developer-mode step is the only route, and reloading the unpacked Bridge in Chrome always needs a person.

See [current limits](LIMITATIONS.md) for the complete list. The exact saved receipt for each desktop result, and each result that has no receipt, is listed in the [completion goal](docs/implementation/MORROW-1.0-COMPLETION-GOAL.md).

## Development and engineering evidence

The two sections below are how Morrow is built and checked. Neither is the consumer installation. A person installing Morrow uses [the desktop app](#the-morrow-desktop-app).

### The macOS Apple silicon MCP archive

`morrow-v1.0.0-rc.0-darwin-arm64-mcp.zip` was a self-contained archive holding Morrow MCP, Morrow Bridge, and the Node runtime they use. It was set up from the command line. It is historical engineering evidence: `scripts/package-mcp-bundle.mjs` in this checkout builds desktop payloads and installers only, so no command here rebuilds that archive, and no archive is published.

A dated archive passed installed-client startup and workspace isolation on the MacBook, plus a separate iMac recipient check without global Node or pnpm. Its Bridge paired with the native Moodle sandbox on the MacBook. Later runtime fixes are not in it. Those receipts are kept locally, outside the public tree, and the [current work record](docs/implementation/MORROW-ACTIVE-GOAL.md) names which archive each result belongs to. These checks establish nothing about another operating system: the archive was built for macOS on Apple silicon only.

Its documented use was:

1. Extract the ZIP into a folder that stays in place. The assistant configuration holds that folder's absolute path.
2. From the project directory, run one command that matches the assistant, replacing `/path/to` with the extracted folder path.

   ```bash
   cd /path/to/your-project
   /path/to/morrow-v1.0.0-rc.0-darwin-arm64-mcp/bin/morrow install codex
   # or: /path/to/morrow-v1.0.0-rc.0-darwin-arm64-mcp/bin/morrow install claude
   # or: /path/to/morrow-v1.0.0-rc.0-darwin-arm64-mcp/bin/morrow install gemini
   ```

   The command wrote only the current project's configuration: `.codex/config.toml`,
   `.mcp.json`, or `.gemini/settings.json`. It did not edit a user-wide assistant
   configuration. Claude Desktop uses a user-wide configuration file, so this
   project-scoped archive did not install it.
3. In Chrome, open `chrome://extensions`, turn on **Developer mode**, select
   **Load unpacked**, then select the folder printed by
   `/path/to/morrow-v1.0.0-rc.0-darwin-arm64-mcp/bin/morrow connector-path`.
4. Open Morrow Bridge, select **Connect Morrow**, allow the connection, then open a
   signed-in Canvas or Moodle course and follow the course connection action shown
   in that historical Bridge. Connect the course in **Plan** in Plan and Edit settings.

`bin/morrow doctor --json` reported whether the bundled MCP and its local bridge listener started. Until Morrow Bridge connects, `ready` stays `false`, and that does not confirm a course connection.

### Install from source for development

Requirements:

- Node.js 22.13 or newer;
- pnpm 10.6.1 through Corepack;
- Chrome 116 or newer;
- one MCP-compatible client.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run setup
```

`pnpm run setup` builds the workspace and writes a private local `morrow.upstreams.json` with absolute paths. It prints the unpacked extension directory.

Morrow Bridge is not installed from the Chrome Web Store. Open
`chrome://extensions`, turn on **Developer mode**, select **Load unpacked**, and
choose the `connector/extension` folder. Your organization must allow this.
If managed Chrome blocks Developer mode or this extension, Morrow cannot
connect through that browser. Do not bypass your organization's restrictions.

To build a ZIP of the extension:

```bash
pnpm package:connector
```

Extract `artifacts/connector/morrow-canvas-connector-v1.0.5.zip`. Use **Load
unpacked** to select the extracted folder that contains `manifest.json`, not the
ZIP file. Keep that folder in place while the extension is installed.

Bridge 1.0.5 is the current release. Update the desktop app and Bridge together, reload the unpacked extension, then reconnect them. An older Bridge does not carry the complete 1.0 operation set.

Configure Morrow in any of these clients. Compatible clients on the same computer share one Morrow runtime and Chrome Bridge connection. Keep their Morrow configuration consistent. Avoid competing edits to the same course content:

```bash
pnpm morrow mcp install codex --scope project --upstreams "$PWD/morrow.upstreams.json"
pnpm morrow mcp install claude --scope project --upstreams "$PWD/morrow.upstreams.json"
pnpm morrow mcp install claude-desktop --scope user --upstreams "$PWD/morrow.upstreams.json"
pnpm morrow mcp install gemini --scope project --upstreams "$PWD/morrow.upstreams.json"
# ChatGPT desktop shares the user Codex configuration on this computer.
pnpm morrow mcp install codex --scope user --upstreams "$PWD/morrow.upstreams.json"
```

The aliases `claude` and `gemini` select Claude Code and Gemini CLI. Claude desktop chat supports user scope on macOS and Windows.

The generated client files are:

- Codex CLI or IDE: `.codex/config.toml` in the project, or `~/.codex/config.toml` for the user;
- ChatGPT desktop: the shared user configuration at `~/.codex/config.toml`;
- Claude Code: `.mcp.json` or `~/.claude.json`;
- Claude desktop chat: `claude_desktop_config.json`;
- Gemini CLI: `.gemini/settings.json`.

Restart the selected client after configuration. The client then starts Morrow over stdio. The Morrow MCP starts its internal Chrome connector runtime. The Chrome extension connects to that runtime at `127.0.0.1:32147`.

#### ChatGPT desktop local MCP

The current ChatGPT desktop app shares its Codex MCP configuration with Codex CLI and the IDE extension on the same computer. After the user-scope command above, restart ChatGPT desktop. You can also inspect or manage the entry in **Settings → MCP servers**. This setup writes configuration only; it does not open ChatGPT desktop or prove a Morrow course connection.

ChatGPT web does not read local `.codex/config.toml`. It uses remote MCP-backed tools supplied by plugins instead. A managed device can disable local MCP servers or the desktop app. Morrow does not bypass that policy. See OpenAI's [MCP documentation](https://learn.chatgpt.com/docs/extend/mcp).

For Codex write requests, use the interactive client so you can answer its tool-approval prompt. **Allow** lets Codex prepare the Morrow request. Review and approve the exact change in Morrow before it is sent to the LMS. With write approval enabled, noninteractive `codex exec` cannot answer that prompt and can cancel the call before it reaches Morrow.

## Native Morrow tools

Use these tools to inspect and control the layer:

- `morrow_health` reports the profile, catalog, local operation journal, batch ledger, connector process, and current browser connection.
- `morrow_catalog`, `morrow_catalog_search`, and `morrow_capability_get` provide bounded discovery across the full surface.
- `morrow_canvas_connector_health` reports the local connector transport.
- `morrow_canvas_bindings` lists bounded, non-secret Canvas session bindings.
- `morrow_plan_page_correction` prepares one exact text change on a Canvas page. The review shows the course, page, current text, and replacement. The bridge preserves the surrounding page and checks the saved page and its revision history.
- `morrow_operation_*` tools inspect, dispatch, cancel, reconcile, verify, and create separate corrective operations.
- `morrow_batch_*` tools create, inspect, run, pause, recover, reconcile, cancel, and page durable batches.
- `morrow_result_page` retrieves bounded pages for large local results.

Provider operations use generated `canvas_*` names. A call to a read tool executes. A call to a write tool creates a plan.

For example, ask your assistant: “On the Cell structure page in Introduction to Human Biology, change ‘Cells have membranes.’ to ‘Cells have protective membranes.’ Keep everything else.” Morrow reads the current page before it creates the review. **Change this text** starts the work and shows the result on that page. It checks for newer edits before sending. It reports a checked result only when the saved page and one new revision match the approved change.

This page workflow changes a unique phrase within one text section. It does not support block-editor pages, text split across HTML tags, or an automatic undo. Canvas does not lock the page during these checks. Avoid editing it until the result is checked. A selected live Canvas test confirmed the exact phrase change and unchanged page settings. A stale proposal failed before send, and a fresh read confirmed no later effect. See the [BT2 proof record](docs/implementation/BT2-LIVE-PROOF.md) for the tested scope.

## Verification

Run the complete local campaign:

```bash
pnpm catalog:export
pnpm catalog:merge
pnpm catalog:check
pnpm build
pnpm --dir installer --ignore-workspace install
pnpm test
pnpm test:connector
pnpm test:package
pnpm package:connector
pnpm package:connector:check
pnpm morrow doctor --json
pnpm morrow catalog stats --json
```

`pnpm test` ends with the desktop installer suites. The installer pins its own Electron toolchain, so it stays outside the pnpm workspace and installs with the command above.

The Canvas browser campaign uses Chrome for Testing with a temporary profile and a synthetic Canvas site. It validates extension pairing, site-scoped permission, account binding, Canvas reads and writes, a nested New Quiz request, fresh checks, replay refusal, restart, and disconnect revocation.

See [ARCHITECTURE.md](ARCHITECTURE.md), [LIMITATIONS.md](LIMITATIONS.md), and [SOURCE-ORIGIN.md](SOURCE-ORIGIN.md).

## Release status

The release checkout uses `1.0.2`. The public `v1.0.2` release provides unsigned macOS Apple silicon and Windows x64 installers from the [Morrow downloads repository](https://github.com/bradenriggins/morrow-downloads/releases/tag/v1.0.2). Local private and public-candidate source archives are deterministic and include checksums, a stage manifest, and a CycloneDX SBOM. These distribution records do not change the local runtime architecture.
