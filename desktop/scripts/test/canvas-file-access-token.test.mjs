// New Quizzes stores every course image as an inst-fs URL signed with a `token`
// query value, and signs a new one on every read. Left in, that credential made
// Morrow's privacy boundary refuse every New Quiz holding an image, and it would
// make every guarded edit of such a question stale, because the question never
// reads the same twice. Both in-page executors remove it from each answer.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "../..");
const sources = {
  canvas: readFileSync(resolve(root, "connector/extension/src/canvas-content.js"), "utf8"),
  itemBank: readFileSync(resolve(root, "connector/extension/src/item-bank-executor.js"), "utf8"),
  quizBankDraw: readFileSync(resolve(root, "connector/extension/src/quiz-bank-draw-executor.js"), "utf8"),
};

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is defined`);
  let depth = 0;
  for (let index = source.indexOf("{", start); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} is unterminated`);
}

const copies = Object.fromEntries(Object.entries(sources).map(([name, source]) => {
  const text = functionSource(source, "withoutFileAccessTokens");
  return [name, { text, run: new Function(`${text}\nreturn withoutFileAccessTokens;`)() }];
}));

const JWT = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJyZXNvdXJjZSI6Ii9maWxlcyJ9.c2lnbmF0dXJlLXZhbHVl_-";
const HOST = "https://inst-fs-iad-prod.inscloudgate.net/files/ab586f32-0f38-4b5d-8032-0a5a0e2271c6/217W1-1.PNG";

test("every executor carries the same rule", () => {
  assert.equal(copies.canvas.text, copies.itemBank.text);
  assert.equal(copies.canvas.text, copies.quizBankDraw.text);
});

for (const [name, { run }] of Object.entries(copies)) {
  test(`${name}: the signed token leaves a New Quiz answer exactly as Canvas wrote it`, () => {
    // The shape Canvas returns: JSON with the HTML escaped inside a string.
    const answer = JSON.stringify({ entry: { item_body: `<p>Which cell? <img src="${HOST}?token=${JWT}" data-old-link="/courses/1/files/2/preview"></p>` } })
      .replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
    const cleaned = run(answer);
    assert.doesNotMatch(cleaned, /token=/);
    assert.equal(JSON.parse(cleaned).entry.item_body, `<p>Which cell? <img src="${HOST}" data-old-link="/courses/1/files/2/preview"></p>`);
  });

  test(`${name}: two reads that differ only by their signature read the same`, () => {
    const read = (signature) => JSON.stringify({ body: `<img src="${HOST}?token=${signature}">` });
    assert.equal(run(read("eyJhIjoxfQ.one.sig1")), run(read("eyJhIjoxfQ.two.sig2")));
  });

  test(`${name}: every other query value on the file URL is kept`, () => {
    assert.equal(run(`<img src="${HOST}?token=${JWT}&amp;w=200">`), `<img src="${HOST}?w=200">`);
    assert.equal(run(`<img src="${HOST}?w=200&amp;token=${JWT}">`), `<img src="${HOST}?w=200">`);
    assert.equal(run(`<img src="${HOST}?w=200&amp;token=${JWT}&amp;h=9">`), `<img src="${HOST}?w=200&amp;h=9">`);
    assert.equal(run(JSON.stringify(`${HOST}?w=1&token=${JWT}`).replace("&", "\\u0026")), JSON.stringify(`${HOST}?w=1`));
  });

  test(`${name}: a token on any other host is left for the privacy boundary to refuse`, () => {
    const other = '<a href="https://example.com/reset?token=abc123">reset</a>';
    assert.equal(run(other), other);
    assert.equal(run("no credential here"), "no credential here");
  });
}

test("each executor removes the token where it reads a Canvas answer", () => {
  assert.match(sources.canvas, /return withoutFileAccessTokens\(new TextDecoder\("utf-8", \{ fatal: true \}\)\.decode\(bytes\)\);/);
  assert.match(sources.itemBank, /return \{ text: withoutFileAccessTokens\(text \+ decoder\.decode\(\)\) \};/);
  assert.match(sources.quizBankDraw, /return \{ text: withoutFileAccessTokens\(text \+ decoder\.decode\(\)\) \};/);
});
