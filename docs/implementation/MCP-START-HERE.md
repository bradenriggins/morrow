# Set up Morrow from the extracted archive (engineering route)

This is not the normal way to install Morrow, and it is not the setup a person is asked to follow. The normal path is the Morrow desktop app: it installs Morrow MCP, writes the assistant configuration, and walks a person through the Chrome step without a terminal. That app is not signed or released yet; [MORROW-REMAINING-WORK.md](MORROW-REMAINING-WORK.md) section 6 records what it still needs.

Use this file when you are testing the extracted archive itself, or when no desktop app build exists for your system. It asks you to run commands in a terminal.

You install two components: Morrow MCP for your assistant, and Morrow Bridge for Chrome. This folder contains both, including the runtime. Keep the extracted folder in one permanent location.

## 1. Add Morrow to your assistant

Open Terminal in the project where you use Codex, Claude Code, Gemini CLI, Cursor, or VS Code. Run one command. Replace `/path/to/extracted-morrow` with this extracted folder's path.

```sh
/path/to/extracted-morrow/bin/morrow install codex
```

For Claude Code, use `install claude`. For Gemini CLI, use `install gemini`. For Cursor, use `install cursor`. For VS Code, use `install vscode`. If the path contains spaces, put the full path to `bin/morrow` in double quotes.

Each assistant keeps its own file in the project: Codex `.codex/config.toml`, Claude Code `.mcp.json`, Gemini CLI `.gemini/settings.json`, Cursor `.cursor/mcp.json`, VS Code `.vscode/mcp.json`. Morrow adds its own entry and keeps the other entries in that file. If the file already has a different Morrow entry, Morrow stops and changes nothing. VS Code supports the project file only; for a VS Code user profile, run **MCP: Open User Configuration** in VS Code and add the same entry there.

This command sets up only the current project. Reopen that project in your assistant. Claude Code can ask you to approve its new Morrow entry. This bundle does not install Claude Desktop.

## 2. Add Morrow Bridge to Chrome

1. In Chrome, open `chrome://extensions`.
2. Turn on **Developer mode** and select **Load unpacked**.
3. In this extracted folder, select `app/connector/extension`.
4. Morrow opens its setup guide. Use **Guide me** for the next action or **Setup overview** for the three stages. You can reopen the guide from **Setup guide** in Morrow Bridge.

Keep your assistant open. In Morrow Bridge, select **Connect Morrow**. Select **Allow connection** in the page that opens.

Open a permitted Canvas or Moodle course in Chrome and sign in. Morrow Bridge identifies the platform and shows **Connect Canvas** or **Connect Moodle**. Select that button and allow Chrome access to the exact address shown. In **Plan and Edit settings**, find courses, choose one, and select **Connect selected courses in Plan**.

When the guide shows **Try a first read**, return to your assistant and ask: “Use Morrow to list the modules in my selected course.” The guide shows **Ready to use** after that read returns, and names the course it read.

## If setup stops

- Open the project where you installed Morrow and keep the assistant running.
- Keep the extracted folder in its original location. If you move it, run the install command again from your project.
- If managed Chrome blocks Developer mode or unpacked extensions, this preview cannot use that Chrome profile.
- For startup details, run `/path/to/extracted-morrow/bin/morrow doctor --json` from the same project. A started MCP alone does not confirm a course connection.

Plan keeps changes for your review. You can choose separate Edit permissions later. Course sign-in stays in Chrome. Course content that passes Morrow's checks can reach your selected assistant; known-learner redaction does not make every personal fact anonymous.

This is a preview. Selected Canvas and Moodle workflows are supported. Blackboard is not available. The current recipient-tested archive is for Macs with Apple silicon. Other target archives need their own recipient checks.
