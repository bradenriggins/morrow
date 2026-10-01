import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "@typescript/typescript6";

// Written before the route generator: Muse must not maintain a second,
// divergent mapping or silently fall back when Desktop's route changes.
const root = new URL("../../", import.meta.url);
const workerUrl = new URL("connector/extension/src/service-worker.js", root);
const catalogUrl = new URL("connector/extension/generated/moodle-browser-catalog.json", root);
const routesUrl = new URL("connector/extension/generated/moodle-browser-routes.json", root);
const generator = new URL("scripts/generate-moodle-browser-routes.mjs", root);
const sha = (data) => createHash("sha256").update(data).digest("hex");
const read = (url) => readFileSync(url, "utf8");
const catalog = JSON.parse(read(catalogUrl));

function run(args) {
  return spawnSync(process.execPath, [generator.pathname, ...args], { cwd: root.pathname, encoding: "utf8" });
}
function scratch(t) {
  const path = mkdtempSync(join(tmpdir(), "morrow-moodle-routes-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test("generated routes bind all 250 operations to canonical exported adapters", () => {
  const routes = JSON.parse(read(routesUrl));
  assert.equal(routes.schema, "morrow.moodle-browser-routes.v1");
  assert.equal(routes.sources["service-worker.js"], sha(readFileSync(workerUrl)));
  assert.equal(routes.sources["moodle-browser-catalog.json"], sha(readFileSync(catalogUrl)));
  assert.deepEqual(Object.keys(routes.operations).sort(), catalog.operations.map((op) => op.key).sort());
  assert.equal(Object.keys(routes.operations).length, 250);
  for (const entry of catalog.operations) {
    const route = routes.operations[entry.key];
    assert.equal(route.toolName, entry.toolName);
    assert.equal(route.readOnly, entry.readOnly);
    assert.match(route.file, /^moodle-[a-z0-9-]+\.js$/);
    assert.match(route.function, /^(execute|collect)Moodle[A-Za-z0-9]*(InPage|Roster)$/);
    const url = new URL(`connector/extension/src/${route.file}`, root);
    const source = read(url);
    assert.equal(routes.sources[route.file], sha(readFileSync(url)));
    const ast = ts.createSourceFile(route.file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    assert.equal(ast.parseDiagnostics.length, 0);
    const declaration = ast.statements.find((node) => ts.isFunctionDeclaration(node)
      && node.name?.text === route.function
      && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
    assert.ok(declaration, `${entry.key}: ${route.function} is not exported`);
    const exported = declaration.modifiers.find((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const range = [Buffer.byteLength(source.slice(0, exported.end)), Buffer.byteLength(source.slice(0, declaration.end))];
    assert.deepEqual(route.functionByteRange, range);
    const callable = readFileSync(url).subarray(...range);
    assert.equal(route.functionSha256, sha(callable));
    assert.match(callable.toString("utf8").trimStart(), new RegExp(`^(async )?function ${route.function}\\(`));
    assert.ok(["operation", "roster"].includes(route.inputKind));
  }
  const forum = routes.operations["moodle.form.forum.discussion.create.write.v1"];
  assert.equal(forum.file, "moodle-forum-post-executor.js");
  assert.equal(forum.function, "executeMoodleForumPostInPage");
  assert.equal(forum.readOnly, false);
  const discovery = routes.operations["moodle.ajax.core_course_get_enrolled_courses_by_timeline_classification.v1"];
  assert.equal(discovery.function, "executeMoodleInPage");
});

test("the generator builds the checked-in registry deterministically", (t) => {
  const output = join(scratch(t), "routes.json");
  const result = run(["--out", output]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(output, "utf8"), read(routesUrl));
  const check = run(["--check"]);
  assert.equal(check.status, 0, check.stdout + check.stderr);
});

test("a changed worker route changes the generated selection instead of using a static map", (t) => {
  const directory = scratch(t);
  const worker = join(directory, "worker.js");
  const output = join(directory, "routes.json");
  const source = read(workerUrl);
  const original = "func: executeMoodleForumPostInPage";
  assert.ok(source.includes(original));
  writeFileSync(worker, source.replaceAll(original, "func: executeMoodleGlossaryWikiInPage"));
  const result = run(["--worker", worker, "--out", output]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const routes = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(routes.operations["moodle.form.forum.discussion.create.write.v1"].function, "executeMoodleGlossaryWikiInPage");
  assert.equal(routes.sources["service-worker.js"], sha(readFileSync(worker)));
  assert.notEqual(routes.sources["service-worker.js"], JSON.parse(read(routesUrl)).sources["service-worker.js"]);
});

test("an unrouted operation fails generation before replacing an output", (t) => {
  const directory = scratch(t);
  const worker = join(directory, "worker.js");
  const output = join(directory, "routes.json");
  const source = read(workerUrl);
  assert.ok(source.includes('if (operation.provider === "moodle") {'));
  const start = source.indexOf("async function executeOperation(");
  assert.ok(start > 0);
  writeFileSync(worker, source.slice(0, start) + source.slice(start).replace('if (operation.provider === "moodle") {', 'if (operation.provider === "moodle") { return {ok: false};'));
  writeFileSync(output, "preserve previous registry\n");
  const result = run(["--worker", worker, "--out", output]);
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(output, "utf8"), "preserve previous registry\n");
});
