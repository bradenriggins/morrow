import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";

// Dependabot reads .github/dependabot.yml at the repository root, one level above the desktop
// product, and finds nothing to update in a directory that holds no manifest for its ecosystem.
const repositoryRoot = new URL("../../../", import.meta.url);
const config = readFileSync(new URL(".github/dependabot.yml", repositoryRoot), "utf8");

/** Each `updates` entry: its ecosystem and the text of its block. */
const entries = config.split(/^(?= {2}- package-ecosystem: )/m).slice(1).map((block) => ({
  ecosystem: /^ {2}- package-ecosystem: (\S+)$/m.exec(block)[1],
  block,
}));

/** The directories one entry updates, written as `directory: /x` or as a `directories:` list. */
function directoriesOf(block) {
  const single = /^ {4}directory: (\S+)$/m.exec(block);
  if (single) return [single[1]];
  const list = /^ {4}directories:\n((?: {6}- \S+\n)+)/m.exec(block);
  return list ? [...list[1].matchAll(/^ {6}- (\S+)$/gm)].map((match) => match[1]) : [];
}

/** Each group one entry defines, with its name patterns and update types. */
function groupsOf(block) {
  const groups = /^ {4}groups:\n((?: {6}.*\n)+)/m.exec(block);
  if (!groups) return [];
  return groups[1].split(/^(?= {6}\S)/m).map((group) => ({
    name: /^ {6}(\S+):$/m.exec(group)?.[1],
    patterns: /^ {8}patterns: \[(.*)\]$/m.exec(group)?.[1].split(",").map((value) => value.trim()),
    updateTypes: /^ {8}update-types: \[(.*)\]$/m.exec(group)?.[1].split(",").map((value) => value.trim()).sort(),
  }));
}

/** Whether `directory` holds a manifest Dependabot reads for `ecosystem`. */
function hasManifest(ecosystem, directory) {
  const folder = new URL(`.${directory === "/" ? "/" : `${directory}/`}`, repositoryRoot);
  if (!existsSync(folder)) return false;
  const files = readdirSync(folder);
  if (ecosystem === "npm") return files.includes("package.json") && files.some((file) => ["pnpm-lock.yaml", "package-lock.json"].includes(file));
  if (ecosystem === "pip") return files.some((file) => /^requirements.*\.txt$/.test(file) || file === "pyproject.toml");
  if (ecosystem === "github-actions") {
    const workflows = new URL(".github/workflows/", folder);
    return existsSync(workflows) && readdirSync(workflows).some((file) => /\.ya?ml$/.test(file));
  }
  return false;
}

test("every Dependabot entry names directories that hold its ecosystem's manifest", () => {
  assert.ok(entries.length > 0, "dependabot.yml lists no updates");
  assert.equal(entries.length, [...config.matchAll(/package-ecosystem:/g)].length, "every entry is written in the checked shape");
  for (const { ecosystem, block } of entries) {
    const directories = directoriesOf(block);
    assert.ok(directories.length > 0, `the ${ecosystem} entry names no directory`);
    for (const directory of directories) {
      assert.ok(hasManifest(ecosystem, directory), `${ecosystem} ${directory} has no manifest Dependabot can read`);
    }
  }
});

test("Dependabot covers every product's dependencies and the workflow actions", () => {
  assert.deepEqual(
    entries.flatMap(({ ecosystem, block }) => directoriesOf(block).map((directory) => `${ecosystem} ${directory}`)).sort(),
    ["github-actions /", "npm /desktop", "npm /desktop/installer", "pip /morrow-for-muse"],
  );
});

// Ungrouped, every outdated dependency arrives as its own pull request. One entry per ecosystem,
// with one group for minor and patch updates and one for major updates, keeps each ecosystem to
// at most two pull requests a week, and keeps majors, which usually need code changes, apart.
test("each ecosystem sends one weekly pull request for minor and patch updates and one for majors", () => {
  const ecosystems = entries.map(({ ecosystem }) => ecosystem);
  assert.deepEqual(ecosystems, [...new Set(ecosystems)], "each ecosystem is configured in one entry");
  for (const { ecosystem, block } of entries) {
    assert.match(block, /^ {4}schedule:\n {6}interval: weekly$/m, `${ecosystem} updates weekly`);
    const groups = groupsOf(block);
    assert.deepEqual(groups.map(({ updateTypes }) => updateTypes.join(" ")).sort(), ["major", "minor patch"],
      `${ecosystem} groups minor and patch updates together and major updates together`);
    for (const { name, patterns } of groups) {
      assert.deepEqual(patterns, ['"*"'], `${ecosystem} group ${name} takes every dependency`);
    }
  }
});
