#!/usr/bin/env python3
"""Selftest: Canvas parity rules + Morrow-extended augmented rules.

No live network calls, no Canvas contact, no browser tasks. All HTML below
is synthetic fixture data.

Covers:
  PARITY (canvas_parity_rules.check_html, 13 Canvas rules):
    1.  Pass/fail fixtures per rule, with edge cases AT the thresholds
        (alt 120/121 chars, heading 120/121 chars, scope values).
    2.  adjacent-links fires on the FIRST anchor (upstream test(elem)
        semantics: the rule test runs per element and fails the element
        whose nextElementSibling matches), including the text-node-between
        quirk and the element-between pass case.
    3.  Contrast bands: a 3.0-4.5 ratio fires small-text-contrast but not
        large-text-contrast; a < 3.0 ratio on large text fires
        large-text-contrast; large text never trips the small-text rule.
    4.  rule_ids always carries all 13 Canvas ids, even with zero findings.
    5.  Every parity finding carries source "canvas-parity".
  AUGMENTED (augmented_rules.check_html, 13 morrow- rules):
    6.  morrow-nq-item-image-alt / morrow-bank-item-image-alt fire with the
        quiz_id/item_id / bank_id/item_id context carried in the locator.
    7.  morrow-quiz-instructions-empty fires on whitespace-only
        instructions, passes on real text.
    8.  morrow-link-no-text / morrow-link-bare-url / morrow-link-generic-text
        fire appropriately; a descriptive link passes.
    9.  morrow-media-no-caption-track fires on <video> without a track and
        passes with <track kind="captions">; morrow-iframe-no-title fires;
        morrow-aria-hidden-focusable fires on <button aria-hidden="true">;
        morrow-decorative-image-with-alt fires on role="presentation" with
        alt; morrow-table-unclosed fires on an unclosed table.
    10. rule_ids always carries all 13 morrow- ids (the contract fix), even
        with zero findings.
    11. Every augmented finding carries source "morrow-extended".
  BOTH:
    12. Clean HTML produces zero findings in both engines.
    13. No finding locator in either engine contains a full URL.
    14. The two module sources contain no temp-directory path references.

Every finding is a signal for human review, never a conformance claim.
"""

import importlib.util as _ilu
import os
import sys

A11Y = os.path.dirname(os.path.abspath(__file__))
for _p in (A11Y,):
    if _p not in sys.path:
        sys.path.insert(0, _p)


def _load(name, path):
    spec = _ilu.spec_from_file_location(name, path)
    mod = _ilu.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


par = _load("morrow_canvas_parity_rules_selftest",
            os.path.join(A11Y, "canvas_parity_rules.py"))
aug = _load("morrow_augmented_rules_selftest",
            os.path.join(A11Y, "augmented_rules.py"))

PASS = []
FAIL = []
ALL_FINDINGS = []  # every finding from both engines, for the source/URL sweeps


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(
        "%s%s" % (name, (" (%s)" % detail) if detail and not cond else ""))


def parity(html):
    """Run the parity engine; accumulate findings for the global sweeps."""
    res = par.check_html(html)
    ALL_FINDINGS.extend(res["findings"])
    return res


def augmented(html, context=None):
    """Run the augmented engine; accumulate findings for the global sweeps."""
    res = aug.check_html(html, context)
    ALL_FINDINGS.extend(res["findings"])
    return res


def of_rule(findings, rule_id):
    return [f for f in findings if f["rule_id"] == rule_id]


def fired(findings, rule_id):
    return len(of_rule(findings, rule_id)) > 0


# ============================================================ PARITY ======
# rule_ids contract: all 13 ids, always.
res = parity("<p>clean</p>")
check("parity: rule_ids is all 13 Canvas ids",
      res["rule_ids"] == list(par.RULE_IDS),
      "got %r" % (res["rule_ids"],))
check("parity: engine tag", res["engine"] == "canvas-parity")
check("parity: upstream commit pinned",
      res["upstream_commit"] == "1c9f0bb8013ed69c4f2efe11fd483025469b7e6c")

# --- img-alt ---
res = parity('<img src="a.png">')
check("img-alt: missing alt fires", len(res["findings"]) == 1
      and res["findings"][0]["rule_id"] == "img-alt",
      "got %r" % ([f["rule_id"] for f in res["findings"]],))
check('img-alt: alt="" passes',
      parity('<img src="a.png" alt="">')["findings"] == [])
check('img-alt: alt="x" passes',
      parity('<img src="a.png" alt="x">')["findings"] == [])

# --- img-alt-filename ---
res = parity('<img src="a.png" alt="photo.jpg">')
check("img-alt-filename: alt=photo.jpg fires",
      len(res["findings"]) == 1 and res["findings"][0]["rule_id"] == "img-alt-filename",
      "got %r" % ([f["rule_id"] for f in res["findings"]],))
res = parity('<img src="a.png" alt="IMG_1234.PNG">')
check("img-alt-filename: alt=IMG_1234.PNG fires (case-insensitive)",
      len(res["findings"]) == 1 and res["findings"][0]["rule_id"] == "img-alt-filename")
check("img-alt-filename: descriptive alt passes",
      parity('<img src="a.png" alt="a photo of a cat">')["findings"] == [])
check('img-alt-filename: alt="" decorative passes',
      parity('<img src="a.png" alt="">')["findings"] == [])

# --- img-alt-length (threshold: > 120 fires) ---
res = parity('<img src="a.png" alt="%s">' % ("x" * 120,))
check("img-alt-length: exactly 120 chars passes", res["findings"] == [],
      "got %r" % ([f["rule_id"] for f in res["findings"]],))
res = parity('<img src="a.png" alt="%s">' % ("x" * 121,))
hits = of_rule(res["findings"], "img-alt-length")
check("img-alt-length: 121 chars fires",
      len(hits) == 1 and hits[0]["detail"]["alt_length"] == 121,
      "got %r" % (res["findings"],))

# --- table-caption ---
res = parity('<table><tr><th scope="col">H</th></tr></table>')
check("table-caption: no caption fires",
      len(of_rule(res["findings"], "table-caption")) == 1)
res = parity('<table><caption>   </caption><tr><th scope="col">H</th></tr></table>')
check("table-caption: whitespace-only caption fires",
      len(of_rule(res["findings"], "table-caption")) == 1)
res = parity('<table><caption>Sales</caption><tr><th scope="col">H</th></tr></table>')
check("table-caption: real caption passes", res["findings"] == [],
      "got %r" % ([f["rule_id"] for f in res["findings"]],))

# --- table-header ---
res = parity('<table><caption>C</caption><tr><td>x</td></tr></table>')
check("table-header: no th fires",
      len(of_rule(res["findings"], "table-header")) == 1)
res = parity('<table><caption>C</caption><tr><th scope="col">H</th></tr></table>')
check("table-header: th present passes", res["findings"] == [])

# --- table-header-scope ---
res = parity('<table><caption>C</caption><tr><th>H</th></tr></table>')
hits = of_rule(res["findings"], "table-header-scope")
check("table-header-scope: th without scope fires",
      len(hits) == 1 and hits[0]["detail"]["scope"] is None)
res = parity('<table><caption>C</caption><tr><th scope="col">H</th></tr></table>')
check('table-header-scope: scope="col" passes', res["findings"] == [])
res = parity('<table><caption>C</caption><tr><th scope="foo">H</th></tr></table>')
check('table-header-scope: scope="foo" fires',
      len(of_rule(res["findings"], "table-header-scope")) == 1)

# --- adjacent-links ---
res = parity('<a href="u">one</a><a href="u">two</a>')
hits = of_rule(res["findings"], "adjacent-links")
check("adjacent-links: same href fires exactly once", len(hits) == 1,
      "got %d" % len(hits))
check("adjacent-links: fires on the FIRST anchor (upstream test(elem) semantics)",
      len(hits) == 1 and hits[0]["element_index"] == 1,
      "got %r" % ([f["element_index"] for f in hits],))
res = parity('<a href="u1">one</a><a href="u2">two</a>')
check("adjacent-links: different hrefs pass", res["findings"] == [])
res = parity('<a href="u">one</a> and <a href="u">two</a>')
hits = of_rule(res["findings"], "adjacent-links")
check("adjacent-links: text node between anchors still fires (upstream quirk)",
      len(hits) == 1 and hits[0]["element_index"] == 1,
      "got %r" % ([f["element_index"] for f in hits],))
res = parity('<a href="u">one</a><span>x</span><a href="u">two</a>')
check("adjacent-links: element between anchors passes", res["findings"] == [])
res = parity('<a href="u">1</a><a href="u">2</a><a href="u">3</a>')
hits = of_rule(res["findings"], "adjacent-links")
check("adjacent-links: run of three fires on the first two anchors",
      [f["element_index"] for f in hits] == [1, 2],
      "got %r" % ([f["element_index"] for f in hits],))

# --- headings-sequence ---
res = parity("<h2>A</h2><h4>B</h4>")
hits = of_rule(res["findings"], "headings-sequence")
check("headings-sequence: h2 then h4 fires on the h4",
      len(hits) == 1 and hits[0]["element_index"] == 2
      and hits[0]["detail"]["prior_heading"] == "h2",
      "got %r" % (hits,))
check("headings-sequence: h2 then h3 passes",
      parity("<h2>A</h2><h3>B</h3>")["findings"] == [])
check("headings-sequence: first heading h4 alone passes (no prior)",
      parity("<h4>Alone</h4>")["findings"] == [])
res = parity("<h1>A</h1><h4>B</h4>")
hits = of_rule(res["findings"], "headings-sequence")
check("headings-sequence: h1 counts as prior, h4 still fires on skip",
      len(hits) == 1 and hits[0]["element_index"] == 2)
check("headings-sequence: the h1 also trips headings-start-at-h2",
      len(of_rule(res["findings"], "headings-start-at-h2")) == 1)

# --- paragraphs-for-headings (threshold: > 120 fires, raw length) ---
res = parity("<h2>%s</h2>" % ("x" * 120,))
check("paragraphs-for-headings: exactly 120 chars passes",
      of_rule(res["findings"], "paragraphs-for-headings") == [],
      "got %r" % ([f["rule_id"] for f in res["findings"]],))
res = parity("<h2>%s</h2>" % ("x" * 121,))
hits = of_rule(res["findings"], "paragraphs-for-headings")
check("paragraphs-for-headings: 121 chars fires",
      len(hits) == 1 and hits[0]["detail"]["heading_length"] == 121)

# --- list-structure ---
res = parity("<p>- item</p><p>- item2</p>")
hits = of_rule(res["findings"], "list-structure")
check("list-structure: dash run fires ONLY on the first p",
      len(hits) == 1 and hits[0]["element_index"] == 1,
      "got %r" % ([f["element_index"] for f in hits],))
res = parity("<p>1. foo</p>")
check("list-structure: '1. foo' fires",
      len(of_rule(res["findings"], "list-structure")) == 1)
check("list-structure: plain paragraph passes",
      parity("<p>hello</p>")["findings"] == [])

# --- headings-start-at-h2 ---
res = parity("<h1>Title</h1>")
check("headings-start-at-h2: any h1 fires",
      len(of_rule(res["findings"], "headings-start-at-h2")) == 1)
check("headings-start-at-h2: h2 passes",
      parity("<h2>Title</h2>")["findings"] == [])

# --- contrast rules ---
LOW_SMALL = '<p style="color:#777;background-color:#fff">text</p>'
res = parity(LOW_SMALL)
small = of_rule(res["findings"], "small-text-contrast")
large = of_rule(res["findings"], "large-text-contrast")
check("small-text-contrast: #777 on white fires (ratio < 4.5)",
      len(small) == 1 and small[0]["detail"]["ratio"] < 4.5,
      "got %r" % (res["findings"],))
check("small-text-contrast: contrast finding is approximate with a note",
      len(small) == 1 and small[0]["approximate"] is True
      and isinstance(small[0]["note"], str) and small[0]["note"])
check("contrast band: 3.0 <= ratio < 4.5 fires small but NOT large",
      len(small) == 1 and 3.0 <= small[0]["detail"]["ratio"] < 4.5
      and large == [],
      "ratio=%r large=%r" % (
          small[0]["detail"]["ratio"] if small else None, large))
check("small-text-contrast: black on white passes",
      parity("<p>text</p>")["findings"] == [])
res = parity('<p style="font-size:24px;color:#777;background-color:#fff">text</p>')
check("small-text-contrast: large text (>=24px) does NOT fire the small rule",
      of_rule(res["findings"], "small-text-contrast") == []
      and of_rule(res["findings"], "large-text-contrast") == [],
      "got %r" % ([f["rule_id"] for f in res["findings"]],))
res = parity('<p style="font-size:24px;color:#aaa;background-color:#fff">text</p>')
large = of_rule(res["findings"], "large-text-contrast")
check("large-text-contrast: ratio < 3.0 on 24px text fires",
      len(large) == 1 and large[0]["detail"]["ratio"] < 3.0,
      "got %r" % (res["findings"],))
check("large-text-contrast: large-text case does not fire the small rule",
      of_rule(res["findings"], "small-text-contrast") == [])

# ========================================================= AUGMENTED ======
# rule_ids contract: all 13 morrow- ids, always (the contract fix).
res = augmented("<p>clean</p>")
check("augmented: rule_ids is all 13 morrow- ids even with zero findings",
      res["rule_ids"] == list(aug.RULE_IDS),
      "got %r" % (res["rule_ids"],))
check("augmented: engine tag", res["engine"] == "morrow-augmented")
check("augmented: source tag", res["source"] == "morrow-extended")

# --- morrow-nq-item-image-alt ---
nq_ctx = {"target": "new_quiz_item", "quiz_id": "Q1", "item_id": "I1",
          "section": "stem"}
res = augmented('<p>See <img src="https://cdn.example/a.png"></p>', nq_ctx)
hits = of_rule(res["findings"], "morrow-nq-item-image-alt")
check("morrow-nq-item-image-alt: fires on item image without alt",
      len(hits) == 1,
      "got %r" % ([f["rule_id"] for f in res["findings"]],))
check("morrow-nq-item-image-alt: locator carries quiz_id and item_id",
      len(hits) == 1 and hits[0]["locator"].get("quiz_id") == "Q1"
      and hits[0]["locator"].get("item_id") == "I1",
      "got %r" % (hits[0]["locator"] if hits else None,))

# --- morrow-bank-item-image-alt ---
bank_ctx = {"target": "item_bank_item", "bank_id": "B1", "item_id": "I2"}
res = augmented('<img src="https://cdn.example/b.png">', bank_ctx)
hits = of_rule(res["findings"], "morrow-bank-item-image-alt")
check("morrow-bank-item-image-alt: fires on bank item image without alt",
      len(hits) == 1,
      "got %r" % ([f["rule_id"] for f in res["findings"]],))
check("morrow-bank-item-image-alt: locator carries bank_id and item_id",
      len(hits) == 1 and hits[0]["locator"].get("bank_id") == "B1"
      and hits[0]["locator"].get("item_id") == "I2",
      "got %r" % (hits[0]["locator"] if hits else None,))

# --- morrow-quiz-instructions-empty ---
ins_ctx = {"target": "quiz_instructions", "quiz_id": "Q9", "quiz_type": "new_quiz"}
res = augmented("   \n  ", ins_ctx)
check("morrow-quiz-instructions-empty: whitespace-only instructions fire",
      len(of_rule(res["findings"], "morrow-quiz-instructions-empty")) == 1)
res = augmented("Answer every question.", ins_ctx)
check("morrow-quiz-instructions-empty: real text passes",
      res["findings"] == [],
      "got %r" % ([f["rule_id"] for f in res["findings"]],))

# --- link rules ---
res = augmented('<a href="https://example.com/x"></a>')
check("morrow-link-no-text: empty link fires",
      len(of_rule(res["findings"], "morrow-link-no-text")) == 1)
res = augmented('<a href="https://example.com/x">https://example.com/x</a>')
hits = of_rule(res["findings"], "morrow-link-bare-url")
check("morrow-link-bare-url: bare URL link text fires", len(hits) == 1,
      "got %r" % ([f["rule_id"] for f in res["findings"]],))
res = augmented('<a href="https://example.com/y">click here</a>')
check("morrow-link-generic-text: 'click here' fires",
      len(of_rule(res["findings"], "morrow-link-generic-text")) == 1)
res = augmented('<a href="https://example.com/z">Read the course syllabus</a>')
check("morrow links: descriptive link passes all three link rules",
      res["findings"] == [],
      "got %r" % ([f["rule_id"] for f in res["findings"]],))

# --- morrow-media-no-caption-track ---
res = augmented('<video src="https://cdn.example/v.mp4"></video>')
hits = of_rule(res["findings"], "morrow-media-no-caption-track")
check("morrow-media-no-caption-track: <video> without track fires",
      len(hits) == 1 and hits[0]["locator"].get("element") == "video",
      "got %r" % ([f["rule_id"] for f in res["findings"]],))
res = augmented('<video src="https://cdn.example/v.mp4">'
                '<track kind="captions" src="https://cdn.example/c.vtt"></video>')
check("morrow-media-no-caption-track: <track kind=captions> passes",
      of_rule(res["findings"], "morrow-media-no-caption-track") == [],
      "got %r" % ([f["rule_id"] for f in res["findings"]],))

# --- morrow-iframe-no-title ---
res = augmented('<iframe src="https://player.example/v"></iframe>')
check("morrow-iframe-no-title: iframe without title fires",
      len(of_rule(res["findings"], "morrow-iframe-no-title")) == 1)
res = augmented('<iframe title="Campus map" src="https://player.example/v"></iframe>')
check("morrow-iframe-no-title: titled iframe passes",
      of_rule(res["findings"], "morrow-iframe-no-title") == [])

# --- morrow-aria-hidden-focusable ---
res = augmented('<button aria-hidden="true">Go</button>')
check("morrow-aria-hidden-focusable: <button aria-hidden=true> fires",
      len(of_rule(res["findings"], "morrow-aria-hidden-focusable")) == 1)

# --- morrow-decorative-image-with-alt ---
res = augmented('<img src="https://cdn.example/b.png" alt="logo" role="presentation">')
check('morrow-decorative-image-with-alt: role="presentation" with alt fires',
      len(of_rule(res["findings"], "morrow-decorative-image-with-alt")) == 1)

# --- morrow-table-unclosed ---
res = augmented("<table><tr><td>x</td></tr>")
check("morrow-table-unclosed: unclosed table fires",
      len(of_rule(res["findings"], "morrow-table-unclosed")) == 1)
res = augmented("<table><tr><td>x</td></tr></table>")
check("morrow-table-unclosed: closed table passes",
      of_rule(res["findings"], "morrow-table-unclosed") == [])

# --- clean HTML: zero findings in both engines ---
CLEAN = (
    "<h2>Week 1</h2>"
    '<p>Read the <a href="https://example.com/syllabus">course syllabus</a> '
    "before Friday.</p>"
    "<table><caption>Grades</caption>"
    '<tr><th scope="col">Name</th></tr></table>'
    '<img src="https://cdn.example/cat.png" alt="A tabby cat sleeping">'
)
res_p = parity(CLEAN)
check("clean HTML: parity engine reports zero findings",
      res_p["findings"] == [],
      "got %r" % ([f["rule_id"] for f in res_p["findings"]],))
res_a = augmented(CLEAN)
check("clean HTML: augmented engine reports zero findings",
      res_a["findings"] == [],
      "got %r" % ([f["rule_id"] for f in res_a["findings"]],))

# ===================================================== GLOBAL SWEEPS =====
# Every finding in both engines carries the right source tag.
bad_source = [f for f in ALL_FINDINGS
              if f.get("source") not in ("canvas-parity", "morrow-extended")]
check("sweep: every finding has a valid source tag",
      bad_source == [] and len(ALL_FINDINGS) > 0,
      "bad=%r total=%d" % (bad_source, len(ALL_FINDINGS)))

# No finding locator in either engine contains a full URL.
def _locator_text(finding):
    return str(finding.get("locator"))

leaky = [f for f in ALL_FINDINGS
         if "://" in _locator_text(f) or "example.com" in _locator_text(f)]
check("sweep: no locator contains a full URL", leaky == [],
      "leaky=%r" % ([_locator_text(f) for f in leaky],))

# The two module sources contain no temp-directory path references.
_TMP = chr(47) + "tmp"
for src_name in ("canvas_parity_rules.py", "augmented_rules.py"):
    with open(os.path.join(A11Y, src_name), encoding="utf-8") as fh:
        src = fh.read()
    check("no temp path in " + src_name, _TMP not in src)

# rule_ids are the documented 13 in each module.
check("parity: RULE_IDS has 13 entries", len(par.RULE_IDS) == 13)
check("augmented: RULE_IDS has 13 entries", len(aug.RULE_IDS) == 13)
check("augmented: all ids morrow-prefixed",
      all(i.startswith("morrow-") for i in aug.RULE_IDS))

# ============================================================ REPORT =====
print("PASS: %d" % len(PASS))
for name in PASS:
    print("  ok", name)
if FAIL:
    print("FAIL: %d" % len(FAIL))
    for name in FAIL:
        print("  FAIL", name)
    sys.exit(1)
print("ALL A11Y PARITY SELFTESTS PASSED")
