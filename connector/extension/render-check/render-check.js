/**
 * Learner-render checks for one saved HTML field.
 *
 * This module runs inside connector/extension/render-check/render-check.html,
 * a sandboxed extension page whose content security policy is
 * `default-src 'none'`. The saved HTML arrives by postMessage; the page parses
 * it into a detached document, which loads no image, media, script, style or
 * font, and never reaches the network.
 *
 * What it produces is a saved-source render signal, live-unverified. A detached
 * document is not the learner's Canvas page: it has no course theme CSS, no
 * Canvas chrome, no real focus behaviour and no assistive-technology output.
 * Every value that needs the real course theme is reported as not determinable
 * rather than guessed, and no result here is a conformance result.
 *
 * The record carries indexes, counts and enumerated states only. It never
 * carries course text, link URLs, image sources or a screenshot.
 */

export const RENDER_CHECK_SCHEMA = "morrow.canvas-render-check.v1";
export const RENDER_CHECK_REQUEST_SCHEMA = "morrow.canvas-render-check.request.v1";
export const RENDER_CHECK_REPLY_SCHEMA = "morrow.canvas-render-check.reply.v1";
/** The runtime message the service worker sends to the offscreen host document. */
export const RENDER_CHECK_MESSAGE_TYPE = "morrow_render_check";
/**
 * The saved HTML fields one Canvas read can carry, in the order this check
 * takes them. The first non-empty field is the one it reads, and the record
 * names it, so `course-audit.ts` can require the field it audited.
 */
export const RENDER_CHECK_FIELDS = Object.freeze([
  "body", "message", "question_text", "instructions", "syllabus_body",
  "description", "long_description", "entry.item_body", "entry.body",
]);
/** Matches MAX_COMPLETE_EVIDENCE_CHARS in packages/mcp-server/src/course-audit.ts. */
export const MAX_RENDER_CHECK_SOURCE_CHARS = 120_000;
export const MAX_RENDER_CHECK_ELEMENTS = 4_000;
export const MAX_RENDER_CHECK_DEPTH = 64;
/** Matches MAX_SOURCE_SIGNAL_ENTRIES in packages/mcp-server/src/course-audit.ts. */
export const MAX_RENDER_CHECK_ENTRIES = 100;
const MAX_TEXT_CHARS = 4_000;

const INTERPRETATION = "Saved-source render signal, live-unverified. A detached document is not the learner's Canvas page: it carries no course theme CSS, no Canvas chrome, no real focus behaviour and no assistive-technology output. Every list is a signal that needs human review, not a violation, and nothing here establishes WCAG conformance.";

/**
 * The focusable set this check uses. A detached document cannot be focused, so
 * membership is decided from markup alone: the natively focusable elements,
 * plus any element the author put in the tab order with `tabindex`.
 */
const NATIVELY_FOCUSABLE_TAGS = new Set(["button", "input", "select", "textarea", "iframe", "summary"]);
const HREF_FOCUSABLE_TAGS = new Set(["a", "area"]);
const CONTROLS_FOCUSABLE_TAGS = new Set(["audio", "video"]);
const BUTTON_INPUT_TYPES = new Set(["button", "submit", "reset", "image"]);
const MEDIA_PLAYER_TAGS = new Set(["audio", "video"]);
const EMBEDDED_FRAME_TAGS = new Set(["iframe", "object", "embed"]);
const TABLE_CELL_TAGS = new Set(["th", "td"]);

/**
 * The colour keywords this check resolves. A keyword outside this set is
 * reported as not determinable instead of being guessed, because the resolved
 * value would otherwise depend on the browser and the course theme.
 */
const COLOR_KEYWORDS = new Map(Object.entries({
  black: [0, 0, 0], silver: [192, 192, 192], gray: [128, 128, 128], grey: [128, 128, 128],
  white: [255, 255, 255], maroon: [128, 0, 0], red: [255, 0, 0], purple: [128, 0, 128],
  fuchsia: [255, 0, 255], magenta: [255, 0, 255], green: [0, 128, 0], lime: [0, 255, 0],
  olive: [128, 128, 0], yellow: [255, 255, 0], navy: [0, 0, 128], blue: [0, 0, 255],
  teal: [0, 128, 128], aqua: [0, 255, 255], cyan: [0, 255, 255], orange: [255, 165, 0],
}));

function collapse(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/** One inline `style` attribute as a lower-cased property map. */
export function inlineStyleDeclarations(style) {
  const declarations = {};
  for (const part of String(style ?? "").split(";")) {
    const separator = part.indexOf(":");
    if (separator <= 0) continue;
    const property = part.slice(0, separator).trim().toLowerCase();
    const value = part.slice(separator + 1).trim();
    if (property && value) declarations[property] = value;
  }
  return declarations;
}

/**
 * One CSS colour as sRGB bytes, or null when this check cannot resolve it
 * exactly. A colour with alpha below 1 needs whatever is painted behind it, so
 * it is not resolvable from the saved source and returns null.
 */
export function cssColorToRgb(value) {
  const text = collapse(value).toLowerCase();
  if (!text) return null;
  const keyword = COLOR_KEYWORDS.get(text);
  if (keyword) return [...keyword];
  const hex = /^#([0-9a-f]{3,8})$/.exec(text);
  if (hex) {
    const digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      if (digits.length === 4 && digits[3] !== "f") return null;
      return [0, 1, 2].map((index) => Number.parseInt(digits[index].repeat(2), 16));
    }
    if (digits.length === 6 || digits.length === 8) {
      if (digits.length === 8 && digits.slice(6) !== "ff") return null;
      return [0, 2, 4].map((index) => Number.parseInt(digits.slice(index, index + 2), 16));
    }
    return null;
  }
  const functional = /^rgba?\(([^)]*)\)$/.exec(text);
  if (!functional) return null;
  const parts = functional[1].split(/[\s,/]+/).filter((part) => part !== "");
  if (parts.length !== 3 && parts.length !== 4) return null;
  if (parts.length === 4 && !["1", "1.0", "100%"].includes(parts[3])) return null;
  const channels = parts.slice(0, 3).map((part) => {
    if (/^\d+(?:\.\d+)?%$/.test(part)) return Math.round((Number.parseFloat(part) / 100) * 255);
    if (/^\d+(?:\.\d+)?$/.test(part)) return Math.round(Number.parseFloat(part));
    return Number.NaN;
  });
  if (channels.some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 255)) return null;
  return channels;
}

/** WCAG 2.2 relative luminance of one sRGB colour. */
export function relativeLuminance([red, green, blue]) {
  const channel = (value) => {
    const scaled = value / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return (0.2126 * channel(red)) + (0.7152 * channel(green)) + (0.0722 * channel(blue));
}

/** WCAG 2.2 contrast ratio of two sRGB colours, rounded to two decimals. */
export function contrastRatio(foreground, background) {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100;
}

/**
 * Walks a detached document into a bounded, plain element list. Every later
 * computation reads this list only, so it stays deterministic and needs no DOM.
 */
export function collectRenderElements(root) {
  const elements = [];
  let truncated = false;
  const visit = (node, parentIndex, depth) => {
    const children = node?.childNodes ? Array.from(node.childNodes) : [];
    for (const child of children) {
      if (child?.nodeType === 3) {
        const parent = parentIndex > 0 ? elements[parentIndex - 1] : undefined;
        if (parent && parent.text.length < MAX_TEXT_CHARS) parent.text += String(child.data ?? child.nodeValue ?? "");
        continue;
      }
      if (child?.nodeType !== 1) continue;
      if (elements.length >= MAX_RENDER_CHECK_ELEMENTS) { truncated = true; return; }
      const attributes = {};
      for (const entry of Array.from(child.attributes ?? [])) {
        if (entry?.name) attributes[String(entry.name).toLowerCase()] = String(entry.value ?? "");
      }
      const index = elements.length + 1;
      elements.push({ index, tag: String(child.tagName ?? "").toLowerCase(), parent: parentIndex, attributes, text: "" });
      if (depth >= MAX_RENDER_CHECK_DEPTH) { truncated = true; continue; }
      visit(child, index, depth + 1);
    }
  };
  visit(root?.body ?? root?.documentElement ?? root, 0, 0);
  return { elements, truncated };
}

function attribute(element, name) {
  const value = element.attributes[name];
  return typeof value === "string" ? value : undefined;
}

function hasAttribute(element, name) {
  return Object.hasOwn(element.attributes, name);
}

function roleOf(element) {
  return collapse(attribute(element, "role")).toLowerCase();
}

function tabIndexOf(element) {
  const raw = attribute(element, "tabindex");
  if (raw === undefined) return undefined;
  const text = collapse(raw);
  return /^[+-]?\d+$/.test(text) ? Number.parseInt(text, 10) : undefined;
}

function childMap(elements) {
  const children = new Map();
  for (const element of elements) {
    const siblings = children.get(element.parent);
    if (siblings) siblings.push(element);
    else children.set(element.parent, [element]);
  }
  return children;
}

/** One bounded list plus its own count and truncation flag, named after itself. */
function list(name, entries) {
  return {
    [name]: entries.slice(0, MAX_RENDER_CHECK_ENTRIES),
    [`${name}_count`]: entries.length,
    [`${name}_truncated`]: entries.length > MAX_RENDER_CHECK_ENTRIES,
  };
}

/**
 * The text an assistive technology would read from an element's own content.
 * An image's alternative text names the element that contains it, so it counts
 * as content exactly as `htmlSignals` counts it in course-audit.ts. A button
 * input holds its content in `value`, and an image button in `alt`.
 */
function contentText(element, children, memo) {
  const cached = memo.get(element.index);
  if (cached !== undefined) return cached;
  let text = element.text;
  if (element.tag === "img") text += ` ${attribute(element, "alt") ?? ""}`;
  if (element.tag === "input" && BUTTON_INPUT_TYPES.has(collapse(attribute(element, "type")).toLowerCase())) {
    text += ` ${attribute(element, "value") ?? ""} ${attribute(element, "alt") ?? ""}`;
  }
  for (const child of children.get(element.index) ?? []) text += ` ${contentText(child, children, memo)}`;
  memo.set(element.index, text);
  return text;
}

/**
 * The accessible name of one element, by the documented precedence:
 * `aria-labelledby` → `aria-label` → text content → `title`. An
 * `aria-labelledby` reference that names no element in this field is skipped
 * and the precedence continues, which is what a browser does.
 */
export function accessibleName(element, children, byId, memo = new Map()) {
  const references = collapse(attribute(element, "aria-labelledby")).split(" ").filter((token) => token !== "");
  if (references.length) {
    const resolved = references.map((id) => byId.get(id)).filter((target) => target !== undefined);
    const text = collapse(resolved.map((target) => contentText(target, children, memo)).join(" "));
    if (text) return { source: "aria_labelledby", text };
    if (resolved.length !== references.length) return { source: "aria_labelledby_reference_unresolved", text: "" };
  }
  const label = collapse(attribute(element, "aria-label"));
  if (label) return { source: "aria_label", text: label };
  const content = collapse(contentText(element, children, memo));
  if (content) return { source: "text_content", text: content };
  const title = collapse(attribute(element, "title"));
  if (title) return { source: "title", text: title };
  return { source: "none", text: "" };
}

function isLink(element) {
  return (element.tag === "a" && collapse(attribute(element, "href")) !== "") || roleOf(element) === "link";
}

function isButton(element) {
  if (element.tag === "button" || roleOf(element) === "button") return true;
  return element.tag === "input" && BUTTON_INPUT_TYPES.has(collapse(attribute(element, "type")).toLowerCase());
}

function isFocusable(element) {
  const tabIndex = tabIndexOf(element);
  if (hasAttribute(element, "disabled")) return false;
  if (tabIndex !== undefined) return tabIndex >= 0;
  if (element.tag === "input") return collapse(attribute(element, "type")).toLowerCase() !== "hidden";
  if (HREF_FOCUSABLE_TAGS.has(element.tag)) return collapse(attribute(element, "href")) !== "";
  if (CONTROLS_FOCUSABLE_TAGS.has(element.tag)) return hasAttribute(element, "controls");
  return NATIVELY_FOCUSABLE_TAGS.has(element.tag);
}

/**
 * Focus order against DOM order. Only a positive `tabindex` can reorder the tab
 * sequence, so only that reordering is reported; everything else follows DOM
 * order here and is not a signal.
 */
function focusOrderSignal(elements) {
  const focusable = elements.filter(isFocusable).map((element, position) => ({
    element_index: element.index,
    dom_position: position + 1,
    tabindex: tabIndexOf(element) ?? null,
  }));
  const positive = focusable.filter((entry) => typeof entry.tabindex === "number" && entry.tabindex > 0);
  const ordered = positive.length === 0 ? focusable : [
    ...[...positive].sort((first, second) => first.tabindex - second.tabindex || first.dom_position - second.dom_position),
    ...focusable.filter((entry) => !(typeof entry.tabindex === "number" && entry.tabindex > 0)),
  ];
  const reordered = positive.length === 0 ? [] : ordered
    .map((entry, position) => ({ ...entry, tab_position: position + 1 }))
    .filter((entry) => entry.tab_position !== entry.dom_position);
  return {
    status: "observed",
    focusable_count: focusable.length,
    positive_tabindex_count: positive.length,
    ...list("reordered_by_positive_tabindex", reordered),
    rendered_focus_order: "not_determinable_without_course_theme",
  };
}

function accessibleNameSignal(elements, children, byId) {
  const memo = new Map();
  const entries = [];
  const missing = [];
  const links = [];
  for (const element of elements) {
    const link = isLink(element);
    if (!link && !isButton(element)) continue;
    const name = accessibleName(element, children, byId, memo);
    entries.push({
      element_index: element.index,
      element_kind: link ? "link" : "button",
      name_source: name.source,
      name_character_count: name.text.length,
    });
    if (name.text === "") missing.push({ element_index: element.index, element_kind: link ? "link" : "button" });
    if (link && element.tag === "a") links.push({ index: element.index, name: name.text.toLowerCase(), href: collapse(attribute(element, "href")) });
  }
  return {
    names: {
      status: "observed",
      ...list("entries", entries),
      ...list("without_accessible_name", missing),
      precedence: ["aria-labelledby", "aria-label", "text content", "title"],
      assistive_technology_output: "not_determinable_without_course_theme",
    },
    links,
  };
}

/**
 * Links that read the same but lead somewhere different. The record carries the
 * group's link indexes and how many distinct destinations it found, never the
 * link text and never a URL.
 */
function duplicateLinkTextSignal(links) {
  const groups = new Map();
  for (const link of links) {
    if (link.name === "") continue;
    const group = groups.get(link.name);
    if (group) { group.indexes.push(link.index); group.hrefs.add(link.href); }
    else groups.set(link.name, { index: groups.size + 1, indexes: [link.index], hrefs: new Set([link.href]) });
  }
  const entries = [...groups.values()]
    .filter((group) => group.hrefs.size > 1)
    .map((group) => ({
      group_index: group.index,
      link_element_indexes: group.indexes.slice(0, MAX_RENDER_CHECK_ENTRIES),
      distinct_destination_count: group.hrefs.size,
    }));
  return { status: "observed", ...list("groups", entries) };
}

/**
 * Header association for each table: whether header cells exist, whether they
 * carry `scope`, and whether every `headers` reference resolves to a cell id in
 * the same table. Whether the association is correct for a complex table stays
 * a human judgment.
 */
function tableSignal(elements, children) {
  const entries = [];
  for (const table of elements) {
    if (table.tag !== "table") continue;
    const cells = [];
    const collect = (element) => {
      for (const child of children.get(element.index) ?? []) {
        // A nested table owns its own cells, so this table does not claim them.
        if (child.tag === "table") continue;
        if (TABLE_CELL_TAGS.has(child.tag)) cells.push(child);
        collect(child);
      }
    };
    collect(table);
    const ids = new Set(cells.map((cell) => collapse(attribute(cell, "id"))).filter((id) => id !== ""));
    const headerCells = cells.filter((cell) => cell.tag === "th");
    let unresolved = 0;
    let cellsWithHeaders = 0;
    for (const cell of cells) {
      const references = collapse(attribute(cell, "headers")).split(" ").filter((token) => token !== "");
      if (references.length === 0) continue;
      cellsWithHeaders += 1;
      unresolved += references.filter((id) => !ids.has(id)).length;
    }
    const withScope = headerCells.filter((cell) => collapse(attribute(cell, "scope")) !== "").length;
    entries.push({
      element_index: table.index,
      header_cell_count: headerCells.length,
      header_cells_with_scope: withScope,
      header_cells_without_scope: headerCells.length - withScope,
      cells_with_headers_attribute: cellsWithHeaders,
      unresolved_headers_references: unresolved,
      association: headerCells.length === 0
        ? "no_header_cells"
        : cellsWithHeaders > 0 && withScope > 0
          ? "scope_and_headers_ids"
          : cellsWithHeaders > 0
            ? "headers_ids"
            : withScope > 0
              ? "scope"
              : "header_cells_without_association",
    });
  }
  return { status: "observed", ...list("tables", entries), reading_order: "not_determinable_without_course_theme" };
}

/** MathML, and the images Canvas saves in place of an equation. */
function equationSignal(elements) {
  const math = [];
  const images = [];
  for (const element of elements) {
    if (element.tag === "math") {
      math.push({ element_index: element.index, alttext_declared: collapse(attribute(element, "alttext")) !== "" });
      continue;
    }
    if (element.tag !== "img") continue;
    const classes = collapse(attribute(element, "class")).toLowerCase().split(" ");
    const signal = classes.includes("equation_image")
      ? "equation_image_class"
      : hasAttribute(element, "data-equation-content")
        ? "data_equation_content_attribute"
        : /\/equation_images\//.test(attribute(element, "src") ?? "")
          ? "equation_images_path"
          : "";
    if (signal) images.push({ element_index: element.index, signal, alt_text_declared: collapse(attribute(element, "alt")) !== "" });
  }
  return {
    status: "observed",
    ...list("mathml_elements", math),
    ...list("equation_images", images),
    rendered_equation: "not_determinable_without_course_theme",
  };
}

/** Track kinds and declared controls for each media element. */
function mediaPlayerSignal(elements, children) {
  const players = [];
  const frames = [];
  for (const element of elements) {
    if (EMBEDDED_FRAME_TAGS.has(element.tag)) frames.push({ element_index: element.index, tag: element.tag });
    if (!MEDIA_PLAYER_TAGS.has(element.tag)) continue;
    const tracks = (children.get(element.index) ?? [])
      .filter((child) => child.tag === "track")
      // HTML treats a track with no kind as subtitles.
      .map((child) => collapse(attribute(child, "kind")).toLowerCase() || "subtitles");
    players.push({
      element_index: element.index,
      tag: element.tag,
      controls_declared: hasAttribute(element, "controls"),
      track_kinds: tracks.slice(0, MAX_RENDER_CHECK_ENTRIES),
      track_count: tracks.length,
    });
  }
  return {
    status: "observed",
    ...list("players", players),
    ...list("embedded_frames", frames),
    player_controls: "not_determinable_without_course_theme",
  };
}

/**
 * Contrast for the pairs this field states outright. A ratio is reported only
 * when the foreground colour is in an inline `style` on the element and the
 * background colour is in an inline `style` on that element or on an explicit
 * ancestor. Everything else depends on the course theme and is reported as not
 * determinable rather than assumed to be black on white.
 */
function contrastSignal(elements) {
  const byIndex = new Map(elements.map((element) => [element.index, element]));
  const declared = new Map();
  for (const element of elements) {
    const style = attribute(element, "style");
    if (style === undefined) continue;
    const properties = inlineStyleDeclarations(style);
    const background = properties["background-color"] ?? properties.background;
    declared.set(element.index, {
      ...(properties.color === undefined ? {} : { foreground: { rgb: cssColorToRgb(properties.color) } }),
      ...(background === undefined ? {} : { background: { rgb: cssColorToRgb(background) } }),
    });
  }
  const evaluated = [];
  const notDeterminable = [];
  for (const element of elements) {
    const own = declared.get(element.index);
    if (!own) continue;
    if (!own.foreground) {
      if (own.background) notDeterminable.push({ element_index: element.index, reason: "foreground_colour_not_declared_inline" });
      continue;
    }
    if (!own.foreground.rgb) {
      notDeterminable.push({ element_index: element.index, reason: "foreground_colour_not_resolvable_from_saved_source" });
      continue;
    }
    let ancestorIndex = element.index;
    let background;
    while (ancestorIndex > 0) {
      const candidate = declared.get(ancestorIndex)?.background;
      if (candidate) { background = { index: ancestorIndex, rgb: candidate.rgb }; break; }
      ancestorIndex = byIndex.get(ancestorIndex)?.parent ?? 0;
    }
    if (!background) {
      notDeterminable.push({ element_index: element.index, reason: "background_colour_not_declared_inline" });
      continue;
    }
    if (!background.rgb) {
      notDeterminable.push({ element_index: element.index, reason: "background_colour_not_resolvable_from_saved_source" });
      continue;
    }
    evaluated.push({
      element_index: element.index,
      background_element_index: background.index,
      contrast_ratio: contrastRatio(own.foreground.rgb, background.rgb),
    });
  }
  return {
    status: "partial",
    ...list("evaluated", evaluated),
    ...list("not_determinable_without_course_theme", notDeterminable),
    text_size: "not_determinable_without_course_theme",
    minimum_ratio_threshold: "not_applied_without_text_size",
  };
}

/** The checks a detached document cannot settle, each named with its reason. */
const NOT_DETERMINABLE = Object.freeze([
  Object.freeze({ check: "colour_contrast", reason: "Only colours stated in an inline style on the element or an explicit ancestor are resolvable here. Every other colour comes from the course theme." }),
  Object.freeze({ check: "text_size_threshold", reason: "Large-text contrast thresholds need the rendered font size, which the course theme sets." }),
  Object.freeze({ check: "focus_visibility", reason: "A focus indicator is painted by the course theme and cannot be seen in a detached document." }),
  Object.freeze({ check: "rendered_focus_order", reason: "Real tab order also depends on rendered visibility and on the Canvas page around this field." }),
  Object.freeze({ check: "media_player_controls", reason: "Canvas replaces media markup with its own player, so declared controls are not the learner's controls." }),
  Object.freeze({ check: "equation_rendering", reason: "Canvas renders equations through its own MathJax setup, which is not present here." }),
  Object.freeze({ check: "table_reading_order", reason: "Whether a header association is correct for a complex table is a human judgment." }),
  Object.freeze({ check: "assistive_technology_output", reason: "What a screen reader announces is decided by the browser and the assistive technology, not by this markup alone." }),
]);

/**
 * The complete record for one saved HTML field, computed from the element list
 * only. Deterministic: the same element list always produces the same record.
 */
export function renderCheckSignals(elements, options = {}) {
  const children = childMap(elements);
  const byId = new Map();
  for (const element of elements) {
    const id = collapse(attribute(element, "id"));
    if (id && !byId.has(id)) byId.set(id, element);
  }
  const { names, links } = accessibleNameSignal(elements, children, byId);
  const truncated = options.truncated === true;
  return {
    schema: RENDER_CHECK_SCHEMA,
    status: truncated ? "evidence_incomplete" : "observed",
    evidence_class: "saved_source_render_signal_live_unverified",
    ...(typeof options.field === "string" && options.field ? { field: options.field } : {}),
    ...(Number.isSafeInteger(options.sourceCharacterCount) ? { source_character_count: options.sourceCharacterCount } : {}),
    element_count: elements.length,
    truncated,
    ...(truncated ? { truncated_reason: "This field has more elements or deeper nesting than one render check reads, so every list below is incomplete for it." } : {}),
    focus_order: focusOrderSignal(elements),
    accessible_names: names,
    duplicate_link_text: duplicateLinkTextSignal(links),
    tables: tableSignal(elements, children),
    equations: equationSignal(elements),
    media_players: mediaPlayerSignal(elements, children),
    contrast: contrastSignal(elements),
    not_determinable_without_course_theme: NOT_DETERMINABLE.map((entry) => ({ ...entry })),
    interpretation: INTERPRETATION,
  };
}

/**
 * The one saved HTML field a Canvas read carries, by the documented order. It
 * returns nothing when the record holds no readable HTML field, so an aggregate
 * or a list read never starts a render check.
 */
export function renderCheckField(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  for (const field of RENDER_CHECK_FIELDS) {
    const [head, tail] = field.split(".");
    const parent = tail === undefined ? data : data[head];
    if (!parent || typeof parent !== "object" || Array.isArray(parent)) continue;
    const value = tail === undefined ? data[head] : parent[tail];
    if (typeof value === "string" && value.trim() !== "") return { field, value };
  }
  return undefined;
}

/** One saved field this check did not read, stated as a refusal rather than a result. */
export function renderCheckNotObserved(field, reason, detail, sourceCharacterCount) {
  return {
    schema: RENDER_CHECK_SCHEMA,
    status: "not_observed",
    evidence_class: "saved_source_render_signal_live_unverified",
    ...(typeof field === "string" && field ? { field } : {}),
    ...(Number.isSafeInteger(sourceCharacterCount) ? { source_character_count: sourceCharacterCount } : {}),
    reason,
    detail,
    interpretation: INTERPRETATION,
  };
}

/** Parses one saved HTML field into a detached document and returns its record. */
export function renderCheckRecord(html, field, parser) {
  const source = typeof html === "string" ? html : "";
  if (source.length > MAX_RENDER_CHECK_SOURCE_CHARS) {
    return renderCheckNotObserved(
      field,
      "render_check_source_exceeds_limit",
      `This saved field is longer than ${MAX_RENDER_CHECK_SOURCE_CHARS} characters, so Morrow ran no render check on it. This is not a passed check.`,
      source.length,
    );
  }
  // A DOMParser document has no browsing context, so it loads no image, media,
  // stylesheet or script. The sandbox content security policy forbids those
  // loads a second time.
  const document = parser.parseFromString(source, "text/html");
  const { elements, truncated } = collectRenderElements(document);
  return renderCheckSignals(elements, { field, truncated, sourceCharacterCount: source.length });
}

/**
 * The sandbox side of the bridge. The page has an opaque origin, so it answers
 * with `"*"` and the caller checks the frame identity instead; the record
 * carries no course text, so nothing here depends on that answer being private.
 */
export function installRenderCheckListener(scope) {
  scope.addEventListener("message", (event) => {
    const request = event.data;
    if (event.source !== scope.parent || request?.schema !== RENDER_CHECK_REQUEST_SCHEMA || typeof request.requestId !== "string") return;
    let record;
    try {
      record = renderCheckRecord(request.html, request.field, new scope.DOMParser());
    } catch {
      record = renderCheckNotObserved(
        request.field,
        "render_check_unavailable",
        "Morrow could not parse this saved field into a document, so it ran no render check. This is not a passed check.",
      );
    }
    scope.parent.postMessage({ schema: RENDER_CHECK_REPLY_SCHEMA, requestId: request.requestId, record }, "*");
  });
}

if (typeof globalThis.DOMParser === "function" && globalThis.parent && globalThis.parent !== globalThis) {
  installRenderCheckListener(globalThis);
}
