# Test Morrow MCP from an extracted archive (engineering route)

The normal installation path is [Morrow Desktop](../../README.md#the-morrow-desktop-app). Published unsigned installers are available for Mac with Apple silicon and Windows x64. Morrow Desktop installs Morrow MCP, writes the assistant configuration, and guides you through the Chrome step without a terminal.

Use this file only to test the MCP configuration and startup in an existing engineering archive. It asks you to run commands in a terminal. The current packager creates Desktop payloads and installers; it does not create this historical archive. See the [engineering archive record](../../README.md#development-and-engineering-evidence).

This route configures Morrow MCP for your assistant. It does not prepare a Bridge folder that Morrow accepts for course pairing. Keep the extracted folder in one permanent location for the MCP test.

## 1. Add Morrow to your assistant

Open Terminal in the project where you use Codex, Claude Code, Gemini CLI, Cursor, or VS Code. Run one command. Replace `/path/to/extracted-morrow` with this extracted folder's path.

```sh
/path/to/extracted-morrow/bin/morrow install codex
```

For Claude Code, use `install claude`. For Gemini CLI, use `install gemini`. For Cursor, use `install cursor`. For VS Code, use `install vscode`. If the path contains spaces, put the full path to `bin/morrow` in double quotes.

Each assistant keeps its own file in the project: Codex `.codex/config.toml`, Claude Code `.mcp.json`, Gemini CLI `.gemini/settings.json`, Cursor `.cursor/mcp.json`, VS Code `.vscode/mcp.json`. Morrow adds its own entry and keeps the other entries in that file. If the file already has a different Morrow entry, Morrow stops and changes nothing. VS Code supports the project file only; for a VS Code user profile, run **MCP: Open User Configuration** in VS Code and add the same entry there.

This command sets up only the current project. Reopen that project in your assistant. Claude Code can ask you to approve its new Morrow entry. This bundle does not install Claude Desktop.

## 2. Use a supported route for course setup

Morrow pairs only a Morrow Bridge loaded from a Bridge folder that Morrow set up. The archive commands above prepare no such folder. **Connect Morrow** refuses a Bridge loaded from the archive's `app/connector/extension`.

For complete course setup, follow one of these existing paths:

- [Morrow Desktop setup](../../README.md#the-morrow-desktop-app), the normal installation path.
- [Install from source for development](../../README.md#install-from-source-for-development). Follow the whole source setup; `pnpm run setup` prepares `connector/extension` with its local pairing configuration and prints the folder to load.

## If setup stops

- Open the project where you installed Morrow and keep the assistant running.
- Keep the extracted folder in its original location. If you move it, run the install command again from your project.
- For startup details, run `/path/to/extracted-morrow/bin/morrow doctor --json` from the same project. A started MCP alone does not confirm a course connection.

The supported setup paths describe course connections and permissions. Read [LIMITATIONS.md](../../LIMITATIONS.md) for the current platform coverage and verification limits. An engineering archive startup check does not prove those course workflows.
