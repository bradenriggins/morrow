/**
 * Whether one source line renders `name` as user-facing text. A control name
 * counts only when it stands as a whole word inside a string or template
 * literal, or inside HTML text or an attribute value. An identifier that
 * happens to contain the name (`selectedAssistantId`), a longer word
 * (`Cancelled`), or a comment that mentions the name never qualifies, so a
 * citation can only pass by naming the line the text is written on.
 */
export function renderedOnLine(line, name, { html = false } = {}) {
  const text = String(line ?? "");
  const trimmed = text.trimStart();
  if (!html && (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*"))) return false;
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wholeWord = new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`, "g");
  for (const match of text.matchAll(wholeWord)) {
    const start = match.index;
    const end = start + name.length;
    if (html) {
      if (!insideTag(text, start) || insideAttributeValue(text, start, end)) return true;
      continue;
    }
    if (stringSpans(text).some(([from, to]) => start >= from && end <= to)) return true;
    if (markupText(text, start, end)) return true;
  }
  return false;
}

/** The [start, end) character spans of every string or template literal on the line. */
function stringSpans(text) {
  const spans = [];
  let quote = null;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === "\\") { index += 1; continue; }
      if (character === quote) { spans.push([start, index]); quote = null; }
    } else if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      start = index + 1;
    }
  }
  if (quote) spans.push([start, text.length]);
  return spans;
}

/** Text between a closing `>` and the next `<` inside a multi-line template literal of markup. */
function markupText(text, start, end) {
  const before = text.slice(0, start);
  const open = before.lastIndexOf(">");
  const close = before.lastIndexOf("<");
  if (open === -1 || close === -1 || close > open) return false;
  const after = text.slice(end);
  const nextClose = after.indexOf("<");
  const nextOpen = after.indexOf(">");
  return nextOpen === -1 || (nextClose !== -1 && nextClose < nextOpen);
}

function insideTag(text, position) {
  const before = text.slice(0, position);
  return before.lastIndexOf("<") > before.lastIndexOf(">");
}

function insideAttributeValue(text, start, end) {
  return stringSpans(text).some(([from, to]) => start >= from && end <= to);
}
