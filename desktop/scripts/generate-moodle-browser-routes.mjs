import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "@typescript/typescript6";

const root = new URL("../", import.meta.url);
const workerUrl = new URL("connector/extension/src/service-worker.js", root);
const catalogUrl = new URL("connector/extension/generated/moodle-browser-catalog.json", root);
const outputUrl = new URL("connector/extension/generated/moodle-browser-routes.json", root);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function parse(name, source) {
  const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length) throw new Error(`${name}: invalid JavaScript`);
  return ast;
}

// Only constant routing data is evaluated. The worker's listeners,
// provider adapters, browser startup, storage and network code never run.
function routingConstant(node) {
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)
    || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)) return true;
  if (ts.isIdentifier(node)) return /^(?:PRIVATE_)?MOODLE_/.test(node.text);
  if (ts.isArrayLiteralExpression(node)) return node.elements.every(routingConstant);
  if (ts.isObjectLiteralExpression(node)) return node.properties.every((p) => ts.isPropertyAssignment(p) && routingConstant(p.initializer));
  if (ts.isCallExpression(node)) return node.expression.getText() === "Object.freeze" && node.arguments.length === 1 && routingConstant(node.arguments[0]);
  if (ts.isNewExpression(node)) return ["Set", "Map"].includes(node.expression.getText()) && node.arguments?.length === 1 && routingConstant(node.arguments[0]);
  return false;
}

export async function generateRoutes(workerPath = fileURLToPath(workerUrl)) {
  const workerBytes = readFileSync(workerPath);
  const worker = workerBytes.toString("utf8");
  const catalogBytes = readFileSync(catalogUrl);
  const catalog = JSON.parse(catalogBytes.toString("utf8"));
  if (catalog.schema !== "morrow.browser-catalog.v1" || catalog.provider !== "moodle" || !Array.isArray(catalog.operations)) throw new Error("invalid Moodle catalog");
  const ast = parse("service-worker.js", worker);
  const constants = [];
  const adapters = new Map();
  const sources = { "service-worker.js": hash(workerBytes), "moodle-browser-catalog.json": hash(catalogBytes) };
  let execute;
  for (const statement of ast.statements) {
    if (ts.isImportDeclaration(statement) && statement.moduleSpecifier.text.startsWith("./moodle-")) {
      const file = basename(statement.moduleSpecifier.text);
      const url = new URL(statement.moduleSpecifier.text, workerUrl);
      const bytes = readFileSync(url);
      const module = parse(file, bytes.toString("utf8"));
      sources[file] = hash(bytes);
      for (const imported of statement.importClause?.namedBindings?.elements || []) {
        const name = imported.name.text;
        const exported = imported.propertyName?.text || name;
        const declaration = module.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === exported
          && n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
        if (!declaration || !/^(execute|collect)Moodle[A-Za-z0-9]*(InPage|Roster)$/.test(name) || adapters.has(name)) throw new Error(`invalid adapter import: ${name}`);
        const source = bytes.toString("utf8");
        const exportedModifier = declaration.modifiers.find((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        const range = [Buffer.byteLength(source.slice(0, exportedModifier.end)), Buffer.byteLength(source.slice(0, declaration.end))];
        adapters.set(name, { file, functionByteRange: range, functionSha256: hash(bytes.subarray(...range)) });
      }
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !/^(?:PRIVATE_)?MOODLE_/.test(declaration.name.text)) continue;
        if (!declaration.initializer || !routingConstant(declaration.initializer)) throw new Error(`nonconstant route data: ${declaration.name.text}`);
        constants.push(`const ${declaration.getText(ast)};`);
      }
    }
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === "executeOperation") execute = statement.getText(ast);
  }
  if (!execute || !adapters.size) throw new Error("Moodle worker routing is missing");
  const captures = [];
  const context = vm.createContext({
    chrome: { scripting: { executeScript: async (request) => {
      captures.push({ name: request.func.name, input: JSON.parse(request.args[0]) });
      return [{ result: { ok: true } }];
    } } },
    catalog: async () => ({ catalogDigest: "route-generation-only" }),
    sha256: async () => "route-generation-only",
  }, { codeGeneration: { strings: false, wasm: false } });
  const stubs = [...adapters.keys()].map((name) => `function ${name}() { throw new Error("adapter execution forbidden during route generation"); }`);
  vm.runInContext([...constants, ...stubs, execute].join("\n"), context, { timeout: 5000 });
  const stagedFiles = vm.runInContext("PRIVATE_MOODLE_STAGED_FILE_OPERATIONS", context, { timeout: 5000 });
  const binding = { tabId: 1, origin: "https://moodle.example.edu", siteUrl: "https://moodle.example.edu/", principalId: "3", courseId: "2", sourceBindingId: "route-generation-only", principalFingerprint: "route-generation-only", sessionGeneration: 1 };
  const operations = {};
  for (const operation of catalog.operations) {
    if (typeof operation.key !== "string" || operations[operation.key] || typeof operation.readOnly !== "boolean") throw new Error("duplicate or invalid Moodle operation");
    captures.length = 0;
    const attachmentMode = stagedFiles.find((entry) => entry.key === operation.key)?.attachmentMode || "none";
    const placeholder = { routeGenerationOnly: true };
    await context.executeOperation(binding, operation, { course_id: "2" }, 1,
      attachmentMode === "single" ? placeholder : undefined, undefined,
      attachmentMode === "multiple" ? [placeholder] : undefined);
    if (captures.length !== 1 || !adapters.has(captures[0].name)) throw new Error(`operation has no unique browser route: ${operation.key}`);
    const { name, input } = captures[0];
    const inputKind = input.operation?.key === operation.key ? "operation" : input.courseId === "2" ? "roster" : null;
    if (!inputKind) throw new Error(`unknown adapter input shape: ${operation.key}`);
    operations[operation.key] = { ...adapters.get(name), function: name, toolName: operation.toolName, readOnly: operation.readOnly, inputKind, attachmentMode };
  }
  return { schema: "morrow.moodle-browser-routes.v1", sources: Object.fromEntries(Object.entries(sources).sort()), operations: Object.fromEntries(Object.entries(operations).sort()) };
}

async function main() {
  let check = false;
  let output = fileURLToPath(outputUrl);
  let worker = fileURLToPath(workerUrl);
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--check") check = true;
    else if (["--out", "--worker"].includes(args[i]) && args[i + 1]) {
      const flag = args[i];
      const value = args[++i];
      if (flag === "--out") output = value;
      else worker = value;
    } else throw new Error("usage: generate-moodle-browser-routes.mjs [--check] [--out PATH] [--worker PATH]");
  }
  const text = JSON.stringify(await generateRoutes(worker), null, 2) + "\n";
  if (check) {
    if (readFileSync(output, "utf8") !== text) throw new Error("Moodle browser routes are stale; run scripts/generate-moodle-browser-routes.mjs");
    console.log("Moodle browser routes match the worker and catalog");
  } else {
    const temporary = output + ".partial";
    writeFileSync(temporary, text);
    renameSync(temporary, output);
    console.log(`wrote ${output}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
