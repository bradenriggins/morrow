import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  MAX_RENDER_CHECK_ELEMENTS,
  MAX_RENDER_CHECK_SOURCE_CHARS,
  RENDER_CHECK_SCHEMA,
  accessibleName,
  collectRenderElements,
  contrastRatio,
  cssColorToRgb,
  inlineStyleDeclarations,
  relativeLuminance,
  renderCheckField,
  renderCheckRecord,
  renderCheckSignals,
} from "../../connector/extension/render-check/render-check.js";

/**
 * The smallest document surface `collectRenderElements` reads: element nodes
 * with attributes and child nodes, and text nodes with data. The sandbox hands
 * it a real detached document; these fixtures hand it the same shape so the
 * pure computation runs here exactly as it runs there.
 */
function el(tag, attributes = {}, children = []) {
  return {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    attributes: Object.entries(attributes).map(([name, value]) => ({ name, value })),
    childNodes: children.map((child) => (typeof child === "string" ? { nodeType: 3, data: child } : child)),
  };
}

const fragment = (...children) => ({ childNodes: children });

function record(...children) {
  const { elements, truncated } = collectRenderElements(fragment(...children));
  return renderCheckSignals(elements, { field: "body", truncated, sourceCharacterCount: 100 });
}

function names(...children) {
  const { elements } = collectRenderElements(fragment(...children));
  const children_ = new Map();
  for (const element of elements) {
    const siblings = children_.get(element.parent);
    if (siblings) siblings.push(element);
    else children_.set(element.parent, [element]);
  }
  const byId = new Map();
  for (const element of elements) {
    const id = element.attributes.id;
    if (id && !byId.has(id)) byId.set(id, element);
  }
  return { elements, children: children_, byId };
}

test("the element walk keeps DOM order, parent links, lower-cased names and each element's own text", () => {
  const { elements, truncated } = collectRenderElements(fragment(
    el("DIV", { CLASS: "Wrap", "DATA-X": "1" }, ["before", el("p", {}, ["inner"]), "after"]),
    el("hr"),
  ));
  assert.equal(truncated, false);
  assert.deepEqual(elements.map((element) => [element.index, element.tag, element.parent]), [
    [1, "div", 0], [2, "p", 1], [3, "hr", 0],
  ]);
  assert.deepEqual(elements[0].attributes, { class: "Wrap", "data-x": "1" });
  assert.equal(elements[0].text, "beforeafter");
  assert.equal(elements[1].text, "inner");
});

test("a document with more elements than one check reads is reported incomplete, not silently short", () => {
  const many = Array.from({ length: MAX_RENDER_CHECK_ELEMENTS + 5 }, () => el("span"));
  const result = record(...many);
  assert.equal(result.element_count, MAX_RENDER_CHECK_ELEMENTS);
  assert.equal(result.truncated, true);
  assert.equal(result.status, "evidence_incomplete");
  assert.match(result.truncated_reason, /incomplete/);
});

test("inline style declarations are read by lower-cased property name", () => {
  assert.deepEqual(inlineStyleDeclarations(" COLOR : #fff ; background-color:#000;;bad"), { color: "#fff", "background-color": "#000" });
  assert.deepEqual(inlineStyleDeclarations(undefined), {});
});

test("a CSS colour resolves only when the saved source states it exactly", () => {
  assert.deepEqual(cssColorToRgb("#fff"), [255, 255, 255]);
  assert.deepEqual(cssColorToRgb("#010203"), [1, 2, 3]);
  assert.deepEqual(cssColorToRgb("#010203ff"), [1, 2, 3]);
  assert.deepEqual(cssColorToRgb("rgb(10, 20, 30)"), [10, 20, 30]);
  assert.deepEqual(cssColorToRgb("rgb(10 20 30 / 1)"), [10, 20, 30]);
  assert.deepEqual(cssColorToRgb("rgba(10,20,30,1.0)"), [10, 20, 30]);
  assert.deepEqual(cssColorToRgb("rgb(100%, 0%, 0%)"), [255, 0, 0]);
  assert.deepEqual(cssColorToRgb("Navy"), [0, 0, 128]);
  // Each of these needs something this check does not have: what is painted
  // behind the element, a browser's own keyword table, or the course theme.
  for (const value of ["rgba(0,0,0,0.5)", "#0102030a", "transparent", "currentColor", "var(--brand)", "hsl(0 0% 0%)", "rebeccapurple", ""]) {
    assert.equal(cssColorToRgb(value), null, value);
  }
});

test("contrast follows the WCAG relative-luminance formula", () => {
  assert.equal(relativeLuminance([0, 0, 0]), 0);
  assert.equal(relativeLuminance([255, 255, 255]), 1);
  assert.equal(contrastRatio([0, 0, 0], [255, 255, 255]), 21);
  assert.equal(contrastRatio([255, 255, 255], [255, 255, 255]), 1);
  assert.equal(contrastRatio([0x76, 0x76, 0x76], [255, 255, 255]), 4.54);
  assert.equal(contrastRatio([255, 255, 255], [0x76, 0x76, 0x76]), 4.54);
});

test("only a positive tabindex is reported as focus reordering", () => {
  const natural = record(el("a", { href: "/a" }, ["A"]), el("button", {}, ["B"]), el("input", { type: "text" }));
  assert.equal(natural.focus_order.focusable_count, 3);
  assert.equal(natural.focus_order.positive_tabindex_count, 0);
  assert.deepEqual(natural.focus_order.reordered_by_positive_tabindex, []);
  assert.equal(natural.focus_order.rendered_focus_order, "not_determinable_without_course_theme");

  const reordered = record(el("a", { href: "/a" }, ["A"]), el("button", { tabindex: "2" }, ["B"]), el("button", { tabindex: "1" }, ["C"]));
  assert.equal(reordered.focus_order.positive_tabindex_count, 2);
  // The second button already sits where its positive tabindex puts it, so it
  // is not a reordering; only the two elements that move are reported.
  assert.deepEqual(reordered.focus_order.reordered_by_positive_tabindex, [
    { element_index: 3, dom_position: 3, tabindex: 1, tab_position: 1 },
    { element_index: 1, dom_position: 1, tabindex: null, tab_position: 3 },
  ]);
});

test("an element removed from the tab order or disabled is not counted as focusable", () => {
  const result = record(
    el("a", { href: "/a", tabindex: "-1" }, ["A"]),
    el("button", { disabled: "" }, ["B"]),
    el("a", {}, ["no destination"]),
    el("input", { type: "hidden" }),
    el("div", { tabindex: "0" }, ["custom"]),
    el("video", { controls: "" }),
    el("video", {}),
  );
  assert.equal(result.focus_order.focusable_count, 2);
});

test("accessible names follow aria-labelledby, aria-label, text content, then title", () => {
  const { elements, children, byId } = names(
    el("span", { id: "label" }, ["Named by reference"]),
    el("a", { href: "/one", "aria-labelledby": "label" }, ["Ignored"]),
    el("a", { href: "/two", "aria-label": "From aria-label", title: "Ignored" }, ["Ignored"]),
    el("a", { href: "/three", title: "Ignored" }, ["From text"]),
    el("a", { href: "/four", title: "From title" }),
    el("a", { href: "/five" }),
    el("a", { href: "/six", "aria-labelledby": "absent" }, []),
    el("a", { href: "/seven" }, [el("img", { alt: "From image alternative text" })]),
  );
  const source = (index) => accessibleName(elements[index - 1], children, byId);
  assert.deepEqual(source(2), { source: "aria_labelledby", text: "Named by reference" });
  assert.equal(source(3).source, "aria_label");
  assert.deepEqual(source(4), { source: "text_content", text: "From text" });
  assert.deepEqual(source(5), { source: "title", text: "From title" });
  assert.deepEqual(source(6), { source: "none", text: "" });
  assert.deepEqual(source(7), { source: "aria_labelledby_reference_unresolved", text: "" });
  assert.deepEqual(source(8), { source: "text_content", text: "From image alternative text" });
});

test("every link and button is named, and the ones with no name are listed", () => {
  const result = record(
    el("a", { href: "/a" }, ["Read the syllabus"]),
    el("button"),
    el("span", { role: "button", "aria-label": "Play" }),
    el("input", { type: "submit", value: "Send" }),
    el("span", { role: "link" }, ["Custom link"]),
    el("p", {}, ["not a control"]),
  );
  assert.deepEqual(result.accessible_names.entries, [
    { element_index: 1, element_kind: "link", name_source: "text_content", name_character_count: 17 },
    { element_index: 2, element_kind: "button", name_source: "none", name_character_count: 0 },
    { element_index: 3, element_kind: "button", name_source: "aria_label", name_character_count: 4 },
    { element_index: 4, element_kind: "button", name_source: "text_content", name_character_count: 4 },
    { element_index: 5, element_kind: "link", name_source: "text_content", name_character_count: 11 },
  ]);
  assert.deepEqual(result.accessible_names.without_accessible_name, [
    { element_index: 2, element_kind: "button" },
  ]);
  assert.deepEqual(result.accessible_names.precedence, ["aria-labelledby", "aria-label", "text content", "title"]);
  assert.equal(result.accessible_names.assistive_technology_output, "not_determinable_without_course_theme");
});

test("links that read alike but lead somewhere different are grouped without their text or URLs", () => {
  const result = record(
    el("a", { href: "/one" }, ["Read more"]),
    el("a", { href: "/two" }, ["read MORE"]),
    el("a", { href: "/three" }, ["Read more"]),
    el("a", { href: "/four" }, ["Syllabus"]),
    el("a", { href: "/four" }, ["Syllabus"]),
  );
  assert.deepEqual(result.duplicate_link_text.groups, [
    { group_index: 1, link_element_indexes: [1, 2, 3], distinct_destination_count: 3 },
  ]);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("Read more"), false);
  assert.equal(serialized.includes("/one"), false);
});

test("table header association is reported per table, with unresolved headers references counted", () => {
  const result = record(
    el("table", {}, [el("tr", {}, [el("th", { scope: "col" }, ["A"]), el("th", {}, ["B"]), el("td", { headers: "a1 missing" }, ["1"])])]),
    el("table", {}, [el("tr", {}, [el("td", {}, ["plain"])])]),
    el("table", {}, [el("tr", {}, [
      el("th", { id: "h1" }, ["Outer"]),
      el("td", { headers: "h1" }, [el("table", {}, [el("tr", {}, [el("th", { scope: "row" }, ["Inner"])])])]),
    ])]),
  );
  assert.deepEqual(result.tables.tables, [
    { element_index: 1, header_cell_count: 2, header_cells_with_scope: 1, header_cells_without_scope: 1, cells_with_headers_attribute: 1, unresolved_headers_references: 2, association: "scope_and_headers_ids" },
    { element_index: 6, header_cell_count: 0, header_cells_with_scope: 0, header_cells_without_scope: 0, cells_with_headers_attribute: 0, unresolved_headers_references: 0, association: "no_header_cells" },
    { element_index: 9, header_cell_count: 1, header_cells_with_scope: 0, header_cells_without_scope: 1, cells_with_headers_attribute: 1, unresolved_headers_references: 0, association: "headers_ids" },
    { element_index: 13, header_cell_count: 1, header_cells_with_scope: 1, header_cells_without_scope: 0, cells_with_headers_attribute: 0, unresolved_headers_references: 0, association: "scope" },
  ]);
  assert.equal(result.tables.reading_order, "not_determinable_without_course_theme");
});

test("MathML and the images Canvas saves in place of an equation are both reported", () => {
  const result = record(
    el("math", { alttext: "x squared" }),
    el("math"),
    el("img", { class: "equation_image middle", src: "/equation_images/x%5E2", alt: "x^2" }),
    el("img", { "data-equation-content": "x^2", src: "/files/1" }),
    el("img", { src: "/equation_images/y" }),
    el("img", { src: "/files/2", alt: "A cell" }),
  );
  assert.deepEqual(result.equations.mathml_elements, [
    { element_index: 1, alttext_declared: true },
    { element_index: 2, alttext_declared: false },
  ]);
  assert.deepEqual(result.equations.equation_images, [
    { element_index: 3, signal: "equation_image_class", alt_text_declared: true },
    { element_index: 4, signal: "data_equation_content_attribute", alt_text_declared: false },
    { element_index: 5, signal: "equation_images_path", alt_text_declared: false },
  ]);
  assert.equal(result.equations.rendered_equation, "not_determinable_without_course_theme");
});

test("track kinds and declared controls are reported for each media element", () => {
  const result = record(
    el("video", { controls: "" }, [el("track", { kind: "CAPTIONS" }), el("track", {}), el("source", { src: "/v.mp4" })]),
    el("audio", {}, []),
    el("iframe", { src: "/embed", title: "Player" }),
    el("object", { data: "/o" }),
  );
  assert.deepEqual(result.media_players.players, [
    { element_index: 1, tag: "video", controls_declared: true, track_kinds: ["captions", "subtitles"], track_count: 2 },
    { element_index: 5, tag: "audio", controls_declared: false, track_kinds: [], track_count: 0 },
  ]);
  assert.deepEqual(result.media_players.embedded_frames, [
    { element_index: 6, tag: "iframe" },
    { element_index: 7, tag: "object" },
  ]);
  assert.equal(result.media_players.player_controls, "not_determinable_without_course_theme");
});

test("a contrast ratio is reported only for colours the saved field states outright", () => {
  const result = record(
    el("div", { style: "background-color:#ffffff" }, [
      el("p", { style: "color:#767676" }, ["inherits the declared background"]),
      el("p", { style: "color:#000000;background:#ffffff" }, ["states both"]),
      el("p", { style: "color:var(--brand)" }, ["theme colour"]),
    ]),
    el("p", { style: "color:#333333" }, ["no declared background anywhere above"]),
    el("p", { style: "background-color:#eeeeee" }, ["background only"]),
    el("p", { style: "color:#111111;background-color:rgba(0,0,0,0.5)" }, ["translucent background"]),
  );
  assert.deepEqual(result.contrast.evaluated, [
    { element_index: 2, background_element_index: 1, contrast_ratio: 4.54 },
    { element_index: 3, background_element_index: 3, contrast_ratio: 21 },
  ]);
  assert.deepEqual(result.contrast.not_determinable_without_course_theme, [
    { element_index: 1, reason: "foreground_colour_not_declared_inline" },
    { element_index: 4, reason: "foreground_colour_not_resolvable_from_saved_source" },
    { element_index: 5, reason: "background_colour_not_declared_inline" },
    { element_index: 6, reason: "foreground_colour_not_declared_inline" },
    { element_index: 7, reason: "background_colour_not_resolvable_from_saved_source" },
  ]);
  assert.equal(result.contrast.status, "partial");
  assert.equal(result.contrast.text_size, "not_determinable_without_course_theme");
  assert.equal(result.contrast.minimum_ratio_threshold, "not_applied_without_text_size");
});

test("every check that needs the real course theme is named as not determinable", () => {
  const result = record(el("p", {}, ["text"]));
  assert.deepEqual(result.not_determinable_without_course_theme.map((entry) => entry.check), [
    "colour_contrast", "text_size_threshold", "focus_visibility", "rendered_focus_order",
    "media_player_controls", "equation_rendering", "table_reading_order", "assistive_technology_output",
  ]);
  for (const entry of result.not_determinable_without_course_theme) assert.match(entry.reason, /\S/);
  assert.equal(result.schema, RENDER_CHECK_SCHEMA);
  assert.equal(result.status, "observed");
  assert.equal(result.evidence_class, "saved_source_render_signal_live_unverified");
  assert.match(result.interpretation, /live-unverified/);
  assert.match(result.interpretation, /not a violation/);
  assert.equal(/conformance/.test(result.interpretation), true);
});

test("the one saved HTML field a Canvas read carries is chosen by the documented order", () => {
  assert.deepEqual(renderCheckField({ body: "<p>page</p>", description: "<p>other</p>" }), { field: "body", value: "<p>page</p>" });
  assert.deepEqual(renderCheckField({ message: "<p>topic</p>" }), { field: "message", value: "<p>topic</p>" });
  assert.deepEqual(renderCheckField({ instructions: "<p>quiz</p>", description: "<p>other</p>" }), { field: "instructions", value: "<p>quiz</p>" });
  assert.deepEqual(renderCheckField({ description: "", long_description: "<p>rubric</p>" }), { field: "long_description", value: "<p>rubric</p>" });
  assert.deepEqual(renderCheckField({ entry: { item_body: "<p>item</p>" } }), { field: "entry.item_body", value: "<p>item</p>" });
  assert.deepEqual(renderCheckField({ entry: { body: "<p>stimulus</p>" } }), { field: "entry.body", value: "<p>stimulus</p>" });
  // Aggregate reads, list reads and records with no readable HTML field start no render check.
  assert.equal(renderCheckField({ id: "42", name: "Course" }), undefined);
  assert.equal(renderCheckField({ body: "   " }), undefined);
  assert.equal(renderCheckField([{ body: "<p>x</p>" }]), undefined);
  assert.equal(renderCheckField(null), undefined);
});

test("the record binds itself to the field and the exact length it read", () => {
  const html = '<p style="color:#000;background:#fff">Cells have membranes.</p>';
  const parser = { parseFromString: () => fragment(el("p", { style: "color:#000;background:#fff" }, ["Cells have membranes."])) };
  const result = renderCheckRecord(html, "body", parser);
  assert.equal(result.status, "observed");
  assert.equal(result.field, "body");
  assert.equal(result.source_character_count, html.length);
  assert.equal(result.element_count, 1);
});

test("a field longer than one render check reads is refused, not reported as a pass", () => {
  const parser = { parseFromString: () => { throw new Error("must not parse an oversized field"); } };
  const result = renderCheckRecord("x".repeat(MAX_RENDER_CHECK_SOURCE_CHARS + 1), "body", parser);
  assert.equal(result.schema, RENDER_CHECK_SCHEMA);
  assert.equal(result.status, "not_observed");
  assert.equal(result.reason, "render_check_source_exceeds_limit");
  assert.match(result.detail, /not a passed check/);
});

test("the render-check page is declared as the one sandboxed page, with a policy that forbids every load", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../connector/extension/manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.sandbox.pages, ["render-check/render-check.html"]);
  assert.equal(
    manifest.content_security_policy.sandbox,
    "sandbox allow-scripts; default-src 'none'; script-src 'self'; base-uri 'none'; form-action 'none'",
  );
  // The offscreen document only holds that frame. It is not itself sandboxed,
  // because a sandboxed page has no chrome.runtime to answer on.
  assert.equal(manifest.sandbox.pages.includes("render-check/render-check-host.html"), false);
  assert.equal(manifest.permissions.includes("offscreen"), true);
  assert.equal("web_accessible_resources" in manifest, false);
  const page = readFileSync(new URL("../../connector/extension/render-check/render-check.html", import.meta.url), "utf8");
  assert.match(page, /<script type="module" src="\.\/render-check\.js"><\/script>/);
  // Nothing in the sandboxed page may reach outside itself.
  assert.doesNotMatch(page, /\b(?:fetch|XMLHttpRequest|<img|<link|<style|chrome\.)/);
});
