import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourceDirectory = path.join(root, "connector/extension/src");

test("every in-page provider fetch has a bounded abort signal", async () => {
  const files = (await readdir(sourceDirectory))
    .filter((name) => name.endsWith(".js") && name !== "service-worker.js")
    .sort();
  const unbounded = [];
  const invalidSignal = [];
  let fetchCount = 0;

  for (const name of files) {
    const absolute = path.join(sourceDirectory, name);
    const source = await readFile(absolute, "utf8");
    const syntax = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "fetch") {
        fetchCount += 1;
        const options = node.arguments[1];
        const signal = options && ts.isObjectLiteralExpression(options)
          ? options.properties.find((property) => property.name?.getText(syntax) === "signal")
          : undefined;
        const location = `${name}:${syntax.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
        if (!signal || !ts.isPropertyAssignment(signal)) {
          unbounded.push(location);
        } else {
          const initializer = signal.initializer.getText(syntax);
          if (!["requestSignal()", "requestSignal(expiresAt)", "requestSignal(input?.expiresAt)", "requestController.signal", "signal"].includes(initializer)) {
            invalidSignal.push(`${location}:${initializer}`);
          } else if (initializer === "signal") {
            let scope = node.parent;
            while (scope && !ts.isFunctionLike(scope)) scope = scope.parent;
            if (!scope?.getText(syntax).includes("const signal = requestSignal(")) invalidSignal.push(`${location}:unowned signal`);
          } else if (initializer === "requestController.signal") {
            let scope = node.parent;
            while (scope?.parent && scope.parent !== syntax) scope = scope.parent;
            const owner = scope?.getText(syntax) || "";
            if (!owner.includes("const requestTimeout = setTimeout(") || !owner.includes("requestController.abort()")) {
              invalidSignal.push(`${location}:unowned requestController.signal`);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(syntax);

    for (const declaration of syntax.statements.flatMap((statement) => {
      if (ts.isFunctionDeclaration(statement)) return [statement];
      return [];
    })) {
      const text = declaration.getText(syntax);
      if (text.includes("requestSignal(")) {
        assert.match(text, /const requestSignal = \(expiresAt\) => AbortSignal\.timeout\(Math\.max\(1, Math\.min\(2_147_483_647,/);
      }
    }
    if (name === "canvas-content.js") {
      assert.match(source, /const requestSignal = \(expiresAt\) => AbortSignal\.timeout\(Math\.max\(1, Math\.min\(2_147_483_647,/);
    }
  }

  assert.ok(fetchCount >= 150, `expected the complete provider executor class, saw ${fetchCount} fetch calls`);
  assert.deepEqual(unbounded, []);
  assert.deepEqual(invalidSignal, []);
});
