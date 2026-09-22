import sanitizeHtml from "sanitize-html";

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
    nonTextTags: ["script", "style", "textarea", "option", "noscript"],
    transformTags: {
      img: (tag, attributes) => /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/=\s]+$/i.test(attributes.src || "")
        ? { tagName: tag, attribs: { src: attributes.src!, alt: attributes.alt || "" } } : media(tag, attributes),
      iframe: media, video: media, audio: media, object: media, embed: media,
    },
  });
  return `<div class="formatted-preview"${label ? ` role="region" aria-label="${escapeHtml(label)} preview"` : ""}>${html || `<p class="preview-note">${value.trim() ? "This content cannot be shown in the preview." : "The proposed content is blank."}</p>`}</div>${mediaHidden ? '<p class="preview-note">External images and media are not loaded in this preview.</p>' : ""}`;
}
