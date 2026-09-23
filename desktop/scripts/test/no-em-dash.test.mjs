import assert from "node:assert/strict";
import { isUtf8 } from "node:buffer";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * No file tracked anywhere in the repository carries an em dash, as the character or as an HTML
 * entity. The scan lists files from the repository root, so the root README, docs/, desktop/ and
 * morrow-for-muse/ are all in it. CI runs this file on every change (ci.yml `check-repository`),
 * because a change to a root document or to Morrow for Muse alone does not run the desktop suite.
 *
 * The one exception is a line in a test file that asserts the dash is absent: it has to name it.
 */
const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const EM_DASH = /\u2014|&(?:mdash|#0*8212|#x0*2014);/iu;
const TEST_FILE = /(?:^|\/)(?:test_[^/]*\.py|[^/]*_(?:self)?test\.py|[^/]*\.test\.[cm]?[jt]s)$/u;
const ABSENCE_ASSERTION = /\bnot in\b|\bassertNotIn\(|\.not\.toContain\(|\bdoesNotMatch\(/u;

function trackedFiles(root) {
  const listed = spawnSync("git", ["-C", root, "ls-files", "-z"], { encoding: "buffer" });
  assert.equal(listed.status, 0, listed.stderr.toString("utf8"));
  return listed.stdout.toString("utf8").split("\0").filter(Boolean);
}

/** Each `path:line` under `root` that carries an em dash outside a test's absence assertion. */
function emDashLines(root, files = trackedFiles(root)) {
  const found = [];
  for (const path of files) {
    const contents = readFileSync(join(root, path));
    if (!isUtf8(contents) || contents.includes(0)) continue;
    const text = contents.toString("utf8");
    if (!EM_DASH.test(text)) continue;
    for (const [index, line] of text.split("\n").entries()) {
      if (!EM_DASH.test(line)) continue;
      if (TEST_FILE.test(path) && ABSENCE_ASSERTION.test(line)) continue;
      found.push(`${path}:${index + 1}`);
    }
  }
  return found;
}

test("the scan finds an em dash in root documents and Morrow for Muse, and passes a test's absence assertion", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "morrow-em-dash-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Built from parts, so this file does not carry the entities it tests for.
  const ENTITY = (name) => `&${name};`;
  const files = {
    "README.md": "Morrow \u2014 for educators.\n",
    "LICENSE": "Copyright\n",
    "docs/products.md": `# Products\n\n<p>One ${ENTITY("mdash")} two.</p>\n`,
    "desktop/renderer.js": `const label = "Plan ${ENTITY("#8212")} asks first";\n`,
    "morrow-for-muse/content/consent.md": "Plain words.\n\nMuse \u2014 Canvas.\n",
    "morrow-for-muse/dispatch/test_messages.py": "def test_plain():\n    assert \"\u2014\" not in message\n",
    "morrow-for-muse/dispatch/messages.py": "MESSAGE = \"a \u2014 b\"  # not in a test file\n",
  };
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  assert.equal(spawnSync("git", ["-C", root, "init", "-q"]).status, 0);
  assert.equal(spawnSync("git", ["-C", root, "add", "."]).status, 0);

  assert.deepEqual(emDashLines(root).sort(), [
    "README.md:1",
    "desktop/renderer.js:1",
    "docs/products.md:3",
    "morrow-for-muse/content/consent.md:3",
    "morrow-for-muse/dispatch/messages.py:1",
  ]);
});

test("no tracked file in the repository contains an em dash", () => {
  const files = trackedFiles(repositoryRoot);
  // The scan must reach every part of the repository, or it passes a part it never read.
  for (const [area, member] of [["the root README", "README.md"], ["docs/", "docs/products.md"], ["desktop/", "desktop/README.md"], ["morrow-for-muse/", "morrow-for-muse/SKILL.md"]]) {
    assert.ok(files.includes(member), `the em dash scan must read ${area}; it did not list ${member}`);
  }
  assert.deepEqual(emDashLines(repositoryRoot, files), [], "replace the em dash with sentence punctuation or a clearer sentence boundary");
});
