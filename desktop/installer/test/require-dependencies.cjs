// The installer pins its own Electron toolchain, so it stays outside the pnpm
// workspace and installs separately. Without this check a checkout that has not
// run that install fails the suites with a module resolution stack instead of
// the command that fixes it.
const { existsSync } = require("node:fs");
const path = require("node:path");

const installerRoot = path.resolve(__dirname, "..");
const required = ["electron", "electron-updater", "@anthropic-ai/mcpb"];
const missing = required.filter((name) => !existsSync(path.join(installerRoot, "node_modules", name, "package.json")));

if (missing.length > 0) {
  process.stderr.write([
    `The desktop installer suites need dependencies that are not installed: ${missing.join(", ")}.`,
    "The installer is outside the pnpm workspace and installs on its own.",
    "Run: pnpm --dir installer --ignore-workspace install",
    ""
  ].join("\n"));
  process.exit(1);
}
