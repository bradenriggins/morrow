# Morrow on managed institution devices

Status: researched release decision, 2026-09-06

## Current decision

Morrow can assume that the user already has a supported ChatGPT or Claude desktop app. Morrow 1.0 will not add a second browser-only, LTI, or hosted remote product.

The release will support two practical routes:

1. **Per-user desktop setup.** The Windows package installs for the signed-in user, does not request administrator elevation, and opens the visual Morrow setup. The signed and notarized Mac app uses the normal user app flow. This covers computers that deny local administrator access but still permit user applications.
2. **Institution-approved setup.** Morrow will document silent deployment, stable identity, hashes, update behavior, data locations, and the fixed Morrow Bridge extension ID so IT can allow or deploy it. The assistant-native Claude `.mcpb` setup remains useful when the institution permits Claude Desktop extensions. It does not bypass application policy.

If the institution blocks all unapproved executables, local MCP extensions, or Chrome extensions, a different file format cannot solve the restriction. A ZIP or “portable” download still contains executable code. Morrow must show a clear IT approval route instead of suggesting a bypass.

## Assistant configuration locations

Every assistant file Morrow writes belongs to the signed-in person. None of them needs administrator rights, so the per-user route above stays true on a managed computer.

- **Claude Desktop**: `claude_desktop_config.json`. On macOS it is at `~/Library/Application Support/Claude/`. On Windows it is at `%APPDATA%\Claude\`. Claude Desktop opens the same file from Settings, Developer, Edit Config. `morrow mcp install claude-desktop --scope user` writes both locations with one merge, readback, and conflict contract. The Windows write is documented but live-unverified: no Windows computer has confirmed it. On any other platform Morrow refuses and names the next action instead of failing with a type error. The Morrow desktop installer does not use this file. It builds a Claude `.mcpb` extension, which Claude Desktop approves on macOS and Windows.
- **ChatGPT and Codex**: `~/.codex/config.toml`. The ChatGPT desktop app, the Codex CLI, and the Codex IDE extension read that file, and `codex mcp add` writes it. A project file `<project>/.codex/config.toml` is also documented, but Codex loads it only for a project the person has marked trusted, and the ChatGPT desktop app is reported to load only the user file (openai/codex issue 13025, open on 6 September 2026). Morrow therefore uses user scope for ChatGPT. The Morrow desktop installer already writes only the user file. `morrow mcp install codex --scope project` stays available for the Codex CLI and says in its output that the project file loads only in a trusted project.
- **Claude Code, Gemini CLI, Cursor, VS Code**: project files inside the chosen project, or the documented user file in the person's home directory. VS Code's user-profile MCP file has no documented path, so Morrow refuses user scope for VS Code and points to the MCP: Open User Configuration command.

Sources, all read 6 September 2026:

- [Claude Desktop local MCP configuration file](https://modelcontextprotocol.io/docs/develop/connect-local-servers)
- [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp)
- [Codex configuration file basics](https://learn.chatgpt.com/docs/config-file/config-basic)
- [Codex Desktop project-scope MCP report, openai/codex issue 13025](https://github.com/openai/codex/issues/13025)

## Evidence

Microsoft recommends per-user installation because it avoids UAC prompts. It also recommends silent installation for enterprise management. Electron Builder supports an explicit per-user NSIS package. Morrow must set and test `perMachine: false` and no elevation rather than depend on defaults.

- [Microsoft Windows app installation guidance](https://learn.microsoft.com/en-us/windows/apps/get-started/best-practices)
- [Electron Builder NSIS options](https://www.electron.build/docs/nsis/)
- [Microsoft Intune Win32 deployment](https://learn.microsoft.com/en-us/intune/app-management/deployment/add-win32)

Apple supports required or optional managed apps and signed packages through device management. A managed Mac can receive Morrow from IT even when the instructor cannot install software directly.

- [Apple managed app distribution](https://support.apple.com/guide/deployment/distribute-managed-apps-dep575bfed86/web)
- [Apple package distribution for Mac](https://support.apple.com/guide/deployment/distribute-packages-to-mac-computers-dep873c25ac4/web)

Chrome administrators can allow, block, or force-install a specific extension. Google also states that a work or school administrator may prevent users from installing Chrome Web Store items. Morrow therefore needs its stable Chrome Web Store identity and an administrator policy recipe.

- [Chrome app and extension policies](https://support.google.com/chrome/a/answer/7666985)
- [Chrome managed extension installation](https://support.google.com/chrome/a/answer/6177447)
- [Chrome Web Store managed-device limitation](https://support.google.com/chrome_webstore/answer/1698338)

Claude Desktop extensions are a valid assistant-native route, but Team and Enterprise owners can disable or control them. Morrow's `.mcpb` must therefore be treated as an approved local extension, not an installation-policy bypass.

- [Claude local MCP and desktop extensions](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)

## Release requirements

- Configure and test Windows as per-user and no-elevation.
- Confirm the Windows Claude Desktop write on a Windows computer, then remove the live-unverified label above.
- Keep the normal setup visual and guided after the package opens.
- Document silent install and uninstall commands for IT.
- Provide artifact hashes, signer identity, version, data locations, update endpoints, network requirements, and removal behavior.
- Provide the fixed Morrow Bridge extension ID and sample Chrome allowlist or force-install policy.
- State that the existing Claude `.mcpb` route still uses Morrow's installed local runtime if that dependency remains.
- Route a blocked user to their IT team. Do not claim that Morrow can override device policy.

The future remote MCP and LTI option remains deferred. It would change Morrow's local privacy boundary because the remote service would receive course data.
