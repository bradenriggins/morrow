#!/usr/bin/env python3
"""Saved-source accessibility signal detector for Morrow for Muse.

Port of the desktop Morrow ``htmlSignals`` routine
(``packages/mcp-server/src/course-audit.ts``) and the missing-alt evidence
helper (``packages/mcp-server/src/page-correction.ts``), re-expressed in
stdlib-only Python so the dispatch executor can run it on the VM with no
extra dependencies.

What this is
------------
A deterministic tokenizer over one saved HTML field. It returns 18 named
signal lists under ``observed_source_signals``. It performs no network
access, no browser contact, and no Canvas reads; the caller supplies the
already-read HTML string.

Honesty standard (non-negotiable, carried over from desktop)
-----------------------------------------------------------
Every list is a signal that needs human review, never a violation. Each list
stops at ``max_entries_per_signal`` and a truncated list is incomplete
evidence for that field, never a pass. No signal does not establish
accessibility or WCAG conformance, and no signal set here establishes
conformance. Saved-source evidence, rendered learner-view evidence, and
manual accessibility checks stay separate.

Parser note
-----------
Desktop uses htmlparser2. This port uses :mod:`html.parser` from the
standard library, which is a tolerant tokenizer with slightly different
implied-close behavior for malformed markup (for example, a table left open
mid-document is only reported at end-of-input here). For well-formed and
ordinary Canvas-saved HTML the signal indexes match; for pathological
markup the result is still a valid human-review signal, which is all this
routine ever claims to be.
"""

import hashlib
import re
from html.parser import HTMLParser

MAX_SOURCE_SIGNAL_ENTRIES = 100  # Mirrors desktop MAX_SOURCE_SIGNAL_ENTRIES.
MAX_MEDIA_METADATA = 100

SOURCE_SIGNAL_NAMES = (
    "image_tags_without_alt",
    "images_marked_decorative_with_alt_text",
    "heading_level_jumps",
    "empty_headings",
    "tables_without_th",
    "tables_without_caption",
    "table_headers_without_scope",
    "unclosed_tables",
    "embedded_media_tags",
    "media_without_caption_track",
    "autoplay_media",
    "links_without_text",
    "links_with_url_text",
    "links_with_generic_text",
    "iframes_without_title",
    "aria_hidden_on_focusable",
    "fixed_pixel_widths",
    "font_tags",
)

GENERIC_LINK_TEXT = {"click here", "here", "read more", "link"}
BARE_URL_LINK_TEXT = re.compile(r"^(?:https?://|www\.)\S+$", re.IGNORECASE)
NATIVELY_FOCUSABLE_TAGS = {"button", "input", "select", "textarea"}
FIXED_WIDTH_TAGS = {
    "address", "article", "aside", "blockquote", "div", "dd", "dl", "dt",
    "fieldset", "figcaption", "figure", "footer", "form",
    "h1", "h2", "h3", "h4", "h5", "h6", "header", "li", "main", "nav",
    "ol", "p", "pre", "section",
    "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
}
INLINE_PIXEL_WIDTH = re.compile(r"(?:^|[;\s])width\s*:\s*([0-9]+(?:\.[0-9]+)?)px", re.IGNORECASE)
HEADING_TAG = re.compile(r"^h[1-6]$")
MEDIA_TAGS = {"img", "audio", "video", "source", "track", "iframe", "object", "embed"}
EMBEDDED_MEDIA_TAGS = {"audio", "video", "iframe", "object", "embed"}

INTERPRETATION = (
    "These are finite source signals only. Every list is a signal that needs "
    "human review, not a violation. They do not prove or disprove WCAG "
    "conformance, and no signal set here establishes conformance."
)

RENDER_EVIDENCE_UNAVAILABLE = {
    "status": "unavailable",
    "reason": (
        "Morrow Desktop computes render_evidence in the Morrow Bridge sandbox "
        "(an isolated page with CSP default-src 'none'). Morrow for Muse has no "
        "Bridge/Electron loopback on the VM, so saved-source render evidence is "
        "unavailable. Saved-source signals only; focus order, accessible names, "
        "contrast, and learner-view checks stay manual."
    ),
}


def _sha256_text(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _collapse_text(value):
    return re.sub(r"\s+", " ", value).strip()


def _has_text(value):
    return isinstance(value, str) and value.strip() != ""


class _SignalParser(HTMLParser):
    """Single-pass tokenizer producing the 18 desktop signal lists."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.missing_alt_images = []          # [{image_index, image_src_sha256}]
        self.decorative_with_alt = []
        self.heading_jumps = []
        self.empty_headings = []
        self.tables_without_th = []
        self.tables_without_caption = []
        self.headers_without_scope = []
        self.unclosed_tables = []
        self.embedded_media = []
        self.media_no_caption = []
        self.autoplay_media = []
        self.links_no_text = []
        self.links_url_text = []
        self.links_generic_text = []
        self.iframes_no_title = []
        self.aria_hidden_focusable = []
        self.fixed_pixel_widths = []
        self.font_tags = []
        self.media_metadata = []

        self._links = []       # open <a> frames: {index, text, named}
        self._headings = []    # open heading frames: {index, level, text, named}
        self._tables = []      # open table frames: {index, has_header, has_caption, headers}
        self._players = []     # open video/audio frames: {index, tag, has_caption_track}
        self._template_depth = 0
        self._foreign_depth = 0
        self._previous_level = None
        self._heading_index = 0
        self._media_index = 0
        self._table_index = 0
        self._element_index = 0
        self._image_index = 0
        self._link_index = 0
        self._iframe_index = 0
        self._player_index = 0
        self._focusable_index = 0
        self._media_metadata_index = 0

    # -- helpers ---------------------------------------------------------
    def _close_table(self, table, unclosed):
        if not table["has_header"]:
            self.tables_without_th.append(table["index"])
        if not table["has_caption"]:
            self.tables_without_caption.append(table["index"])
        if unclosed:
            self.unclosed_tables.append(table["index"])

    # -- HTMLParser callbacks --------------------------------------------
    def handle_starttag(self, tag, attrs):
        name = tag.lower()
        attributes = {k.lower(): (v if v is not None else "") for k, v in attrs}
        ignored = self._template_depth > 0 or self._foreign_depth > 0
        if name == "template":
            self._template_depth += 1
        if name in ("svg", "math"):
            self._foreign_depth += 1
        self._element_index += 1

        if name == "img" and not ignored:
            self._image_index += 1
            role = (attributes.get("role") or "").strip().lower()
            marked_decorative = (
                role in ("presentation", "none")
                or (attributes.get("aria-hidden") or "").strip().lower() == "true"
            )
            if marked_decorative and _has_text(attributes.get("alt")):
                self.decorative_with_alt.append({"image_index": self._image_index})
            # Missing-alt evidence: no alt attribute at all, non-empty src,
            # and the raw tag kept its <...> shape.
            raw = self.get_starttag_text() or ""
            src = attributes.get("src")
            if (
                raw.startswith("<")
                and raw.endswith(">")
                and "alt" not in attributes
                and isinstance(src, str)
                and len(src) > 0
            ):
                self.missing_alt_images.append(
                    {"image_index": self._image_index, "image_src_sha256": _sha256_text(src)}
                )

        if HEADING_TAG.match(name):
            self._heading_index += 1
            level = int(name[1])
            if self._previous_level is not None and level > self._previous_level + 1:
                self.heading_jumps.append(
                    {"heading_index": self._heading_index,
                     "from_level": self._previous_level, "to_level": level}
                )
            self._previous_level = level
            self._headings.append(
                {"index": self._heading_index, "level": level, "text": "",
                 "named": _has_text(attributes.get("aria-label"))}
            )

        if name == "a":
            # An anchor with no href is a target, not a link: no link index.
            self._links.append(
                {"index": self._link_index + 1 if _has_text(attributes.get("href")) else 0,
                 "text": "",
                 "named": _has_text(attributes.get("aria-label")) or _has_text(attributes.get("title"))}
            )
            if _has_text(attributes.get("href")):
                self._link_index += 1

        # An image's alternative text names the link or heading containing it.
        if name == "img" and _has_text(attributes.get("alt")):
            for link in self._links:
                link["named"] = True
            for heading in self._headings:
                heading["named"] = True

        if name == "table":
            self._table_index += 1
            self._tables.append({"index": self._table_index, "has_header": False,
                                 "has_caption": False, "headers": 0})
        if name == "caption" and self._tables:
            self._tables[-1]["has_caption"] = True
        if name == "th" and self._tables:
            table = self._tables[-1]
            table["has_header"] = True
            table["headers"] += 1
            if not _has_text(attributes.get("scope")):
                self.headers_without_scope.append(
                    {"table_index": table["index"], "header_index": table["headers"]}
                )

        if name in EMBEDDED_MEDIA_TAGS:
            self._media_index += 1
            self.embedded_media.append(self._media_index)
        if name == "iframe":
            self._iframe_index += 1
            if not _has_text(attributes.get("title")):
                self.iframes_no_title.append(self._iframe_index)
        if name in ("video", "audio"):
            self._player_index += 1
            self._players.append({"index": self._player_index, "tag": name,
                                  "has_caption_track": False})
            if "autoplay" in attributes:
                self.autoplay_media.append({"media_index": self._player_index, "tag": name})
        if name == "track" and self._players:
            # HTML treats a track with no kind as subtitles.
            kind = (attributes.get("kind") or "").strip().lower() or "subtitles"
            if kind in ("captions", "subtitles"):
                self._players[-1]["has_caption_track"] = True

        if name == "font":
            self.font_tags.append(self._element_index)

        tabindex = attributes.get("tabindex")
        if (
            (name == "a" and _has_text(attributes.get("href")))
            or name in NATIVELY_FOCUSABLE_TAGS
            or (tabindex is not None and tabindex.strip() != "-1")
        ):
            self._focusable_index += 1
            if (attributes.get("aria-hidden") or "").strip().lower() == "true":
                self.aria_hidden_focusable.append(
                    {"focusable_index": self._focusable_index, "tag": name}
                )

        if name in FIXED_WIDTH_TAGS and "style" in attributes:
            width = INLINE_PIXEL_WIDTH.search(attributes["style"] or "")
            if width:
                px = float(width.group(1))
                self.fixed_pixel_widths.append(
                    {"element_index": self._element_index, "tag": name,
                     "width_px": int(px) if px.is_integer() else px}
                )

        if name in MEDIA_TAGS:
            self._media_metadata_index += 1
            if len(self.media_metadata) < MAX_MEDIA_METADATA:
                source = attributes.get("src", attributes.get("data"))
                entry = {"index": self._media_metadata_index, "tag": name}
                entry["source"] = (
                    {"status": "observed", "character_count": len(source),
                     "sha256": _sha256_text(source)}
                    if source is not None
                    else {"status": "not_observed"}
                )
                for key in ("title", "alt", "kind"):
                    if key in attributes:
                        entry[key] = {"character_count": len(attributes[key]),
                                      "sha256": _sha256_text(attributes[key])}
                self.media_metadata.append(entry)

    def handle_startendtag(self, tag, attrs):
        # Void/self-closing tags: run the open-tag logic only. htmlparser2
        # never synthesizes close events for these either.
        self.handle_starttag(tag, attrs)

    def handle_data(self, data):
        for link in self._links:
            link["text"] += data
        for heading in self._headings:
            heading["text"] += data

    def handle_endtag(self, tag):
        name = tag.lower()
        if name == "template" and self._template_depth > 0:
            self._template_depth -= 1
        if name in ("svg", "math") and self._foreign_depth > 0:
            self._foreign_depth -= 1
        if name == "a" and self._links:
            link = self._links.pop()
            text = _collapse_text(link["text"])
            if link["index"] > 0:
                if text == "":
                    if not link["named"]:
                        self.links_no_text.append({"link_index": link["index"]})
                else:
                    if BARE_URL_LINK_TEXT.match(text):
                        self.links_url_text.append({"link_index": link["index"]})
                    if text.lower() in GENERIC_LINK_TEXT:
                        self.links_generic_text.append({"link_index": link["index"]})
        if HEADING_TAG.match(name) and self._headings:
            heading = self._headings.pop()
            if not heading["named"] and _collapse_text(heading["text"]) == "":
                self.empty_headings.append(
                    {"heading_index": heading["index"], "level": heading["level"]}
                )
        if name in ("video", "audio") and self._players:
            player = self._players.pop()
            if not player["has_caption_track"]:
                self.media_no_caption.append(
                    {"media_index": player["index"], "tag": player["tag"]}
                )
        if name == "table" and self._tables:
            # An explicit close is a closed table; tables still open at
            # end-of-input are reported unclosed by the final sweep.
            self._close_table(self._tables.pop(), unclosed=False)

    def finish(self):
        # Tables still open here were never closed in the saved source.
        while self._tables:
            self._close_table(self._tables.pop(), unclosed=True)


def scan_html(html):
    """Run the 18 saved-source signal detectors over one HTML field.

    Returns a dict shaped like desktop's ``content_evidence`` fragment:
    ``observed_source_signals``, ``source_signal_limits``, ``media_metadata``,
    ``render_evidence`` (unavailable on this VM), and ``interpretation``.
    """
    parser = _SignalParser()
    parser.feed(html if isinstance(html, str) else "")
    parser.close()
    parser.finish()

    signal_lists = {
        "image_tags_without_alt": parser.missing_alt_images,
        "images_marked_decorative_with_alt_text": parser.decorative_with_alt,
        "heading_level_jumps": parser.heading_jumps,
        "empty_headings": parser.empty_headings,
        "tables_without_th": parser.tables_without_th,
        "tables_without_caption": parser.tables_without_caption,
        "table_headers_without_scope": parser.headers_without_scope,
        "unclosed_tables": parser.unclosed_tables,
        "embedded_media_tags": parser.embedded_media,
        "media_without_caption_track": parser.media_no_caption,
        "autoplay_media": parser.autoplay_media,
        "links_without_text": parser.links_no_text,
        "links_with_url_text": parser.links_url_text,
        "links_with_generic_text": parser.links_generic_text,
        "iframes_without_title": parser.iframes_no_title,
        "aria_hidden_on_focusable": parser.aria_hidden_focusable,
        "fixed_pixel_widths": parser.fixed_pixel_widths,
        "font_tags": parser.font_tags,
    }

    observed = {}
    truncated = []
    for name in SOURCE_SIGNAL_NAMES:
        entries = signal_lists[name]
        observed[name] = entries[:MAX_SOURCE_SIGNAL_ENTRIES]
        if len(entries) > MAX_SOURCE_SIGNAL_ENTRIES:
            truncated.append({"signal": name,
                              "returned_count": MAX_SOURCE_SIGNAL_ENTRIES,
                              "total_count": len(entries)})

    limits = {"status": "evidence_incomplete" if truncated else "observed",
              "max_entries_per_signal": MAX_SOURCE_SIGNAL_ENTRIES,
              "truncated_signals": truncated}
    if truncated:
        limits["reason"] = (
            "A signal list reached this audit's per-signal entry limit, "
            "so that list is incomplete for this field."
        )

    media = parser.media_metadata
    media_block = {
        "status": "manual_review_required" if media else "not_applicable",
        "returned_count": len(media),
        "truncated": parser._media_metadata_index > len(media),
    }
    if media:
        media_block["entries"] = media
        media_block["reason"] = (
            "Saved source identifies media markup only. Media bytes, captions, "
            "transcripts, audio description, player controls, and learner "
            "rendering require manual review."
        )

    return {
        "observed_source_signals": observed,
        "source_signal_limits": limits,
        "media_metadata": media_block,
        "render_evidence": dict(RENDER_EVIDENCE_UNAVAILABLE),
        "interpretation": INTERPRETATION,
    }
