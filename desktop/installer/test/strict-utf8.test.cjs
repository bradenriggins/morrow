"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { decodeStrictUtf8, parseStrictJson } = require("../shared/strict-utf8.cjs");

test("desktop trust bytes never gain replacement characters", () => {
  const bytes = Buffer.concat([
    Buffer.from('{"path":"/Users/Braden/Cour'),
    Buffer.from([0xff]),
    Buffer.from('ses"}'),
  ]);

  assert.throws(() => decodeStrictUtf8(bytes, "desktop state"), /desktop state is not valid UTF-8/);
  assert.throws(() => parseStrictJson(bytes, "desktop state"), /desktop state is not valid UTF-8/);
});

test("desktop trust JSON preserves valid Unicode exactly", () => {
  const value = { name: "Biología", path: "/Users/Braden/Courses" };
  const bytes = Buffer.from(JSON.stringify(value), "utf8");

  assert.equal(decodeStrictUtf8(bytes, "desktop state"), JSON.stringify(value));
  assert.deepEqual(parseStrictJson(bytes, "desktop state"), value);
});
