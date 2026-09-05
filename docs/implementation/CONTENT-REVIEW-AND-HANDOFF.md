# Content review and tool handoff

## Product rule

Users ask for outcomes in their chosen AI app. Morrow supplies learning-platform
content and controlled changes. The app coordinates the user's other tools.
Do not require users to learn a separate chat interface or a second document
system.

## One review structure

Use the same structure for Canvas, Moodle, and Blackboard:

1. State the requested outcome and the total number of changes.
2. Name the affected course and item from a fresh read.
3. Show additions, edits, and removals as distinct actions.
4. Show the proposed content and settings. Show current values when available.
5. Keep consequences visible, including removals and student or grade changes.
6. Approve the exact saved request. Report execution separately from verification.

A large request is a list of items, not a stack of full-size forms. The current
list shows ten items at a time and supports title/course search. Each item opens
its complete preview. Original sequence numbers remain visible. Search does not
change approval scope. The approval action names the full count. A removal
warning remains visible when the affected item is filtered out.

## Content families

| Content | Current display | Limits that must remain explicit |
| --- | --- | --- |
| Pages, lessons, assignment instructions, discussions, announcements, quiz instructions | Formatted HTML: headings, paragraphs, lists, tables, emphasis, quotations, code, and embedded raster image data | Not an exact copy of the LMS renderer. External media and embedded tools do not run. |
| New Quiz questions | Question text, points, choices, proposed key, and feedback; local practice for complete choice, multiple-answer, and true/false settings | Practice compares with the proposed key. It does not establish educational correctness or calculate an LMS grade. Other types retain their proposed settings. |
| Dates and availability | Named values; recognized ISO timestamps include the local time zone; false, zero, null, and blank remain distinct | Do not invent a previous value or assume all providers use the same date format. |
| Rubrics and other repeated records | Labeled tables for compact object arrays; nested lists and fields for more complex structures | This is a structured review, not a simulation of an LMS grading interface. |
| Modules and ordered items | Proposed names, sequence numbers, and settings | Sequence in a change list is execution order, not a claim about the final module layout. |
| Files | Resolved file name and requested metadata; explicit removal wording | No universal PDF, Office, video, or authenticated-file viewer is implemented. |
| Grades, enrollments, permissions, linked-course changes | Named proposed fields and available risk warnings | A rich content preview must not stand in for an exact student, score, permission, or downstream-target review. |
| Unknown fields and future content | Labeled values, nested records, and lists | Preserve the values. Do not silently omit an unsupported structure or label it as visually verified. |

Current/proposed content is available for the implemented page, assignment,
discussion, Moodle summary, and Blackboard document field mappings when their
fresh reads return those fields. Other edits say that current values are not
available. A small page correction retains its exact current/replacement text.
This is not a general before/after diff engine.

Readable target resolution now includes course favorites, assignments, pages,
New Quizzes, questions, modules, module items, course discussions, files, and
selected rubric operations. Required recognized target references block approval
when names cannot be resolved. Not every catalog target family has a name
resolver. Do not claim every catalog operation has passed human-review QA.

## Preview safety

The HTML renderer sanitizes content before it enters the review document. It
removes scripts, forms, navigation, custom styles, control IDs, and external
resource loading. The exact original request remains separate and unchanged.
Practice controls change only local page state. They cannot approve or dispatch
an operation. The existing approval nonce, origin checks, frozen plan, and
provider readback remain in force.

## Example: Week 4 study guide and email

1. Resolve the named course and Week 4 module. Read the needed items, not just
   their titles. Retain source links. Identify missing or unreadable material.
2. Let the host use its installed document and PDF tools. Inspect the final file
   for content, formatting, and the correct source coverage.
3. Use the user's approved writing preferences or examples for the message.
   Resolve the named recipient with the host's contacts or email tools.
4. Check the recipient, message, and final attachment. Follow the user's request
   and the host's send permissions. LMS approval does not approve an email.
5. Verify the email provider's sent result. Check an uncertain send before retrying.

Morrow sends this guidance in MCP server instructions. These are client hints,
not commands that force a host to use a skill. Existing tools retain their own
credentials and permission boundaries. No custom PDF editor, email sender, or
cross-plugin credential store is added.

The MCP host owns coordination across its connections. Server instructions are
advisory. See the [MCP architecture](https://modelcontextprotocol.io/specification/2025-11-25/architecture/index)
and [initialization schema](https://modelcontextprotocol.io/specification/2025-11-25/schema).

## Evidence and remaining checks

The browser harness exercises a 40-question review, search, pagination, local
question practice, a mixed Canvas/Moodle/Blackboard content review, hidden-removal
warnings, unsafe HTML, and refusal of an unnamed file deletion. These use
synthetic data and real Morrow rendering. They are not live LMS compatibility
claims. The list pagination is client-side; this does not prove browser
performance for ten thousand rich-content items.

The full study-guide-to-email workflow still requires an end-to-end test in each
supported host with its actual document and email tools. No email was sent as
part of this implementation. The user's example is a product requirement, not a
request to contact the named person.
