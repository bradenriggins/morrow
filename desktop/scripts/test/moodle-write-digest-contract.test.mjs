import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../..", import.meta.url);
const catalog = JSON.parse(readFileSync(
  new URL("connector/extension/generated/moodle-browser-catalog.json", root),
  "utf8",
));

test("every published Moodle write requires the digest of one published review read", () => {
  assert.equal(catalog.schema, "morrow.browser-catalog.v1");
  assert.equal(catalog.provider, "moodle");

  const writes = catalog.operations.filter((operation) => operation.provider === "moodle" && operation.readOnly === false);
  assert.equal(writes.length, 127, "update this count only when the published Moodle write surface changes");

  for (const write of writes) {
    const schema = write.inputSchema;
    assert.equal(schema?.type, "object", write.toolName);
    assert.equal(schema?.additionalProperties, false, write.toolName);
    assert.equal(schema.required?.filter((name) => name === "expected_digest").length, 1, write.toolName);

    const digest = schema.properties?.expected_digest;
    assert.equal(digest?.type, "string", write.toolName);
    assert.equal(digest?.pattern, "^[a-f0-9]{64}$", write.toolName);
    assert.ok(
      Object.keys(digest).every((key) => ["type", "pattern", "description"].includes(key)),
      `${write.toolName} has an unexpected expected_digest schema`,
    );
    if (Object.hasOwn(digest, "description")) {
      assert.match(digest.description, /^The canonical SHA-256 digest of the complete snapshot from moodle_[a-z0-9_]+\.$/, write.toolName);
    }

    assert.match(write.reviewTool || "", /^moodle_[a-z0-9_]+$/, write.toolName);
    const reviews = catalog.operations.filter((operation) => operation.provider === "moodle"
      && operation.readOnly === true && operation.toolName === write.reviewTool);
    assert.equal(reviews.length, 1, `${write.toolName} must resolve one published read-only reviewTool`);
  }
});
