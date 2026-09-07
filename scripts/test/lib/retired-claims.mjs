/**
 * The phrases Morrow retired from every product-facing surface, in one place so the document gate
 * (`scripts/test/product-claims.test.mjs`) and the website gate (`scripts/test/website-content.test.mjs`)
 * cannot drift apart. This file is not a test: `pnpm scripts:test` globs `scripts/test/*.test.mjs`,
 * so it stays out of that glob by living in `lib/` and by keeping `.test.` out of its name.
 *
 * Each phrase named a state or a product that Morrow no longer is:
 * - "Development preview" and "private preview" described the product as a preview. Morrow
 *   `1.0.0-rc.0` is a local release candidate, and its verification controls (the named test
 *   courses) are evidence, not a rule about which courses a person may connect.
 * - "course team" is banned by name in the product-marketing brief; Morrow writes to instructors,
 *   instructional designers, and course reviewers.
 * - "AI app" is banned by `docs/brand/MORROW-BRAND.md`; Morrow connects the assistant a person
 *   already uses.
 * - "Blackboard browser connection" and "Blackboard browser access" describe a route that does not
 *   exist: Blackboard runs through the Anthology Learn REST API with a local credential, and the
 *   Chrome connector never connects a Blackboard course page.
 */
export const RETIRED_PHRASES = [
  "Development preview",
  "course team",
  "AI app",
  "private preview",
  "Blackboard browser connection",
  "Blackboard browser access",
];

/** A prohibition needs both parts: something forbidden, and the act of writing or saying it. */
const PROHIBITION_WORD = /\b(never|not|no longer|avoid|avoids|retired|banned|forbidden)\b/i;
const SPEECH_VERB = /\b(call|calls|called|use|uses|used|say|says|write|writes|describe|describes|name|names|label|labels|term|terms|phrase|phrases|word|words|wording|copy)\b/i;

const OPENING_QUOTE = /["“'‘`]$/;
const CLOSING_QUOTE = /^[.,;:!?]?["”'’`]/;

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The sentence that holds `index`. Sentences end at closing punctuation with any trailing quote, or
 * at a line break, so a Markdown list item or a heading is its own sentence.
 */
function sentenceAround(text, index, length) {
  const before = text.slice(0, index);
  const opened = [...before.matchAll(/[.!?]["”’')\]]*\s+|\n/g)].pop();
  const start = opened ? opened.index + opened[0].length : 0;
  const after = text.slice(index + length);
  const closed = after.match(/[.!?]["”’')\]]*(?=\s|$)|\n/);
  const end = index + length + (closed ? closed.index + closed[0].length : after.length);
  return { text: text.slice(start, end), offset: index - start };
}

/**
 * True when the sentence quotes the phrase in order to forbid it, as
 * `docs/brand/MORROW-BRAND.md` does with “AI app”. A document may name a retired phrase only that
 * way: quoted, inside a sentence that tells a writer not to use it.
 */
function quotesToForbid(sentence, offset, length) {
  if (!PROHIBITION_WORD.test(sentence) || !SPEECH_VERB.test(sentence)) return false;
  return OPENING_QUOTE.test(sentence.slice(0, offset)) && CLOSING_QUOTE.test(sentence.slice(offset + length));
}

/**
 * Every retired phrase in `text`, with the line and the sentence that carries it. Matching is
 * case-insensitive and accepts a plural, so "course teams" fails the same way "course team" does.
 * Returns an empty array for text that uses none of them.
 */
export function findRetiredPhrases(text) {
  const hits = [];
  for (const phrase of RETIRED_PHRASES) {
    const pattern = new RegExp(`\\b${escapeForRegExp(phrase)}s?\\b`, "gi");
    for (const match of text.matchAll(pattern)) {
      const sentence = sentenceAround(text, match.index, match[0].length);
      if (quotesToForbid(sentence.text, sentence.offset, match[0].length)) continue;
      hits.push({
        phrase,
        line: text.slice(0, match.index).split("\n").length,
        sentence: sentence.text.replace(/\s+/g, " ").trim(),
      });
    }
  }
  return hits.sort((left, right) => left.line - right.line);
}
