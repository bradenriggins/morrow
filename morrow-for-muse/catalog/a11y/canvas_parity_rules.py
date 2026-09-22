#!/usr/bin/env python3
"""Canvas accessibility-checker parity port for Morrow for Muse.

Port of Instructure's tinymce-a11y-checker (MIT),
https://github.com/instructure/canvas-lms,
pinned commit 1c9f0bb8013ed69c4f2efe11fd483025469b7e6c.
Kept in its own module for upstream diffing.

What this is
------------
A faithful Python port of the 13 HTML rules from Canvas's RCE inline
accessibility checker
(``packages/canvas-rce/src/rce/plugins/tinymce-a11y-checker/rules/``):
the same rule ids, the same trigger conditions, the same thresholds,
and the same message/why strings Canvas shows educators. Rule ids are
verbatim so results compare 1:1 with Canvas's checker output. Stdlib
only (``re`` + ``html.parser``); no network, no browser.

What this is not
---------------
- Not a WCAG conformance checker. Every finding is a signal that needs
  human review, never a violation, and a clean result is never a pass.
  (Canvas's own checker is a teaching aid with the same limitation.)
- Not the course-level Ruby checker (``app/models/accessibility/``).
  The two checkers share the 13 rule ids but differ on one threshold:
  the course checker flags alt text over 200 characters while the RCE
  inline checker (what educators see) uses 120. This module ports the
  RCE 120-char rule; the 200-char variant is documented in the
  ``img-alt-length`` section, not implemented as a second rule.

Saved-source approximation (contrast rules)
------------------------------------------
Canvas computes contrast from live computed styles inside the editor.
This module sees only saved HTML, so ``small-text-contrast`` and
``large-text-contrast`` resolve ``color`` / ``background-color`` /
``font-size`` / ``font-weight`` from inline ``style`` attributes only
(nearest ancestor declaration wins; defaults are black text on white).
Every contrast finding is therefore marked ``approximate: True`` with a
note that Canvas's checker uses live computed styles, and a contrast
finding is never presented as definitive when it rests on defaults.

Parser notes
------------
Upstream runs on a live DOM. This port builds a small tree with
:mod:`html.parser`. For well-formed and ordinary Canvas-saved HTML the
results match; for pathological markup the result is still a valid
human-review signal, which is all this routine claims to be.

Known minor divergences from the live DOM (documented, not silent):
- ``alt.length`` / ``textContent.length``: JS counts UTF-16 code units,
  Python counts code points. Identical for BMP text; may differ by a few
  for emoji-heavy strings.
- Content inside ``<template>``: the DOM's ``querySelectorAll`` does not
  descend into ``template.content``; this port skips template-subtree
  elements to match.
- ``headings-sequence`` stops its ancestor walk at ``<body>`` upstream;
  this port stops at ``<body>`` or the synthetic document root, so bare
  fragments behave the same.

Public API
----------
``check_html(html)`` runs all 13 rules over one HTML string and returns::

    {"findings": [...], "rule_ids": [...13 ids...],
     "engine": "canvas-parity",
     "upstream_commit": "1c9f0bb8013ed69c4f2efe11fd483025469b7e6c"}

Each finding carries: ``rule_id``, ``message`` and ``why`` (Canvas's
verbatim strings), ``element_index`` (1-based, document order),
``locator`` (tag + key attributes; values truncated, URLs reduced to
their trailing segment, never full URLs), ``source`` ("canvas-parity"),
``approximate`` (bool), ``note`` (str or None), and ``detail``
(rule-specific extras).
"""

import re
from html.parser import HTMLParser

__all__ = ["check_html", "RULE_IDS", "RULE_MESSAGES", "ENGINE", "UPSTREAM_COMMIT"]

UPSTREAM_COMMIT = "1c9f0bb8013ed69c4f2efe11fd483025469b7e6c"
UPSTREAM_REPO = "https://github.com/instructure/canvas-lms"
ENGINE = "canvas-parity"
SOURCE_TAG = "canvas-parity"

# Rule order follows the parity brief; ids are Canvas's verbatim.
RULE_IDS = (
    "img-alt",
    "img-alt-filename",
    "img-alt-length",
    "table-caption",
    "table-header",
    "table-header-scope",
    "small-text-contrast",
    "large-text-contrast",
    "adjacent-links",
    "headings-sequence",
    "paragraphs-for-headings",
    "list-structure",
    "headings-start-at-h2",
)

# Message and why strings copied verbatim from the upstream rule sources.
RULE_MESSAGES = {
    "img-alt": (
        "Images should include an alt attribute describing the image content.",
        "Screen readers cannot determine what is displayed in an image without "
        "alternative text, which describes the content and meaning of the image.",
    ),
    "img-alt-filename": (
        "Image filenames should not be used as the alt attribute describing the image content.",
        "Screen readers cannot determine what is displayed in an image without "
        "alternative text, and filenames are often meaningless strings of numbers "
        "and letters that do not describe the context or meaning.",
    ),
    "img-alt-length": (
        "Alt attribute text should not contain more than 120 characters.",
        "Screen readers cannot determine what is displayed in an image without "
        "alternative text, which describes the content and meaning of the image. "
        "Alternative text should be simple and concise.",
    ),
    "table-caption": (
        "Tables should include a caption describing the contents of the table.",
        "Screen readers cannot interpret tables without the proper structure. "
        "Table captions describe the context and general understanding of the table.",
    ),
    "table-header": (
        "Tables should include at least one header.",
        "Screen readers cannot interpret tables without the proper structure. "
        "Table headers provide direction and overview of the content.",
    ),
    "table-header-scope": (
        "Tables headers should specify scope.",
        "Screen readers cannot interpret tables without the proper structure. "
        "Table headers provide direction and content scope.",
    ),
    "small-text-contrast": (
        "Text smaller than 18pt (or bold 14pt) should display a minimum contrast ratio of 4.5:1.",
        "Text is difficult to read without sufficient contrast between the text "
        "and the background, especially for those with low vision.",
    ),
    "large-text-contrast": (
        "Text larger than 18pt (or bold 14pt) should display a minimum contrast ratio of 3:1.",
        "Text is difficult to read without sufficient contrast between the text "
        "and the background, especially for those with low vision.",
    ),
    "adjacent-links": (
        "Adjacent links with the same URL should be a single link.",
        "Keyboards navigate to links using the Tab key. Two adjacent links that "
        "direct to the same destination can be confusing to keyboard users.",
    ),
    "headings-sequence": (
        "Heading levels should not be skipped.",
        "Sighted users browse web pages quickly, looking for large or bolded "
        "headings. Screen reader users rely on headers for contextual "
        "understanding. Headers should use the proper structure.",
    ),
    "paragraphs-for-headings": (
        "Headings should not contain more than 120 characters.",
        "Sighted users browse web pages quickly, looking for large or bolded "
        "headings. Screen reader users rely on headers for contextual "
        "understanding. Headers should be concise within the proper structure.",
    ),
    "list-structure": (
        "Lists should be formatted as lists.",
        "When markup is used that visually formats items as a list but does not "
        "indicate the list relationship, users may have difficulty in navigating "
        "the information.",
    ),
    "headings-start-at-h2": (
        "The first heading on a page should be an H2.",
        "Webpages should only have a single H1, which is automatically used by "
        "the page's Title. The first heading in your content should be an H2.",
    ),
}


# ---------------------------------------------------------------------------
# Minimal DOM
# ---------------------------------------------------------------------------

_VOID_ELEMENTS = frozenset(
    "area base br col embed hr img input link meta param source track wbr".split()
)

_HEADINGS = ("h1", "h2", "h3", "h4", "h5", "h6")


class _Text:
    __slots__ = ("data", "parent")

    def __init__(self, data, parent):
        self.data = data
        self.parent = parent


class _Node:
    __slots__ = ("tag", "attrs", "children", "parent", "index", "in_template")

    def __init__(self, tag, attrs, parent):
        self.tag = tag
        self.attrs = attrs
        self.children = []
        self.parent = parent
        self.index = 0  # 1-based document-order element index, assigned by builder
        self.in_template = bool(parent and (parent.in_template or parent.tag == "template"))


class _Tree(HTMLParser):
    """Tolerant tree builder. Mirrors the DOM closely enough for the 13 rules."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = _Node("__root__", {}, None)
        self._stack = [self.root]
        self.elements = []  # document order, __root__ excluded

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        parent = self._stack[-1]
        node_attrs = {}
        for name, value in attrs:
            # A valueless attribute (e.g. <img alt>) is present with value "".
            node_attrs[name.lower()] = "" if value is None else value
        node = _Node(tag, node_attrs, parent)
        parent.children.append(node)
        self.elements.append(node)
        node.index = len(self.elements)
        if tag not in _VOID_ELEMENTS:
            self._stack.append(node)

    def handle_startendtag(self, tag, attrs):
        before = len(self._stack)
        self.handle_starttag(tag, attrs)
        if len(self._stack) > before:
            # Self-closing tag: undo the push from handle_starttag.
            self._stack.pop()

    def handle_endtag(self, tag):
        tag = tag.lower()
        for i in range(len(self._stack) - 1, 0, -1):
            if self._stack[i].tag == tag:
                del self._stack[i:]
                break

    def handle_data(self, data):
        # Whitespace-only text is kept: the DOM keeps it as a text node too,
        # and upstream hasTextNode() counts any direct text-node child.
        if data:
            parent = self._stack[-1]
            parent.children.append(_Text(data, parent))

    def handle_comment(self, data):
        pass  # comments are not text nodes


def _text_content(node):
    parts = []

    def walk(n):
        for child in n.children:
            if isinstance(child, _Text):
                parts.append(child.data)
            else:
                walk(child)

    walk(node)
    return "".join(parts)


def _element_children(node):
    return [c for c in node.children if isinstance(c, _Node)]


def _iter_subtree_elements(node):
    """node inclusive, document order."""
    stack = [node]
    while stack:
        current = stack.pop()
        yield current
        stack.extend(reversed(_element_children(current)))


def _prev_element_sibling(node):
    if node.parent is None:
        return None
    sibs = _element_children(node.parent)
    idx = sibs.index(node)
    return sibs[idx - 1] if idx > 0 else None


def _next_element_sibling(node):
    if node.parent is None:
        return None
    sibs = _element_children(node.parent)
    idx = sibs.index(node)
    return sibs[idx + 1] if idx < len(sibs) - 1 else None


def _first_descendant(node, tag):
    for descendant in _iter_subtree_elements(node):
        if descendant is not node and descendant.tag == tag:
            return descendant
    return None


# ---------------------------------------------------------------------------
# Finding construction
# ---------------------------------------------------------------------------

_URL_ATTRS = ("src", "href", "data", "poster", "action", "cite", "longdesc")


def _shorten(value, limit=32):
    collapsed = re.sub(r"\s+", " ", value).strip()
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[: limit - 1] + "\u2026"


def _shorten_url(value):
    # Never emit a full URL: strip query/fragment, keep the trailing segment.
    bare = value.strip().split("?")[0].split("#")[0].rstrip("/")
    segment = bare.rsplit("/", 1)[-1]
    segment = _shorten(segment, 32)
    return "\u2026/" + segment if segment else "\u2026/"


def _locator(el):
    parts = [el.tag]
    for name in ("id", "class", "alt", "src", "href", "scope", "title"):
        if name in el.attrs and len(parts) < 4:
            raw = el.attrs[name]
            shown = _shorten_url(raw) if name in _URL_ATTRS else _shorten(raw)
            parts.append('%s="%s"' % (name, shown))
    if el.tag in _HEADINGS and len(parts) == 1:
        text = _shorten(_text_content(el), 32)
        if text:
            parts.append('"%s"' % text)
    return parts[0] + "".join("[%s]" % p for p in parts[1:])


def _finding(rule_id, el, approximate=False, note=None, detail=None):
    message, why = RULE_MESSAGES[rule_id]
    return {
        "rule_id": rule_id,
        "message": message,
        "why": why,
        "element_index": el.index,
        "locator": _locator(el),
        "source": SOURCE_TAG,
        "approximate": approximate,
        "note": note,
        "detail": detail or {},
    }


# ---------------------------------------------------------------------------
# Upstream regexes and thresholds, ported exactly
# ---------------------------------------------------------------------------

# img-alt-filename: /[^\s]+(.*?).(jpg|jpeg|png|gif|svg|bmp|webp)$/i
# NOTE: the dot before the extension is unescaped in the upstream JS source,
# so it matches ANY character, not just a literal dot (e.g. "photoXjpg"
# fires upstream). Quirk preserved verbatim.
_FILENAMELIKE = re.compile(r"[^\s]+(.*?).(jpg|jpeg|png|gif|svg|bmp|webp)$", re.IGNORECASE)

# img-alt-length: MAX_ALT_LENGTH = 120 in the RCE JS.
# NOTE (documented divergence, not implemented): the course-level Ruby
# checker (ImgAltRuleHelper) uses MAX_LENGTH = 200 with the message
# "Recommended alt text length is under 200 characters." This module ports
# the RCE inline checker's 120-char rule as the primary, per the brief.
_MAX_ALT_LENGTH = 120

# paragraphs-for-headings: MAX_HEADING_LENGTH = 120 (raw textContent length).
_MAX_HEADING_LENGTH = 120

# list-structure: built upstream as
#   new RegExp(`^\\s*(?:(?:[${bulletMarkers}])|(?:(${orderedChars})[${orderedMarkers}]))\\s+`)
# where bulletMarkers = "\\*|\\-", so the character class is literally
# [\*|\-] -- the '|' is a literal pipe inside the class (upstream quirk).
# Ported exactly.
_LISTLIKE = re.compile(
    r"^\s*(?:(?:[\*|\-])|(?:((?:[A-Z]{1,4}|[a-z]{1,4}|[0-9]{1,4})[\.\)]))\s+)"
)

# table-header-scope: VALID_SCOPES (case-sensitive indexOf upstream).
_VALID_SCOPES = ("row", "col", "rowgroup", "colgroup")


# ---------------------------------------------------------------------------
# Inline-style helpers for the contrast rules (saved-source approximation)
# ---------------------------------------------------------------------------

_CONTRAST_NOTE = (
    "Saved-source approximation: colors, background, and text size were read "
    "from inline styles only (defaults: black text on white). Canvas's checker "
    "uses live computed styles. Human review required; never a definitive "
    "violation."
)


def _parse_style(style_value):
    props = {}
    for declaration in (style_value or "").split(";"):
        name, sep, value = declaration.partition(":")
        name = name.strip().lower()
        if sep and name:
            props[name] = value.strip()
    return props


def _nearest_inline(el, prop):
    """Nearest inline declaration of prop walking up (element first)."""
    node = el
    while node is not None and node.tag != "__root__":
        props = _parse_style(node.attrs.get("style", ""))
        if prop in props:
            return props[prop]
        node = node.parent
    return None


_NAMED_COLORS = {
    "aliceblue": "f0f8ff", "antiquewhite": "faebd7", "aqua": "00ffff",
    "aquamarine": "7fffd4", "azure": "f0ffff", "beige": "f5f5dc",
    "bisque": "ffe4c4", "black": "000000", "blanchedalmond": "ffebcd",
    "blue": "0000ff", "blueviolet": "8a2be2", "brown": "a52a2a",
    "burlywood": "deb887", "cadetblue": "5f9ea0", "chartreuse": "7fff00",
    "chocolate": "d2691e", "coral": "ff7f50", "cornflowerblue": "6495ed",
    "cornsilk": "fff8dc", "crimson": "dc143c", "cyan": "00ffff",
    "darkblue": "00008b", "darkcyan": "008b8b", "darkgoldenrod": "b8860b",
    "darkgray": "a9a9a9", "darkgreen": "006400", "darkgrey": "a9a9a9",
    "darkkhaki": "bdb76b", "darkmagenta": "8b008b", "darkolivegreen": "556b2f",
    "darkorange": "ff8c00", "darkorchid": "9932cc", "darkred": "8b0000",
    "darksalmon": "e9967a", "darkseagreen": "8fbc8f", "darkslateblue": "483d8b",
    "darkslategray": "2f4f4f", "darkslategrey": "2f4f4f",
    "darkturquoise": "00ced1", "darkviolet": "9400d3", "deeppink": "ff1493",
    "deepskyblue": "00bfff", "dimgray": "696969", "dimgrey": "696969",
    "dodgerblue": "1e90ff", "firebrick": "b22222", "floralwhite": "fffaf0",
    "forestgreen": "228b22", "fuchsia": "ff00ff", "gainsboro": "dcdcdc",
    "ghostwhite": "f8f8ff", "gold": "ffd700", "goldenrod": "daa520",
    "gray": "808080", "green": "008000", "greenyellow": "adff2f",
    "grey": "808080", "honeydew": "f0fff0", "hotpink": "ff69b4",
    "indianred": "cd5c5c", "indigo": "4b0082", "ivory": "fffff0",
    "khaki": "f0e68c", "lavender": "e6e6fa", "lavenderblush": "fff0f5",
    "lawngreen": "7cfc00", "lemonchiffon": "fffacd", "lightblue": "add8e6",
    "lightcoral": "f08080", "lightcyan": "e0ffff",
    "lightgoldenrodyellow": "fafad2", "lightgray": "d3d3d3",
    "lightgreen": "90ee90", "lightgrey": "d3d3d3", "lightpink": "ffb6c1",
    "lightsalmon": "ffa07a", "lightseagreen": "20b2aa",
    "lightskyblue": "87cefa", "lightslategray": "778899",
    "lightslategrey": "778899", "lightsteelblue": "b0c4de",
    "lightyellow": "ffffe0", "lime": "00ff00", "limegreen": "32cd32",
    "linen": "faf0e6", "magenta": "ff00ff", "maroon": "800000",
    "mediumaquamarine": "66cdaa", "mediumblue": "0000cd",
    "mediumorchid": "ba55d3", "mediumpurple": "9370db",
    "mediumseagreen": "3cb371", "mediumslateblue": "7b68ee",
    "mediumspringgreen": "00fa9a", "mediumturquoise": "48d1cc",
    "mediumvioletred": "c71585", "midnightblue": "191970",
    "mintcream": "f5fffa", "mistyrose": "ffe4e1", "moccasin": "ffe4b5",
    "navajowhite": "ffdead", "navy": "000080", "oldlace": "fdf5e6",
    "olive": "808000", "olivedrab": "6b8e23", "orange": "ffa500",
    "orangered": "ff4500", "orchid": "da70d6", "palegoldenrod": "eee8aa",
    "palegreen": "98fb98", "paleturquoise": "afeeee",
    "palevioletred": "db7093", "papayawhip": "ffefd5", "peachpuff": "ffdab9",
    "peru": "cd853f", "pink": "ffc0cb", "plum": "dda0dd",
    "powderblue": "b0e0e6", "purple": "800080", "rebeccapurple": "663399",
    "red": "ff0000", "rosybrown": "bc8f8f", "royalblue": "4169e1",
    "saddlebrown": "8b4513", "salmon": "fa8072", "sandybrown": "f4a460",
    "seagreen": "2e8b57", "seashell": "fff5ee", "sienna": "a0522d",
    "silver": "c0c0c0", "skyblue": "87ceeb", "slateblue": "6a5acd",
    "slategray": "708090", "slategrey": "708090", "snow": "fffafa",
    "springgreen": "00ff7f", "steelblue": "4682b4", "tan": "d2b48c",
    "teal": "008080", "thistle": "d8bfd8", "tomato": "ff6347",
    "turquoise": "40e0d0", "violet": "ee82ee", "wheat": "f5deb3",
    "white": "ffffff", "whitesmoke": "f5f5f5", "yellow": "ffff00",
    "yellowgreen": "9acd32",
}

_HEX_RE = re.compile(r"#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
_FUNC_RE = re.compile(r"(rgba?|hsla?)\(\s*(.+?)\s*\)$", re.IGNORECASE)


def _hue_to_rgb(p, q, t):
    if t < 0:
        t += 1
    if t > 1:
        t -= 1
    if t < 1 / 6:
        return p + (q - p) * 6 * t
    if t < 1 / 2:
        return q
    if t < 2 / 3:
        return p + (q - p) * (2 / 3 - t) * 6
    return p


def _hsl_to_rgb(h, s, l):
    h = (h % 360.0) / 360.0
    if s == 0:
        return (l, l, l)
    q = l * (1 + s) if l < 0.5 else l + s - l * s
    p = 2 * l - q
    return (
        _hue_to_rgb(p, q, h + 1 / 3),
        _hue_to_rgb(p, q, h),
        _hue_to_rgb(p, q, h - 1 / 3),
    )


def _component_value(token, maximum):
    token = token.strip()
    if token.endswith("%"):
        return max(0.0, min(1.0, float(token[:-1]) / 100.0))
    return max(0.0, min(1.0, float(token) / maximum))


def _parse_color(value):
    """Parse a CSS color to (r, g, b, a) floats in 0..1, or None if unknown."""
    v = value.strip().lower()
    if v == "transparent":
        return (0.0, 0.0, 0.0, 0.0)
    if v in _NAMED_COLORS:
        hx = _NAMED_COLORS[v]
        return (
            int(hx[0:2], 16) / 255.0,
            int(hx[2:4], 16) / 255.0,
            int(hx[4:6], 16) / 255.0,
            1.0,
        )
    m = _HEX_RE.match(v)
    if m:
        hx = m.group(1)
        if len(hx) == 3:
            hx = "".join(c * 2 for c in hx) + "ff"
        elif len(hx) == 4:
            hx = "".join(c * 2 for c in hx)
        elif len(hx) == 6:
            hx = hx + "ff"
        r = int(hx[0:2], 16) / 255.0
        g = int(hx[2:4], 16) / 255.0
        b = int(hx[4:6], 16) / 255.0
        a = int(hx[6:8], 16) / 255.0
        return (r, g, b, a)
    m = _FUNC_RE.match(v)
    if m:
        kind = m.group(1).lower()
        parts = [p for p in re.split(r"[,\s/]+", m.group(2).strip()) if p]
        try:
            if kind.startswith("hsl"):
                if len(parts) < 3:
                    return None
                h = float(parts[0].rstrip("deg"))
                s = _component_value(parts[1], 1.0)
                l = _component_value(parts[2], 1.0)
                a = _component_value(parts[3], 1.0) if len(parts) > 3 else 1.0
                r, g, b = _hsl_to_rgb(h, s, l)
                return (r, g, b, a)
            if len(parts) < 3:
                return None
            r = _component_value(parts[0], 255.0)
            g = _component_value(parts[1], 255.0)
            b = _component_value(parts[2], 255.0)
            a = _component_value(parts[3], 1.0) if len(parts) > 3 else 1.0
            return (r, g, b, a)
        except ValueError:
            return None
    return None


def _color_token_in_shorthand(background_value):
    """Best-effort: find a parseable color token inside a `background` value."""
    for token in re.split(r"\s+", background_value.strip()):
        if _parse_color(token) is not None:
            return token
    return None


def _composite_over(fg, bg):
    """Composite fg (r,g,b,a) over opaque bg (r,g,b). Returns opaque (r,g,b)."""
    fr, fg_, fb, fa = fg
    br, bg_, bb = bg
    return (
        fr * fa + br * (1 - fa),
        fg_ * fa + bg_ * (1 - fa),
        fb * fa + bb * (1 - fa),
    )


def _linear_channel(c):
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4


def _luminance(rgb):
    r, g, b = rgb
    return 0.2126 * _linear_channel(r) + 0.7152 * _linear_channel(g) + 0.0722 * _linear_channel(b)


def _contrast_ratio(rgb1, rgb2):
    l1, l2 = _luminance(rgb1), _luminance(rgb2)
    hi, lo = (l1, l2) if l1 >= l2 else (l2, l1)
    return (hi + 0.05) / (lo + 0.05)


_FONT_SIZE_RE = re.compile(
    r"^\s*([0-9]*\.?[0-9]+)\s*(px|pt|pc|in|cm|mm|q|em|rem|ex|ch|vw|vh|vmin|vmax|%)?\s*$",
    re.IGNORECASE,
)

_PT_PER_UNIT = {
    "pt": 1.0,
    "px": 72.0 / 96.0,
    "pc": 12.0,
    "in": 72.0,
    "cm": 72.0 / 2.54,
    "mm": 72.0 / 25.4,
    "q": 72.0 / 101.6,
}


def _font_size_to_pt(value):
    """Inline font-size to points, or None when it cannot be determined."""
    m = _FONT_SIZE_RE.match(value or "")
    if not m:
        return None
    unit = (m.group(2) or "px").lower()
    # Relative/keyword/viewport sizes need layout context; undetermined here.
    if unit not in _PT_PER_UNIT:
        return None
    return float(m.group(1)) * _PT_PER_UNIT[unit]


def _font_shorthand_size_weight(value):
    """Extract (size_pt_or_None, bold_bool) from a `font` shorthand value."""
    size = None
    bold = False
    for token in (value or "").split():
        piece = token.split("/")[0]
        if size is None:
            pt = _font_size_to_pt(piece)
            if pt is not None:
                size = pt
                continue
        low = piece.lower()
        if low in ("bold", "bolder") or (low.isdigit() and int(low) >= 700):
            bold = True
    return size, bold


def _is_bold(el):
    """Bold per upstream computed style, approximated from inline declarations.

    Upstream sees computed font-weight (including <b>/<strong> rendering as
    bold). This port reads inline ``font-weight``/``font`` only; <b>/<strong>
    tags are a known approximation gap, documented on the finding note.
    """
    raw = _nearest_inline(el, "font-weight")
    if raw is None:
        _size, bold = _font_shorthand_size_weight(_nearest_inline(el, "font") or "")
        return bold
    low = raw.strip().lower()
    if low in ("bold", "bolder"):  # "bolder" is relative; treated as bold here
        return True
    return low.isdigit() and int(low) >= 700


def _is_large_text(el):
    """WCAG large-scale text: >= 18pt, or bold and >= 14pt (inline styles)."""
    raw = _nearest_inline(el, "font-size")
    if raw is None:
        _size, _bold = _font_shorthand_size_weight(_nearest_inline(el, "font") or "")
        pt = _size
    else:
        pt = _font_size_to_pt(raw)
    if pt is None:
        return False
    return pt >= 18 or (_is_bold(el) and pt >= 14)


def _has_inline_bg_image(el):
    """Upstream skips elements with background images/gradients (computed).

    Saved-source can only see inline declarations; a declared non-none
    background-image on the element or an ancestor skips the rule.
    """
    node = el
    while node is not None and node.tag != "__root__":
        props = _parse_style(node.attrs.get("style", ""))
        bgimage = props.get("background-image", "").strip().lower()
        if bgimage and bgimage != "none":
            return True
        node = node.parent
    return False


def _effective_colors(el):
    """Resolve (fg, bg) as opaque (r,g,b) triples, or None if undetermined.

    fg: nearest inline color, default black. bg: nearest inline
    background-color (falling back to a color token in `background`
    shorthand), composited over the default white. A declared but
    unparseable color means the ratio cannot be determined -> None.
    """
    fg_raw = _nearest_inline(el, "color")
    fg = (0.0, 0.0, 0.0, 1.0) if fg_raw is None else _parse_color(fg_raw)
    if fg is None:
        return None
    layers = []
    node = el
    while node is not None and node.tag != "__root__":
        props = _parse_style(node.attrs.get("style", ""))
        raw = props.get("background-color")
        if not raw:
            raw = _color_token_in_shorthand(props.get("background", ""))
        if raw:
            color = _parse_color(raw)
            if color is None:
                return None
            layers.append(color)
            if color[3] >= 1.0:
                break
        node = node.parent
    r, g, b = 1.0, 1.0, 1.0  # default canvas: white
    for cr, cg, cb, ca in reversed(layers):
        r = cr * ca + r * (1 - ca)
        g = cg * ca + g * (1 - ca)
        b = cb * ca + b * (1 - ca)
    return (_composite_over(fg, (r, g, b)), (r, g, b))


def _has_text_node(el):
    """Upstream hasTextNode(): any direct child that is a text node."""
    return any(isinstance(child, _Text) for child in el.children)


def _only_contains_link(el):
    """Upstream onlyContainsLink(): first descendant <a>'s text == elem's text."""
    first_link = None
    for descendant in _iter_subtree_elements(el):
        if descendant is not el and descendant.tag == "a":
            first_link = descendant
            break
    if first_link is None:
        return False
    return _text_content(first_link) == _text_content(el)


def _rule_text_contrast(tree, findings, large):
    rule_id = "large-text-contrast" if large else "small-text-contrast"
    threshold = 3.0 if large else 4.5
    for el in tree.elements:
        if el.in_template:
            continue
        if not _has_text_node(el):
            continue
        if _only_contains_link(el):
            continue
        if _is_large_text(el) != large:
            continue
        if _has_inline_bg_image(el):
            continue  # upstream ignores background images and gradients
        resolved = _effective_colors(el)
        if resolved is None:
            continue  # cannot determine a ratio from saved source
        fg, bg = resolved
        ratio = _contrast_ratio(fg, bg)
        # Upstream's wcag-element-contrast passes when ratio >= threshold.
        if ratio < threshold:
            findings.append(
                _finding(
                    rule_id,
                    el,
                    approximate=True,
                    note=_CONTRAST_NOTE,
                    detail={
                        "ratio": round(ratio, 2),
                        "threshold": threshold,
                        "large_text": large,
                        "fg": "#%02x%02x%02x" % tuple(int(round(c * 255)) for c in fg),
                        "bg": "#%02x%02x%02x" % tuple(int(round(c * 255)) for c in bg),
                    },
                )
            )


# ---------------------------------------------------------------------------
# The 13 rules
# ---------------------------------------------------------------------------

def _rule_img_alt(tree, findings):
    # Fires when the alt attribute is missing entirely; alt="" passes.
    for el in tree.elements:
        if el.in_template or el.tag != "img":
            continue
        if "alt" not in el.attrs:
            findings.append(_finding("img-alt", el))


def _rule_img_alt_filename(tree, findings):
    for el in tree.elements:
        if el.in_template or el.tag != "img":
            continue
        alt = el.attrs.get("alt")  # None when missing
        if alt is None:
            # JS RegExp.test(null) coerces to "null", which never matches.
            continue
        is_decorative = re.sub(r"\s", "", alt) == ""
        if _FILENAMELIKE.search(alt) and not is_decorative:
            findings.append(
                _finding("img-alt-filename", el, detail={"alt": _shorten(alt)})
            )


def _rule_img_alt_length(tree, findings):
    for el in tree.elements:
        if el.in_template or el.tag != "img":
            continue
        alt = el.attrs.get("alt")
        if alt is not None and len(alt) > _MAX_ALT_LENGTH:
            findings.append(
                _finding(
                    "img-alt-length",
                    el,
                    detail={"alt_length": len(alt), "max_length": _MAX_ALT_LENGTH},
                )
            )


def _rule_table_caption(tree, findings):
    for el in tree.elements:
        if el.in_template or el.tag != "table":
            continue
        caption = _first_descendant(el, "caption")
        if caption is None or re.sub(r"\s", "", _text_content(caption)) == "":
            findings.append(_finding("table-caption", el))


def _rule_table_header(tree, findings):
    for el in tree.elements:
        if el.in_template or el.tag != "table":
            continue
        if _first_descendant(el, "th") is None:
            findings.append(_finding("table-header", el))


def _rule_table_header_scope(tree, findings):
    for el in tree.elements:
        if el.in_template or el.tag != "th":
            continue
        # Case-sensitive, like upstream's VALID_SCOPES.indexOf(); a missing
        # scope (None) fires as well.
        if el.attrs.get("scope") not in _VALID_SCOPES:
            findings.append(
                _finding(
                    "table-header-scope",
                    el,
                    detail={"scope": el.attrs.get("scope")},
                )
            )


def _rule_small_text_contrast(tree, findings):
    _rule_text_contrast(tree, findings, large=False)


def _rule_large_text_contrast(tree, findings):
    _rule_text_contrast(tree, findings, large=True)


def _rule_adjacent_links(tree, findings):
    for el in tree.elements:
        if el.in_template or el.tag != "a":
            continue
        nxt = _next_element_sibling(el)
        # NOTE: upstream compares getAttribute() values, so two adjacent
        # href-less anchors (null === null in JS) also fire. Ported exactly.
        if nxt is not None and nxt.tag == "a" and el.attrs.get("href") == nxt.attrs.get("href"):
            href = el.attrs.get("href")
            findings.append(
                _finding(
                    "adjacent-links",
                    el,
                    detail={"href": _shorten_url(href) if href else None},
                )
            )


def _last_heading_in_subtree(node):
    """Last heading in document order within node's subtree (node inclusive).

    Mirrors upstream getHighestOrderHForElem(): the last match of
    querySelectorAll('H1..H6') inside the sibling, else the sibling itself
    when it is a heading.
    """
    last = None
    for descendant in _iter_subtree_elements(node):
        if descendant.tag in _HEADINGS:
            last = descendant
    return last


def _prior_heading(el):
    """Walk up through previous siblings and ancestors for the prior heading.

    Mirrors upstream walkUpTree/_walkUpTree: nearest previous siblings
    first, then the parent chain (an ancestor that is itself a heading
    counts), stopping at <body>/document root. Returns None when there is
    no prior heading.
    """
    sibs = _element_children(el.parent)
    for sibling in reversed(sibs[: sibs.index(el)]):
        found = _last_heading_in_subtree(sibling)
        if found is not None:
            return found
    ancestor = el.parent
    while ancestor is not None and ancestor.tag not in ("__root__", "body"):
        if ancestor.tag in _HEADINGS:
            return ancestor
        sibs = _element_children(ancestor.parent)
        for sibling in reversed(sibs[: sibs.index(ancestor)]):
            found = _last_heading_in_subtree(sibling)
            if found is not None:
                return found
        ancestor = ancestor.parent
    return None


def _rule_headings_sequence(tree, findings):
    # Only H2-H6 are tested upstream; H1 always passes this rule.
    for el in tree.elements:
        if el.in_template or el.tag not in ("h2", "h3", "h4", "h5", "h6"):
            continue
        prior = _prior_heading(el)
        if prior is None:
            continue  # the first heading in the document never fires
        hnum = int(el.tag[1])
        # A prior heading is valid when it is equal, deeper, or exactly one
        # level shallower: {H(hnum-1) .. H6}. Fires on a skip of 2+ levels.
        valid = {"h%d" % i for i in range(hnum - 1, 7)}
        if prior.tag not in valid:
            findings.append(
                _finding(
                    "headings-sequence",
                    el,
                    detail={"heading": el.tag, "prior_heading": prior.tag},
                )
            )


def _rule_paragraphs_for_headings(tree, findings):
    for el in tree.elements:
        if el.in_template or el.tag not in _HEADINGS:
            continue
        length = len(_text_content(el))  # raw textContent length, uncollapsed
        if length > _MAX_HEADING_LENGTH:
            findings.append(
                _finding(
                    "paragraphs-for-headings",
                    el,
                    detail={"heading_length": length, "max_length": _MAX_HEADING_LENGTH},
                )
            )


def _is_text_list(el):
    return el.tag == "p" and _LISTLIKE.match(_text_content(el)) is not None


def _rule_list_structure(tree, findings):
    for el in tree.elements:
        if el.in_template or not _is_text_list(el):
            continue
        prev = _prev_element_sibling(el)
        # Only the FIRST paragraph of a consecutive text-list run fires.
        if prev is None or not _is_text_list(prev):
            findings.append(_finding("list-structure", el))


def _rule_headings_start_at_h2(tree, findings):
    # Any H1 fires (Canvas reserves H1 for the page title).
    # Upstream honors config.disableHeadingsStartAtH2; this port always checks.
    for el in tree.elements:
        if el.in_template or el.tag != "h1":
            continue
        findings.append(_finding("headings-start-at-h2", el))


_RULE_FUNCTIONS = (
    _rule_img_alt,
    _rule_img_alt_filename,
    _rule_img_alt_length,
    _rule_table_caption,
    _rule_table_header,
    _rule_table_header_scope,
    _rule_small_text_contrast,
    _rule_large_text_contrast,
    _rule_adjacent_links,
    _rule_headings_sequence,
    _rule_paragraphs_for_headings,
    _rule_list_structure,
    _rule_headings_start_at_h2,
)


def check_html(html):
    """Run all 13 Canvas parity rules over one HTML string.

    Returns {"findings", "rule_ids", "engine", "upstream_commit"}.
    Findings are human-review signals, never WCAG conformance claims.
    """
    if isinstance(html, bytes):
        html = html.decode("utf-8", "replace")
    tree = _Tree()
    tree.feed(html)
    tree.close()
    findings = []
    for rule_fn in _RULE_FUNCTIONS:
        rule_fn(tree, findings)
    return {
        "findings": findings,
        "rule_ids": list(RULE_IDS),
        "engine": ENGINE,
        "upstream_commit": UPSTREAM_COMMIT,
    }
