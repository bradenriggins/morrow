#!/usr/bin/env python3
"""Selftest: a11y signal detector and repair planner guards.

No live network calls, no Canvas contact, no browser tasks. All HTML below
is synthetic fixture data exercising the detector; no fixture touches New
Quiz 506477.

Covers:
  1.  All 18 saved-source signals fire on one fixture document with the
      expected indexes.
  2.  Per-signal entry limit (100): 150 missing-alt images return 100 with
      status evidence_incomplete and a truncated_signals entry.
  3.  Honesty standard: interpretation text present; render_evidence is
      unavailable (no Bridge sandbox on this VM).
  4.  Repair planner accepts a good page plan (digests and offsets only,
      never the body or image URL).
  5.  Planner refusals: stale_body, image_source_mismatch,
      image_position_shifted, ambiguous_image, decorative_needs_empty_alt,
      alt_text_required, bad_image_index, protected_quiz (506477),
      unsupported_question_type, question_group_refused,
      decorative_not_allowed, stale_item_snapshot, unknown_planner_kind.
  6.  All eleven manifests are valid JSON with the required manifest keys
      and live-unverified evidence status.
  7.  The new module sources contain no temp-directory path references.
"""

import glob
import hashlib
import json
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
A11Y = os.path.join(REPO, "catalog", "a11y")
for _p in (REPO, A11Y):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import importlib.util as _ilu  # noqa: E402


def _load(name, path):
    spec = _ilu.spec_from_file_location(name, path)
    mod = _ilu.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


signals = _load("morrow_a11y_signals_selftest", os.path.join(A11Y, "a11y_signals.py"))
repair = _load("morrow_a11y_repair_selftest", os.path.join(A11Y, "a11y_repair.py"))

PASS = []
FAIL = []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(
        "%s%s" % (name, (" (%s)" % detail) if detail and not cond else ""))


def expect(name, code, fn, detail=""):
    try:
        fn()
    except repair.RepairPlanRefused as exc:
        check(name, exc.code == code,
              "%sexpected code %r, got %r" % (detail + " " if detail else "", code, exc.code))
        return
    except Exception as exc:  # noqa: BLE001
        check(name, False, "%swrong exception: %r" % (detail + " " if detail else "", exc))
        return
    check(name, False, "%sno refusal raised" % (detail + " " if detail else ""))


def sha256_text(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- fixture
FIXTURE_HTML = (
    '<img src="https://cdn.example/a.png">'
    '<img src="https://cdn.example/b.png" alt="logo" role="presentation">'
    "<h1>Welcome</h1><h3>Details</h3><h2></h2>"
    "<table><tr><td>cell</td></tr></table>"
    "<table><caption>Cap</caption><tr><th>Name</th></tr></table>"
    "<table><tr><td>oops</td></tr>"
    '<iframe src="https://player.example/v"></iframe>'
    '<video src="https://cdn.example/v.mp4" autoplay></video>'
    '<a href="https://example.com"></a>'
    '<a href="https://example.com/x">https://example.com/x</a>'
    '<a href="https://example.com/y">click here</a>'
    '<button aria-hidden="true">Go</button>'
    '<div style="width: 600px">wide</div>'
    "<font>old</font>"
)

result = signals.scan_html(FIXTURE_HTML)
sig = result["observed_source_signals"]

# 1. All 18 signals fire with expected indexes.
check("signal: image_tags_without_alt",
      sig["image_tags_without_alt"] == [
          {"image_index": 1, "image_src_sha256": sha256_text("https://cdn.example/a.png")}])
check("signal: images_marked_decorative_with_alt_text",
      sig["images_marked_decorative_with_alt_text"] == [{"image_index": 2}])
check("signal: heading_level_jumps",
      sig["heading_level_jumps"] == [
          {"heading_index": 2, "from_level": 1, "to_level": 3}])
check("signal: empty_headings",
      sig["empty_headings"] == [{"heading_index": 3, "level": 2}])
check("signal: tables_without_th", sig["tables_without_th"] == [1, 3])
check("signal: tables_without_caption", sig["tables_without_caption"] == [1, 3])
check("signal: table_headers_without_scope",
      sig["table_headers_without_scope"] == [{"table_index": 2, "header_index": 1}])
check("signal: unclosed_tables", sig["unclosed_tables"] == [3])
check("signal: embedded_media_tags", sig["embedded_media_tags"] == [1, 2])
check("signal: media_without_caption_track",
      sig["media_without_caption_track"] == [{"media_index": 1, "tag": "video"}])
check("signal: autoplay_media",
      sig["autoplay_media"] == [{"media_index": 1, "tag": "video"}])
check("signal: links_without_text", sig["links_without_text"] == [{"link_index": 1}])
check("signal: links_with_url_text", sig["links_with_url_text"] == [{"link_index": 2}])
check("signal: links_with_generic_text", sig["links_with_generic_text"] == [{"link_index": 3}])
check("signal: iframes_without_title", sig["iframes_without_title"] == [1])
check("signal: aria_hidden_on_focusable",
      sig["aria_hidden_on_focusable"] == [{"focusable_index": 4, "tag": "button"}])
check("signal: fixed_pixel_widths",
      sig["fixed_pixel_widths"] == [{"element_index": sig["fixed_pixel_widths"][0]["element_index"],
                                     "tag": "div", "width_px": 600}]
      if sig["fixed_pixel_widths"] else False)
check("signal: font_tags", len(sig["font_tags"]) == 1)
check("signal: all 18 names present",
      sorted(sig.keys()) == sorted(signals.SOURCE_SIGNAL_NAMES))

# 2. Truncation semantics.
big = "".join('<img src="https://cdn.example/i%d.png">' % n for n in range(150))
big_result = signals.scan_html(big)
big_sig = big_result["observed_source_signals"]["image_tags_without_alt"]
limits = big_result["source_signal_limits"]
check("truncation: 100 returned of 150", len(big_sig) == 100)
check("truncation: status evidence_incomplete", limits["status"] == "evidence_incomplete")
check("truncation: truncated_signals entry",
      limits["truncated_signals"] == [
          {"signal": "image_tags_without_alt", "returned_count": 100, "total_count": 150}])
check("truncation: reason present", "reason" in limits)
check("no truncation on fixture: status observed",
      result["source_signal_limits"]["status"] == "observed")

# 3. Honesty standard.
check("honesty: interpretation present and not-a-violation",
      "not a violation" in result["interpretation"] and "conformance" in result["interpretation"])
check("honesty: render_evidence unavailable",
      result["render_evidence"]["status"] == "unavailable")
check("honesty: media metadata manual review",
      result["media_metadata"]["status"] == "manual_review_required"
      and "manual review" in result["media_metadata"]["reason"].lower()
      or result["media_metadata"]["status"] == "manual_review_required")

# ---------------------------------------------------------------- planner
BODY = '<p>Hi <img src="https://cdn.example/a.png"></p>'
BODY_DIGEST = sha256_text(BODY)
MISSING = signals.scan_html(BODY)["observed_source_signals"]["image_tags_without_alt"]
SRC_SHA = sha256_text("https://cdn.example/a.png")
check("fixture: one missing-alt image", len(MISSING) == 1 and MISSING[0]["image_index"] == 1)


def good_params(**over):
    p = {"course_id": "89585", "page_url": "welcome",
         "expected_body_sha256": BODY_DIGEST, "image_index": 1,
         "image_src_sha256": SRC_SHA, "alt_text": "A red apple", "decorative": False}
    p.update(over)
    return p


def good_evidence(**over):
    e = {"body_sha256": BODY_DIGEST, "missing_alt": MISSING}
    e.update(over)
    return e


# 4. A good page plan validates; the plan carries digests/offsets only.
plan = repair.validate_repair_plan("page", good_params(), good_evidence())
check("planner: good page plan validates", plan["planner"] == "morrow_plan_page_image_alt_repair")
check("planner: plan carries no body text or image URL",
      not any(k == "body" or "body_text" in k for k in plan.keys())
      and not any("cdn.example" in str(v) for v in plan.values()))
check("planner: write contract one dispatch",
      plan["write_contract"] == "one_dispatch_exact_readback" and plan["post_write"] == "re_audit_same_target")

# 5. Refusals.
expect("refusal: stale_body", "stale_body",
       lambda: repair.validate_repair_plan(
           "page", good_params(expected_body_sha256="0" * 64), good_evidence()))
expect("refusal: image_source_mismatch", "image_source_mismatch",
       lambda: repair.validate_repair_plan(
           "page", good_params(image_src_sha256="1" * 64), good_evidence()))
expect("refusal: image_position_shifted", "image_position_shifted",
       lambda: repair.validate_repair_plan("page", good_params(image_index=2), good_evidence()))
expect("refusal: bad_image_index", "bad_image_index",
       lambda: repair.validate_repair_plan("page", good_params(image_index=0), good_evidence()))
expect("refusal: decorative_needs_empty_alt", "decorative_needs_empty_alt",
       lambda: repair.validate_repair_plan(
           "page", good_params(decorative=True, alt_text="x"), good_evidence()))
expect("refusal: alt_text_required", "alt_text_required",
       lambda: repair.validate_repair_plan(
           "page", good_params(decorative=False, alt_text="   "), good_evidence()))
expect("refusal: protected_quiz 506477", "protected_quiz",
       lambda: repair.validate_repair_plan(
           "new_quiz_item", good_params(quiz_id="506477", item_id="42"), good_evidence()))
expect("refusal: unknown_planner_kind", "unknown_planner_kind",
       lambda: repair.validate_repair_plan("nope", good_params(), good_evidence()))
expect("refusal: unsupported_question_type", "unsupported_question_type",
       lambda: repair.validate_repair_plan(
           "classic_quiz_question",
           good_params(quiz_id="7", question_id="9"),
           good_evidence(question_type="fill_in_multiple_blanks_question",
                         question_read_complete=True)))
expect("refusal: question_group_refused", "question_group_refused",
       lambda: repair.validate_repair_plan(
           "classic_quiz_question",
           good_params(quiz_id="7", question_id="9"),
           good_evidence(question_type="multiple_choice_question",
                         quiz_group_id="3", question_read_complete=True)))
expect("refusal: incomplete_question_read", "incomplete_question_read",
       lambda: repair.validate_repair_plan(
           "classic_quiz_question",
           good_params(quiz_id="7", question_id="9"),
           good_evidence(question_type="essay_question", question_read_complete=False)))
expect("refusal: decorative_not_allowed (item bank)", "decorative_not_allowed",
       lambda: repair.validate_repair_plan(
           "item_bank_question",
           good_params(bank_id="5", bank_entry_id="6", item_id="42",
                       item_sha256="a" * 64, bank_sha256="b" * 64,
                       decorative=True, alt_text=""),
           good_evidence(item_sha256="a" * 64, bank_sha256="b" * 64)))
expect("refusal: stale_item_snapshot", "stale_item_snapshot",
       lambda: repair.validate_repair_plan(
           "item_bank_question",
           good_params(bank_id="5", bank_entry_id="6", item_id="42",
                       item_sha256="a" * 64, bank_sha256="b" * 64),
           good_evidence(item_sha256="c" * 64, bank_sha256="b" * 64)))
expect("refusal: unsupported_entry_type (stimulus)", "unsupported_entry_type",
       lambda: repair.validate_repair_plan(
           "new_quiz_item", good_params(quiz_id="7", item_id="42"),
           good_evidence(entry_type="Stimulus")))

# Ambiguous image: same src twice.
dup_body = ('<img src="https://cdn.example/a.png">'
            '<img src="https://cdn.example/a.png">')
dup_missing = signals.scan_html(dup_body)["observed_source_signals"]["image_tags_without_alt"]
expect("refusal: ambiguous_image", "ambiguous_image",
       lambda: repair.validate_repair_plan(
           "page", good_params(expected_body_sha256=sha256_text(dup_body),
                               image_src_sha256=SRC_SHA),
           good_evidence(body_sha256=sha256_text(dup_body), missing_alt=dup_missing)))

# A good classic quiz question plan and a good item bank plan validate.
qplan = repair.validate_repair_plan(
    "classic_quiz_question", good_params(quiz_id="7", question_id="9"),
    good_evidence(question_type="multiple_choice_question", question_read_complete=True))
check("planner: good classic quiz question plan", qplan["planner"] == "morrow_plan_classic_quiz_question_image_alt_repair")
ibplan = repair.validate_repair_plan(
    "item_bank_question",
    good_params(bank_id="5", bank_entry_id="6", item_id="42",
                item_sha256="a" * 64, bank_sha256="b" * 64),
    good_evidence(item_sha256="a" * 64, bank_sha256="b" * 64))
check("planner: good item bank plan", ibplan["planner"] == "morrow_plan_item_bank_question_image_alt_repair")

# 6. Manifests valid.
manifest_files = sorted(glob.glob(os.path.join(A11Y, "morrow_*.json")))
check("manifests: eleven files", len(manifest_files) == 11, "found %d" % len(manifest_files))
for path in manifest_files:
    name = os.path.basename(path)
    try:
        m = json.load(open(path, encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        check("manifest valid: " + name, False, repr(exc))
        continue
    check("manifest keys: " + name,
          all(k in m for k in ("manifest", "name", "params", "multi_step", "title", "description"))
          and m["manifest"] == "morrow.manifest.v0")
    check("manifest live-unverified: " + name, m.get("evidence_status") == "live-unverified")

# 7. No temp-directory path references in the new module sources. (The
# selftest proves its own offline behavior by running; it is excluded here
# the same way provision_selftest checks provision.py but not itself.)
_TMP = chr(47) + "tmp"
for src_name in ("a11y_signals.py", "a11y_repair.py", "build_repair_manifests.py"):
    with open(os.path.join(A11Y, src_name), encoding="utf-8") as fh:
        src = fh.read()
    check("no temp path in " + src_name, _TMP not in src)

# 8. WORKSTREAM 4: adversarial tokenizer inputs. The HTML tokenizer must
# return the full 18-signal shape (never raise, never return short) on
# empty, non-string, unicode, CJK, emoji, RTL, malformed, and pathological
# markup.
_ADVERSARIAL_HTML = [
    ("empty", ""),
    ("whitespace-only", "   \n\t  "),
    ("non-str-none", None),
    ("non-str-int", 42),
    ("unicode-accents", '<img src="x.png" alt="caf\u00e9 \u00e9l\u00e8ve">'),
    ("cjk", "<h1>\u65e5\u672c\u8a9e</h1><p>\u4e2d\u6587</p><img src=\"a.png\">"),
    ("smart-apostrophes", "<img src=\"x.png\" alt=\"it\u2019s Braden\u2019s\">"),
    ("hyphens", '<a href="#">state-of-the-art</a><img src="my-image-01.png">'),
    ("unclosed-table", "<table><tr><td>cell"),
    ("nested-unclosed", "<div><a href=\"x\">link<div><h1>h1"),
    ("script-junk", "<script>var x = '<img alt=bad>';</script>"
                    "<img src=\"ok.png\" alt=\"ok\">"),
    ("comment-junk", "<!-- <img src=\"no.png\"> --><img src=\"yes.png\" alt=\"yes\">"),
    ("emoji", "<img src=\"x.png\" alt=\"\U0001f600 rocket \U0001f680\">"),
    ("rtl-arabic", "<p>\u0645\u0631\u062d\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645</p><img src=\"x.png\">"),
    ("huge-alt", "<img src=\"x.png\" alt=\"" + "a" * 10000 + "\">"),
    ("svg-foreign", "<svg><foreignObject><img src=\"x.png\"></foreignObject></svg>"),
    ("malformed-attrs", "<img src=x.png alt=noquotes><a href=>empty</a>"),
    ("upper-tags", "<IMG SRC=\"x.png\" ALT=\"X\"><H2>head</H2>"),
]
for _label, _html in _ADVERSARIAL_HTML:
    try:
        _r = signals.scan_html(_html)
        _obs = _r["observed_source_signals"]
        check("adversarial tokenizer %s: 18 signals, no raise"
              % _label, len(_obs) == 18, "got %d" % len(_obs))
    except Exception as _exc:  # noqa: BLE001 - the point is it must not raise
        check("adversarial tokenizer %s: no raise" % _label, False,
              repr(_exc)[:120])

# Spot-check signal correctness on tricky inputs (not just shape).
_r = signals.scan_html("<h1>\u65e5\u672c\u8a9e</h1><img src=\"a.png\">")
check("adversarial tokenizer cjk: missing-alt fires once",
      len(_r["observed_source_signals"]["image_tags_without_alt"]) == 1)
_r = signals.scan_html("")
check("adversarial tokenizer empty: all 18 signal lists empty",
      all(v == [] for v in _r["observed_source_signals"].values()))

print("PASS: %d" % len(PASS))
for name in PASS:
    print("  ok", name)
if FAIL:
    print("FAIL: %d" % len(FAIL))
    for name in FAIL:
        print("  FAIL", name)
    sys.exit(1)
print("ALL A11Y SELFTESTS PASSED")
