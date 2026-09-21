# Morrow brand

Morrow connects an assistant to course work. People can review content, make specific edits, and check the saved result. The brand must make those tasks clear before it makes an impression.

## Audience and purpose

Write for instructors, instructional designers, accessibility specialists, and people who manage courses. They know their courses. They should not need to learn software architecture to use Morrow.

Lead with concrete work: update a page, correct a question, review a set of courses, choose which edits need approval, and check the result. Explain technical terms only at the point where someone needs them for setup or a decision. Never call Morrow an “AI app.”

The first screen must answer three questions: what Morrow does, how it helps with course work, and how to start. Every label must help someone understand a task, choose an action, or interpret a result. Do not add audience eyebrows, decorative proof labels, capture dates, repeated slogans, or filler captions.

## Visual identity

The September 6 revision replaces the prior serif, forest, cream, and terracotta direction. Use a clear sans serif, cool white surfaces, navy text, and cobalt actions. A small chartreuse accent connects the interface to the knot. Color serves hierarchy and state; it does not decorate every component.

| Role | Light | Dark |
| --- | --- | --- |
| Page | `#FCFDFF` | `#11192E` |
| Raised surface | `#FFFFFF` | `#1A2641` |
| Inset surface | `#EDF3FC` | `#0C1223` |
| Primary text | `#17213C` | `#F4F7FD` |
| Secondary text | `#465572` | `#D2DBEF` |
| Supporting text | `#53617B` | `#ADBDD8` |
| Border | `#D6DDEC` | `#41506D` |
| Control boundary | `#7F8CA8` | `#6B7A99` |
| Action | `#253FEA` | `#ADC0FF` |
| Action hover | `#1B2FA8` | `#C3D1FF` |
| Text on action | `#FFFFFF` | `#11192E` |
| Focus | `#253FEA` | `#ADC0FF` |
| Success | `#24684E` | `#A6D9B8` |
| Error | `#A32D42` | `#FFB2C0` |
| Small highlight | `#CBDC74` with navy text | Use only where it has a clear purpose |

The shared extension tokens are in `connector/extension/brand/theme.css`. Components use semantic tokens such as `--text`, `--accent`, `--success`, and `--danger`. A selected state needs a label or control state as well as color. Error text stays specific and calm.

Do not use serif display type, earth tones, parchment textures, decorative grids, gradient text, glowing dark panels, or repeated card grids. These choices do not fit this identity.

## Token contract

`connector/extension/brand/theme.css` is the only file that defines Morrow's colour, type, and control tokens. Every Morrow-owned surface loads it: the extension popup, the onboarding page, the settings page, the pairing pages the local bridge serves, and the review and result pages the approval server serves. A component stylesheet uses the tokens. It does not restate a hex value and it does not define a second palette.

`--page`, `--raised`, and `--sunken` are the surfaces, with the aliases `--paper`, `--surface`, and `--surface-sunken`. `--ink` (alias `--text`), `--text-secondary`, and `--text-subtle` are the text colours. `--border` draws dividers and card edges. `--control-border` draws the boundary of an input, a select, a checkbox, or a radio button, at the WCAG 1.4.11 non-text contrast minimum, because `--border` alone is only 1.34:1 against the page and fails that rule. `--action`, `--action-hover`, and `--on-action` (aliases `--accent`, `--accent-hover`, `--on-accent`) belong to controls. `--focus`, `--success`, `--danger`, and `--highlight` carry state. `--shadow` and the focus halo are the only translucent paint.

`--ink` is a text colour. No Morrow surface is painted with it, so the focus ring never sits on it.

Every button is at least 44 px high. `theme.css` sets `button { min-height: 44px }`, and no component stylesheet may set a smaller `min-height` or `height` on a button.

The focus ring is `2px solid var(--focus)` at `outline-offset: 3px`, above a 5 px halo of `--focus` at 20 % over the surface below. The halo fills the offset gap, so the ring must reach 3:1 against both the surface and the halo. These are the WCAG 2.x contrast ratios of the ring against each token:

| Focus ring against | Light | Dark |
| --- | --- | --- |
| `--page` | 6.93:1 | 9.78:1 |
| `--raised` | 7.05:1 | 8.42:1 |
| `--sunken` | 6.32:1 | 10.44:1 |
| halo over `--page` | 4.98:1 | 6.25:1 |
| halo over `--raised` | 5.06:1 | 5.33:1 |
| halo over `--sunken` | 4.59:1 | 6.81:1 |
| `--ink` | 2.26:1 | 1.66:1 |

Every combination a Morrow surface can produce is above 3:1. The `--ink` row is below it, which is why `--ink` stays a text colour: a focus ring drawn on an ink surface would not be identifiable.

Every input, select, checkbox, and radio button draws its boundary in `--control-border`, so WCAG 1.4.11 is met against the surface behind it, in both themes:

| Control boundary against | Light | Dark |
| --- | --- | --- |
| `--control-border` on `--page` | 3.32:1 | 4.05:1 |
| `--control-border` on `--raised` | 3.38:1 | 3.48:1 |
| `--control-border` on `--sunken` | 3.03:1 | 4.32:1 |

`prefers-reduced-transparency: reduce` removes the translucent paint, the shadow and the focus halo, and keeps each surface token at its own value. Flattening `--raised` and `--sunken` onto `--page` would take away the only boundary a borderless chip or step marker has.

`scripts/test/extension-theme-contract.test.mjs` recomputes this table from the tokens in `theme.css`, checks the 44 px floor and the reduced-transparency rule in the brand stylesheets, and fails when this document and the tokens disagree.

`theme.css` also carries the type, space, and radius scale. No Morrow surface uses a size outside it.

Seven type tokens, each a `font` shorthand (weight, size/line-height, family) so a rule can set `font: var(--text-ui);`. Every token carries `var(--font-sans)`, because the shorthand is invalid without a family; a role that needs tracking sets `letter-spacing` as a separate declaration.

| Token | Value | Use |
| --- | --- | --- |
| `--text-display` | `700 2rem/1.1 var(--font-sans)` (32 px) | One page title. Tracking `-0.02em`. |
| `--text-title` | `700 1.375rem/1.2 var(--font-sans)` (22 px) | Section heading. Tracking `-0.01em`. |
| `--text-heading` | `700 1.0625rem/1.3 var(--font-sans)` (17 px) | Card title, course name. |
| `--text-body` | `400 1rem/1.55 var(--font-sans)` (16 px) | Paragraphs, review content. |
| `--text-ui` | `400 0.875rem/1.45 var(--font-sans)` (14 px) | Rows, labels, controls. |
| `--text-ui-strong` | `600 0.875rem/1.45 var(--font-sans)` | An emphasised `--text-ui` row. |
| `--text-caption` | `400 0.8125rem/1.4 var(--font-sans)` (13 px) | Meta line, chips, help. |

Weight is exactly 400, 600, or 700. No text renders under 13 px, and no uppercase label carries tracking. The wordmark keeps its own weight.

Space tokens `--space-1` to `--space-7` are 4, 8, 12, 16, 24, 32, and 48 px. Radius tokens are `--radius-control: 10px`, `--radius-card: 14px`, `--radius-panel: 18px`, and `--radius-pill: 999px`; a radius inside a padded container equals the outer radius minus the padding, and never less than `--radius-control`. `--measure: 68ch` bounds a line of reading text.

A paragraph, a list item, and help text cap at `max-inline-size: var(--measure)`, so a wide panel never carries a line of reading text past a comfortable width. A heading uses `text-wrap: balance`; a paragraph uses `text-wrap: pretty`. Each surface's root sets `font-synthesis: none` and `-webkit-font-smoothing: antialiased`, so a variable font never synthesizes a weight it does not carry. A count or a clock time uses `font-variant-numeric: tabular-nums`, so digits do not shift width as they change. `::selection` paints `--highlight` behind `--ink` text.

`installer/renderer/styles.css` copies these token names and values without change, as `.better-web-ui.md` requires.

## Type, layout, and motion

Use **Manrope** for headings, body text, controls, and the live-text wordmark. Use weight 400 to 500 for reading, 600 to 700 for labels and actions, and 700 to 800 for display headings. Use monospaced text only for exact code or technical values.

Manrope is bundled locally with its SIL Open Font License. Source: [Google Fonts Manrope](https://github.com/google/fonts/tree/main/ofl/manrope). The unmodified variable font SHA-256 is `d0639be45d0af36e798172419d7bd173c4bd4f29e2b76cbb69db1d11bf8b0a40`.

Build hierarchy with type size, weight, alignment, and spacing. Keep headings short. Check their actual wraps at desktop, tablet, and phone sizes. Do not hide overflow or shrink body text to force a layout. A short desktop hero sentence should fit on one line; narrow screens may use deliberate complete phrases.

Use a 4 px spacing unit. Prefer 8, 12, 16, 24, 32, and 48 px gaps. Keep more space between groups than inside them. Controls need clear boundaries and visible keyboard focus. Keep touch targets at least 44 px high; the token contract states the rule for every surface that loads `theme.css`. For a checkbox or a radio button, the label row is the target, not the small square; a link inside a sentence is exempt, as WCAG 2.5.8 permits.

A link uses `--action` for its text and `--action-hover` on hover, with its underline thickness set from the font and a small offset. A disclosure (`<summary>`) drops the browser's own triangle for one chevron, drawn from a single SVG mask so every surface shows the same icon; it turns 90 degrees over 160 ms when the disclosure opens, and every disclosure row stays at least 44 px high.

Motion must clarify an interaction or introduce a useful section. Use brief opacity or position transitions. Respect reduced motion. Do not animate text, shift page layout, or repeat motion to attract attention.

Motion lives in five places and nowhere else: no motion on list filters, search, checkbox changes, or keyboard actions.

| Place | Purpose | Motion |
| --- | --- | --- |
| A course detail or a Customize area opens | Shows where content came from | Height and opacity, 180 ms, `cubic-bezier(0.2, 0, 0, 1)` |
| The result of a review, one time | The end of each task must feel complete | The success mark draws in 300 ms |
| The banner and the badge appear | Shows a state change | Opacity, 160 ms |
| A status line appears or goes | Prevents a jump | Opacity and 4 px, 160 ms, exit by the same edge |
| Button press | Feedback | `scale(0.98)`, 120 ms |

`theme.css` (copied into `installer/renderer/styles.css`) carries these as tokens: `--motion-fast` (120 ms), `--motion-standard` (160 ms), `--motion-panel` (180 ms), `--motion-complete` (300 ms), and `--ease-panel` (`cubic-bezier(0.2, 0, 0, 1)`). It also carries the reusable classes `.morrow-panel` (detail and Customize area opening), `.morrow-appear` (banner and badge), and `.morrow-status-line` (status line, exiting by the same edge it entered from). `prefers-reduced-motion: reduce` removes all five.

## Website conversation stage

The marketing hero uses five selectable, explicitly illustrative conversations: accessibility audit, build from materials, coordinate sections, curriculum review, and work from phone. The selected story must be readable before motion starts. It must distinguish an instructor request, Morrow's bounded review work, and a result or review state.

The first story is a selected 12-course accessibility audit and remediation review. It names Pages, Assignments, Discussions, Files, Classic Quizzes, New Quizzes, questions, answers, feedback, media, and Item Banks. It may show only limited saved-HTML signals. It must state that Files require document review and Item Banks need shared-bank association confirmation. A repair is always a selected preview until current authority, dispatch, saved-result verification, and a fresh audit prove otherwise.

The selector uses native buttons with tab semantics, visible focus, and arrow-key navigation. Revealing the messages one at a time is optional. It pauses offscreen and while the document is hidden, and it does not run with reduced motion. It must never gate the text: no message is hidden before the reveal starts, a conversation that stops part-way is shown in full after a short bounded wait, and choosing a conversation or moving focus or a pointer into the stage shows all of that conversation at once. Do not use an LMS screenshot, an abstract animation, an imitation dashboard, or a fake completion state as the hero.

## Course design

Morrow branding belongs to Morrow's interface and marketing. Course work follows the course's existing design unless the person requests a redesign. Inspect relevant course examples and make the smallest suitable edit. Preserve unrelated content, media, links, structure, terminology, and native settings. Apply this rule separately to every course in a batch.

New or explicitly redesigned course content must remain fluid within the learning platform. Never automatically add fixed widths, minimum widths, pixel-based maximum-width wrappers, or fixed-width tables. Do not use decorative solid top or side bars. Use typography, spacing, and useful content relationships to create hierarchy. Inspect the actual saved course at narrow and wide sizes.

## Voice

Use direct, useful course language. A short joke can acknowledge repetitive work. Never joke about a learner, an accessibility need, a failed check, or an error. Avoid a slogan when a concrete task would explain more.

The extension is **Morrow Bridge**. Keep technical package and tool identifiers stable. Use the product name in installation steps and visible interface text.

| Use | Avoid |
| --- | --- |
| “Review the page before sending it to Canvas.” | “Let Morrow work its magic.” |
| “Choose which edits can run without another approval.” | “Unlock autonomous workflows.” |
| “The page changed since this review. Review it again.” | “Stale request. Dispatch refused.” |
| “Canvas saved the change. Morrow checked the result.” | “Changes happen instantly everywhere.” |

Task-led writing follows [GOV.UK guidance on user needs](https://guidance.publishing.service.gov.uk/writing-to-gov-uk-standards/plan-manage-content/identify-user-needs/). This is a writing principle, not evidence that Morrow has been tested with all audience groups.

## Claims and screenshots

State capabilities at the level the evidence proves. Separate implemented work, live proof, and planned platform coverage. Do not invent time savings, customer outcomes, endorsements, complete accessibility conformance, or feature parity. Put material availability limits beside setup and platform coverage; do not turn the whole page into a verification report.

Use real product and LMS captures. The displayed content, controls, and surrounding claim must match the actual captured state. A rendered product settings page can show settings; it cannot prove a successful LMS change. A native Canvas authoring capture can show saved course design; it cannot prove that Morrow's bridge authored it.

Keep learner data out of marketing assets. Capture without the automation pointer. Do not paint out UI errors, substitute fake LMS chrome, or compose fabricated success states. A caption is useful only when it explains what the reader can learn from the image.

## Privacy claims

Privacy is a product reason, not a compliance label. The connector keeps Canvas passwords, cookies, CSRF values, session tokens, Item Bank tokens, raw pairing secrets, and Chrome tab IDs out of the AI client. The gateway can apply output policy to fields, record count, byte count, free text, artifacts, and AI-client admission. It scrubs nested provider errors and logs.

When a source policy permits learner tokens, Morrow uses stable opaque tokens scoped to the selected Canvas origin, account, course, principal, and profile. The separate learner-token vault is encrypted locally. These facts do not mean all course data stays local, that every identifier is tokenized, or that Morrow establishes a privacy or accessibility compliance outcome. State the course-text boundary plainly: course text can go to the chosen assistant when source policy permits it.

## Knot

Use `connector/extension/brand/morrow-knot.svg` and the identical website and video assets. The two elliptical ribbons preserve the generated logo concept. The production mark uses native SVG geometry with no background element. The blue ribbon is `#6884FF`; the chartreuse ribbon is `#CBDC74`. SHA-256: `4caa420507d236c37d95176ea869453ec296001fa6307963a0f001bbb416b07b`.

Place the knot directly on the surrounding surface. Do not add a tile, square, shadow, border, or radius behind it. Keep its proportions and clear space. Use a live-text “morrow” wordmark beside it. Browser extension icons use a transparent PNG rendered from this SVG.

The built-in Image Generation tool produced the visual concept. Its requested transparent export returned a painted checkerboard in an RGB file, so that export was rejected. The SVG is the production source. Earlier navy-square and checkerboard raster assets are historical exploration and must not appear in the current interface.
