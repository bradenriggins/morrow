# Accessibility and compliance guidance

This guide supports careful course work. It is not legal advice, a certification,
or a claim that Morrow or a course complies with every law. The applicable
jurisdiction, institution type, contracts, learner population, and current
institution policy determine obligations. For a legal conclusion, consult the
institution's qualified owner and current authoritative sources.

## Accessibility review

Use the institution's required standard and target level. WCAG 2.2 is a useful
technical reference, but do not silently replace a policy that names a different
version. Check meaningful heading order, text alternatives, captions and
transcripts, keyboard access, focus visibility, descriptive links, color
contrast, reflow, error instructions, and accessible documents. Include embedded
media, third-party tools, and the submission route, not only page HTML.

Automated checks find some defects; manual and assistive-technology evaluation
are needed for broader assurance. Record which criteria and surfaces were
checked. Never label a course “WCAG compliant” from a scan or one repaired image.
Do not invent alt text from filenames. Decorative images should not burden
screen readers. Complex diagrams need an equivalent explanation of their
instructional meaning. Captions need accuracy review, not just existence.

## Use the shipped Canvas checker first

The package includes [catalog/a11y](../catalog/a11y/README.md). Its Canvas
parity detector ports the 13 rules of Instructure's `tinymce-a11y-checker`,
pinned at `1c9f0bb8013ed69c4f2efe11fd483025469b7e6c`. Use those signals as the
baseline for Canvas content. Report the separate Morrow extended-rule findings
as additional checks. Do not mix their rule counts or present them as Canvas
checker results.

For a supported item, run `bin/morrow audit --target-kind canvas_page
--course-id COURSE_ID --target-ids '{"page_url":"PAGE_URL"}' --format human`
with actual identifiers from a fresh read. The read-only runner is wired for
Canvas pages, assignment descriptions, New Quiz instructions, and New Quiz
item content. Use `python3 catalog/a11y/runner.py list-targets` for the current
inventory. Metadata for other target types does not make them callable.
Moodle, rubric, discussion, classic quiz, syllabus, and file audits are not
wired into this runner and must not be promised.

Record source coverage and each detector's availability. Contrast checks use
inline styles and approximations; they do not measure a rendered page's full
computed styles. Python HTML parsing and string-length handling can differ
from the browser checker. Muse cannot supply the runner's Bridge render
evidence. These findings are limited HTML signals, not exact browser parity
or a conformance result. Follow with saved-page rendering, keyboard review,
and relevant manual checks.

Image-alt planners create plans and stop. They do not authorize or execute a
repair. The package's repair execution entry list is empty. Do not claim
“fixed” from a plan, change text that depends on the image's meaning without
evidence, or promise automatic bulk repairs.

## Student privacy

FERPA guidance concerns disclosure and use of education records; installing a
connector or replacing names with labels does not establish compliance.
Institution approval, vendor arrangements, authorized purpose, access control,
and retention remain relevant. Use minimum necessary information and the
supported privacy boundary. Stable labels, small cohorts, free text, and
educator-entered names can allow re-identification. See [privacy limits](privacy-ferpa.md).
Never call pseudonymization irreversible anonymization.

Do not claim a school's use falls under an exception without the governing
facts. Do not assume consent for one purpose authorizes training, external
sharing, or unrelated analysis. Check actual Muse data handling and institution
approval before making privacy promises. Platform egress inspection is disclosed
in [installation](../INSTALL.md); Morrow cannot hide traffic from that platform.

## Other compliance questions

Separate copyright/license permissions, accessibility duties, records retention,
accommodations, academic-integrity process, and accreditation requirements.
Use institution policy as the source for deadlines, approved language, and
processes. Cite current primary sources for jurisdiction-specific advice.
Do not copy licensed textbooks into a course, remove attribution, bypass an
LTI entitlement, or publish protected student work because a link is readable.

Ask only for material facts: jurisdiction, applicable institution policy,
intended audience, or whether the policy permits the proposed use. Give a
usable checklist or draft with unresolved conditions plainly stated. Do not
invent compliance seals, legal deadlines, or accreditation guarantees.

Primary references checked 2026-09-30:
- [W3C WCAG 2.2](https://www.w3.org/TR/WCAG22/)
- [W3C Understanding WCAG 2.2](https://www.w3.org/WAI/WCAG22/understanding/)
- [U.S. Department of Education: privacy and education technology](https://studentprivacy.ed.gov/privacy-and-education-technology)
- [FERPA responsibilities of service providers](https://studentprivacy.ed.gov/resources/responsibilities-third-party-service-providers-under-ferpa)
Refresh applicable requirements before a consequential legal or policy decision.
