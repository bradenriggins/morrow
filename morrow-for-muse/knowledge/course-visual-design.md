# Visual quality for Canvas and Moodle content

Create content that is readable, purposeful, and native to the course. Inspect
existing pages and the institution's brand before making a template. Keep the
educator's design unless a redesign is requested. Do not add a remote framework,
script, font service, or tracking dependency to a course page.

## Page structure

Use the LMS title as the page's title and a logical heading hierarchy inside
its body. Use real headings, lists, paragraphs, and links. Avoid headings made
only from bold text or an image. Give a page one clear purpose; group long
material into sections with useful labels. Put the learner's next action near
the relevant instructions. Use consistent names across module items and pages.

Prefer a restrained palette, comfortable spacing, short readable line lengths,
and one repeatable callout style. Use emphasis sparingly. Never convey a status
only through color. Text contrast needs measurement; visual impression alone
is insufficient. Avoid tiny text, dense all-caps blocks, gratuitous animation,
and decorative icons that obscure instructional meaning.

## Safe LMS HTML

Use semantic HTML that the site's editor permits. Canvas and Moodle can filter
markup differently; never assume arbitrary CSS or JavaScript survives saving.
Avoid global CSS selectors, fixed widths, absolute positioning, and table-based
page layouts. Use a real table only for tabular data, with headers and a caption
where useful. Allow long labels and URLs to wrap. Keep media responsive without
removing meaningful aspect ratios. Do not embed credentials in any URL.

Use descriptive link text, not repeated “click here”. Prefer course-native
resource links when available. Keep file permissions and publication state
consistent with the intended audience. Explain an external destination and
provide an accessible alternative if an embed cannot be used by all learners.
Alt text conveys an image's instructional purpose; decorative images need
empty alt text. Do not invent a description of an image you have not inspected.

## A practical page pattern

Purpose → learning goals → required resources → task steps → submission and
success criteria → next step. Omit sections that add no value. Use the same
pattern across a module, while allowing different content lengths and tasks.
A homepage can orient the learner to where to start and where to get help;
it does not need a large banner to look professional.

## Verify the saved result

Fresh-read saved HTML and preserved fields after the authorized change. Inspect
rendered saved content on desktop and mobile when a safe authorized preview is
available. Check heading order, spacing, overflow, dark/theme behavior if the
site supports it, links, image loading, captions, keyboard navigation, and
learner visibility. Verify the saved object, not only the draft or API echo.
If rendered access is unavailable, give a preview artifact and explicitly state
that LMS rendering is not yet verified. Never call an API-only check beautiful
or accessible. Do not use a session helper to bypass a missing governed write.

See [accessibility and compliance](accessibility-and-compliance.md) for checks
and [audit evidence](audit-checklist.md) for readback discipline.
