import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pnpmCommand } from "../lib/pnpm-command.mjs";

/**
 * The release packager and the zero-tolerance receipt start pnpm with no shell. On Windows pnpm is
 * a .cmd shim, which Node does not start without a shell, so the Windows packaging job failed with
 * `spawnSync pnpm ENOENT`. These cases run the lookup against the shim files npm and pnpm write,
 * then start the pnpm on this computer's PATH the way the packager does.
 */

// npm's cmd-shim, as `npm ci` writes node_modules/.bin/pnpm.cmd for pnpm/action-setup.
const NPM_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "",
  "IF EXIST \"%dp0%\\node.exe\" (",
  "  SET \"_prog=%dp0%\\node.exe\"",
  ") ELSE (",
  "  SET \"_prog=node\"",
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  "",
  "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\..\\pnpm\\bin\\pnpm.cjs\" %*",
  "",
].join("\r\n");

// pnpm's own cmd shim, as `pnpm self-update` writes PNPM_HOME/bin/pnpm.cmd.
function pnpmShim(target) {
  return [
    "@SETLOCAL",
    "@IF NOT DEFINED NODE_PATH (",
    "  @SET \"NODE_PATH=C:\\pnpm-home\\.tools\\node_modules\"",
    ") ELSE (",
    "  @SET \"NODE_PATH=C:\\pnpm-home\\.tools\\node_modules;%NODE_PATH%\"",
    ")",
    "@IF EXIST \"%~dp0\\node.exe\" (",
    `  "%~dp0\\node.exe"  ${target} %*`,
    ") ELSE (",
    "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
    `  node  ${target} %*`,
    ")",
    "",
  ].join("\r\n");
}

/** A Windows file system held in memory, keyed by path without regard to case. */
function windowsFiles(files) {
  const held = new Map(Object.entries(files).map(([path, text]) => [path.toLowerCase(), text]));
  return {
    isFile: (path) => held.has(path.toLowerCase()),
    readText: (path) => {
      const text = held.get(path.toLowerCase());
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return text;
    },
  };
}

const NODE = "C:\\hostedtoolcache\\windows\\node\\22.23.2\\x64\\node.exe";

function lookup(env, files) {
  return pnpmCommand({ platform: "win32", env, execPath: NODE, fileSystem: windowsFiles(files) });
}

test("the pnpm/action-setup layout starts pnpm's JavaScript entry with this Node", () => {
  const bin = "D:\\a\\_temp\\setup-pnpm\\node_modules\\.bin";
  assert.deepEqual(lookup(
    { Path: `C:\\Windows\\system32;${bin}`, PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.JS" },
    { [`${bin}\\pnpm.cmd`]: NPM_SHIM, "D:\\a\\_temp\\setup-pnpm\\node_modules\\pnpm\\bin\\pnpm.cjs": "" },
  ), { command: NODE, args: ["D:\\a\\_temp\\setup-pnpm\\node_modules\\pnpm\\bin\\pnpm.cjs"] });
});

test("a pnpm shim with a relative or an absolute target starts the program it names", () => {
  const bin = "C:\\pnpm-home\\bin";
  const entry = "C:\\pnpm-home\\.tools\\pnpm\\10.6.1\\node_modules\\pnpm\\bin\\pnpm.cjs";
  assert.deepEqual(
    lookup({ PATH: bin }, { [`${bin}\\pnpm.CMD`]: pnpmShim("\"%~dp0\\..\\.tools\\pnpm\\10.6.1\\node_modules\\pnpm\\bin\\pnpm.cjs\""), [entry]: "" }),
    { command: NODE, args: [entry] },
  );
  assert.deepEqual(
    lookup({ PATH: bin }, { [`${bin}\\pnpm.cmd`]: pnpmShim(`"${entry}"`), [entry]: "" }),
    { command: NODE, args: [entry] },
  );
});

test("the lookup follows PATH first and PATHEXT within each folder, as Windows does", () => {
  const first = "C:\\first";
  const second = "C:\\second";
  const entry = "C:\\first\\node_modules\\pnpm\\bin\\pnpm.cjs";
  const npmStyle = NPM_SHIM.replace("\\..\\pnpm\\bin\\pnpm.cjs", "\\node_modules\\pnpm\\bin\\pnpm.cjs");
  assert.deepEqual(
    lookup({ PATH: `"${first}";${second}` }, { [`${first}\\pnpm.cmd`]: npmStyle, [entry]: "", [`${second}\\pnpm.exe`]: "" }),
    { command: NODE, args: [entry] },
    "an earlier folder wins over a real executable in a later one",
  );
  assert.deepEqual(
    lookup({ PATH: first }, { [`${first}\\pnpm.cmd`]: npmStyle, [entry]: "", [`${first}\\pnpm.exe`]: "" }),
    { command: `${first}\\pnpm.exe`, args: [] },
    "the standalone pnpm.exe is started directly when PATHEXT reaches it first",
  );
  assert.deepEqual(
    lookup({ PATH: `relative\\bin;${first}` }, { "relative\\bin\\pnpm.exe": "", [`${first}\\pnpm.cmd`]: npmStyle, [entry]: "" }),
    { command: NODE, args: [entry] },
    "a relative PATH entry is never searched",
  );
});

test("a pnpm that is already running this script is started again", () => {
  const entry = "C:\\pnpm-home\\node_modules\\pnpm\\bin\\pnpm.cjs";
  assert.deepEqual(lookup({ npm_execpath: entry, PATH: "" }, { [entry]: "" }), { command: NODE, args: [entry] });
  assert.deepEqual(lookup({ npm_execpath: "C:\\pnpm\\pnpm.exe", PATH: "" }, { "C:\\pnpm\\pnpm.exe": "" }), { command: "C:\\pnpm\\pnpm.exe", args: [] });
  const npm = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
  assert.throws(() => lookup({ npm_execpath: npm, PATH: "" }, { [npm]: "" }), /no pnpm program was found on PATH/,
    "npm running this script is not taken for pnpm");
});

test("a lookup that cannot find one pnpm program names what it found", () => {
  assert.throws(() => lookup({ PATH: "C:\\Windows\\system32" }, {}), /no pnpm program was found on PATH/);
  const bin = "C:\\tools";
  assert.throws(() => lookup({ PATH: bin }, { [`${bin}\\pnpm.cmd`]: "@echo off\r\nexit /b 1\r\n" }), /C:\\tools\\pnpm\.cmd does not name one pnpm program/);
  assert.throws(
    () => lookup({ PATH: bin }, { [`${bin}\\pnpm.cmd`]: "\"%~dp0\\a\\pnpm.cjs\" \"%~dp0\\b\\pnpm.cjs\"", "C:\\tools\\a\\pnpm.cjs": "", "C:\\tools\\b\\pnpm.cjs": "" }),
    /does not name one pnpm program/,
  );
  assert.throws(() => lookup({ PATH: bin }, { [`${bin}\\pnpm.cmd`]: NPM_SHIM }), /names C:\\pnpm\\bin\\pnpm\.cjs, which is not a pnpm program on this computer/);
  assert.throws(
    () => lookup({ PATH: bin }, { [`${bin}\\pnpm.cmd`]: "\"%~dp0\\evil.js\" %*", "C:\\tools\\evil.js": "" }),
    /names C:\\tools\\evil\.js, which is not a pnpm program/,
  );
});

test("other platforms start pnpm by name, as before", () => {
  assert.deepEqual(pnpmCommand({ platform: "darwin", env: {} }), { command: "pnpm", args: [] });
  assert.deepEqual(pnpmCommand({ platform: "linux", env: {} }), { command: "pnpm", args: [] });
});

test("the pnpm on this computer's PATH starts with no shell and answers", () => {
  const pnpm = pnpmCommand();
  const run = spawnSync(pnpm.command, [...pnpm.args, "--version"], { encoding: "utf8" });
  assert.equal(run.error, undefined, `pnpm could not start: ${run.error?.message}`);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("a real Windows cmd shim is started through its JavaScript entry with no shell", {
  skip: process.platform !== "win32" ? "Windows command shims exist only on Windows" : false,
}, (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "morrow-pnpm-shim-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "node_modules", ".bin");
  const program = join(root, "node_modules", "pnpm", "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(program, { recursive: true });
  writeFileSync(join(bin, "pnpm.cmd"), NPM_SHIM);
  writeFileSync(join(program, "pnpm.cjs"), "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !["PATH", "NPM_EXECPATH"].includes(key.toUpperCase())));
  env.PATH = bin;
  const plain = spawnSync("pnpm", ["--version"], { env });
  assert.equal(plain.error?.code, "ENOENT", "a bare pnpm name does not start a .cmd shim with no shell");
  const pnpm = pnpmCommand({ env });
  const run = spawnSync(pnpm.command, [...pnpm.args, "install", "a path with spaces"], { env, encoding: "utf8" });
  assert.equal(run.error, undefined);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), ["install", "a path with spaces"]);
  assert.equal(readFileSync(join(bin, "pnpm.cmd"), "utf8"), NPM_SHIM);
});
