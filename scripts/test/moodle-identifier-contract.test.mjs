import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_MOODLE_JSON_INTEGER,
  normalizedMoodleIdentifierCatalog,
  syncMoodleIdentifierContract,
} from "../sync-moodle-identifier-contract.mjs";

test("the generated Moodle catalog has the exact JavaScript integer contract", () => {
  assert.deepEqual(syncMoodleIdentifierContract({ check: true }).check, true);
});

test("the Moodle catalog generator bounds integer identifiers and preserves bounded controls", () => {
  const source = {
    schema: "morrow.browser-catalog.v1",
    provider: "moodle",
    operations: [{
      inputSchema: {
        type: "object",
        properties: {
          course_id: { type: "integer", minimum: 1 },
          after_page_id: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: 100 },
          visibility: { type: "integer", enum: [0, 1, 2, 3] },
          group_ids: { type: "array", items: { type: "integer", minimum: 1 } },
        },
      },
    }],
  };
  const { catalog, changes } = normalizedMoodleIdentifierCatalog(source);
  const properties = catalog.operations[0].inputSchema.properties;
  assert.equal(changes, 3);
  assert.equal(properties.course_id.maximum, MAX_MOODLE_JSON_INTEGER);
  assert.equal(properties.after_page_id.maximum, MAX_MOODLE_JSON_INTEGER);
  assert.equal(properties.group_ids.items.maximum, MAX_MOODLE_JSON_INTEGER);
  assert.equal(properties.limit.maximum, 100);
  assert.deepEqual(properties.visibility, { type: "integer", enum: [0, 1, 2, 3] });
  assert.equal(source.operations[0].inputSchema.properties.course_id.maximum, undefined);
});
