import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

// The workflows live at the repository root, one level above the desktop product.
const workflows = new URL("../../../.github/workflows/", import.meta.url);

/** Every `uses:` line in every workflow, with where it is. */
const references = readdirSync(workflows)
  .filter((name) => /\.ya?ml$/.test(name))
  .flatMap((name) => readFileSync(new URL(name, workflows), "utf8").split("\n")
    .map((text, index) => ({ where: `${name}:${index + 1}`, text }))
    .filter(({ text }) => /^\s*(?:- )?uses:/.test(text)));

// A commit pin cannot move under a workflow, and the release comment beside it is what
// Dependabot rewrites with each update, so a reviewer reads the release and not only a hash.
const PIN = /^\s*(?:- )?uses: ([\w.-]+\/[\w.-]+)@([0-9a-f]{40}) # (v\d+\.\d+\.\d+)$/;

test("every workflow action is pinned to a full commit and names its release", () => {
  assert.ok(references.length > 0, "the workflows use no actions");
  for (const { where, text } of references) {
    assert.match(text, PIN, `${where} must read "uses: owner/action@<40-character commit> # vX.Y.Z"`);
  }
});

test("each action runs at one commit and one release in every workflow", () => {
  const pins = new Map();
  for (const { where, text } of references) {
    const match = PIN.exec(text);
    if (!match) continue;
    const [, action, commit, release] = match;
    const pin = `${commit} ${release}`;
    const first = pins.get(action);
    if (first) assert.equal(pin, first.pin, `${where} pins ${action} differently from ${first.where}`);
    else pins.set(action, { pin, where });
  }
});
