import sanitizeHtml from "sanitize-html";

/**
 * Library defaults that keep raw text from becoming live markup, plus the tags
 * this process must also treat as non-text. Passing a shorter list replaces
 * the library default, so `xmp` has to stay here.
 */
export const COURSE_HTML_NON_TEXT_TAGS = [
  "script", "style", "textarea", "option", "xmp", "noscript", "template", "annotation-xml", "title",
];

const HIDDEN_STYLE = /(?:display\s*:\s*none|visibility\s*:\s*hidden)(?![\w-])/iu;
const CREDENTIAL_MARK = /(?:^|[^a-z0-9])(?:wstoken|sesskey|verifier|token|cookie)=/iu;

/** A file or webservice URL whose query carries a credential. */
export function textHasCredentialQuery(value: string): boolean {
  return CREDENTIAL_MARK.test(value);
}

function withoutCredentialMarks(value: string): string {
  return value.replace(/[^\s"'<>]*?(?:wstoken|sesskey|verifier|token|cookie)=[^\s"'<>]*/giu, "");
}

function hiddenClassNames(html: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const style of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/giu)) {
    const css = style[1]!.replace(/\/\*[\s\S]*?\*\//gu, "");
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      if (!HIDDEN_STYLE.test(rule[2]!)) continue;
      for (const className of rule[1]!.matchAll(/\.(-?[_a-zA-Z][_a-zA-Z0-9-]*)/gu)) names.add(className[1]!);
    }
  }
  return names;
}

function elementConcealed(tag: string, attribs: sanitizeHtml.Attributes, classes: ReadonlySet<string>): boolean {
  if (tag === "title") return true;
  if (Object.hasOwn(attribs, "hidden")) return true;
  const aria = attribs["aria-hidden"];
  if (typeof aria === "string" && aria.trim().toLocaleLowerCase("en-US") === "true") return true;
  if (typeof attribs.style === "string" && HIDDEN_STYLE.test(attribs.style)) return true;
  const className = attribs.class || "";
  return className.split(/\s+/u).some((name) => classes.has(name));
}

/**
 * Removes hidden course HTML, including the shapes a pre-parse would turn into
 * ordinary text, then keeps only the educational tags. The input is not parsed
 * into a tree first: that parse closes `noscript` at an inner end tag and lets
 * the rest become live markup.
 */
export function sanitizeCourseHtml(value: string): string {
  const classes = hiddenClassNames(value);
  return sanitizeHtml(withoutCredentialMarks(value), {
    allowedTags: ["p", "br", "hr", "div", "span", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "u", "s", "del", "ins", "sub", "sup", "small", "mark", "blockquote", "pre", "code", "kbd", "ul", "ol", "li", "dl", "dt", "dd", "table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td", "figure", "figcaption", "a", "img"],
    allowedAttributes: {
      "*": ["lang", "dir", "title", "role", "aria-label", "data-morrow-hidden"],
      a: ["href", "title"], img: ["src", "alt", "title", "width", "height"],
      ol: ["start", "reversed", "type"], li: ["value"],
      th: ["colspan", "rowspan", "scope"], td: ["colspan", "rowspan"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    nonTextTags: COURSE_HTML_NON_TEXT_TAGS,
    transformTags: {
      "*": (tagName, attribs) => {
        const next = { ...attribs };
        for (const [key, entry] of Object.entries(next)) {
          if (typeof entry === "string" && textHasCredentialQuery(entry)) delete next[key];
        }
        // The allowlist drops style, class, and hidden before the close filter
        // runs, so the concealment decision is recorded on the element first.
        if (elementConcealed(tagName, attribs, classes)) next["data-morrow-hidden"] = "1";
        return { tagName, attribs: next };
      },
    },
    exclusiveFilter: (frame) => frame.attribs["data-morrow-hidden"] === "1",
    textFilter: (text) => withoutCredentialMarks(text),
  });
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function formattedTextPreview(label: string, value: string): string {
  let mediaHidden = false;
  const media: sanitizeHtml.Transformer = (_tag, attributes) => {
    mediaHidden = true;
    return { tagName: "span", attribs: { class: "media-placeholder" }, text: attributes.alt || attributes.title || "Embedded media" };
  };
  const html = sanitizeHtml(value, {
    allowedTags: ["p", "br", "hr", "div", "span", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "u", "s", "del", "ins", "sub", "sup", "small", "mark", "blockquote", "pre", "code", "kbd", "ul", "ol", "li", "dl", "dt", "dd", "table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td", "figure", "figcaption", "a", "img"],
    allowedAttributes: {
      "*": ["lang", "dir"],
      a: ["title"], span: ["class"], img: ["src", "alt"],
      ol: ["start", "reversed", "type"], li: ["value"],
      th: ["colspan", "rowspan", "scope"], td: ["colspan", "rowspan"],
    },
    allowedClasses: { span: ["media-placeholder"] },
    allowedSchemes: [],
    allowedSchemesByTag: { img: ["data"] },
    nonTextTags: COURSE_HTML_NON_TEXT_TAGS,
    transformTags: {
      img: (tag, attributes) => /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/=\s]+$/i.test(attributes.src || "")
        ? { tagName: tag, attribs: { src: attributes.src!, alt: attributes.alt || "" } } : media(tag, attributes),
      iframe: media, video: media, audio: media, object: media, embed: media,
    },
  });
  return `<div class="formatted-preview"${label ? ` role="region" aria-label="${escapeHtml(label)} preview"` : ""}>${html || `<p class="preview-note">${value.trim() ? "This content cannot be shown in the preview." : "The proposed content is blank."}</p>`}</div>${mediaHidden ? '<p class="preview-note">External images and media are not loaded in this preview.</p>' : ""}`;
}
