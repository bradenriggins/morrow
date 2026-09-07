# Windows deployment

Morrow uses the NSIS target in `electron-builder.config.cjs`. It is a
one-click, per-user installer. It does not offer a machine-wide mode, ask for
elevation, or package the NSIS elevation helper.

Build the x64 artifact in two steps. `electron-builder.config.cjs` refuses to
load without an absolute prepared payload, so the payload is prepared first and
named in the environment:

```sh
node scripts/package-mcp-bundle.mjs --target win32-x64 --prepare-desktop-payload <absolute-payload-path>
MORROW_INSTALLER_PAYLOAD=<absolute-payload-path> MORROW_SIGNED_RELEASE=1 \
  pnpm --dir installer --ignore-workspace package:win
```

`MORROW_SIGNED_RELEASE=1` sets `forceCodeSigning` and requires a stable SemVer
version, so it needs the release signing inputs and a stable version. The output
is `Morrow-<version>-win-x64.exe`. The signed release artifact is the only
supported deployment input. Do not deploy an unpacked app or a separately copied
`MorrowPayload` directory.

**No signed Windows artifact exists.** No publisher certificate is available to
this project, the repository version is `1.0.0-rc.0`, and every Windows artifact
built so far came from the `windows-2022` job in
`.github/workflows/desktop-release.yml` with `MORROW_SIGNED_RELEASE=0` and every
signing variable cleared. That job starts on manual dispatch, and this checkout
holds no receipt from it. Treat everything below as the contract a signed
artifact must meet, not as a result that has been observed on a deployed machine.

## Silent deployment

Run the signed installer in the target user's context:

```text
Morrow-<version>-win-x64.exe /S
```

Use the uninstaller registered by that installed copy for silent removal:

```text
Uninstall Morrow.exe /S
```

The exact install and uninstaller paths are created by NSIS for the current
user. A deployment system must discover them from the installed application or
its current-user uninstall registration. It must not assume a machine-wide
path.

## Intune and other MDM systems

Deploy the same signed NSIS artifact in the user context. Detect installation
from the current-user Morrow application executable version or the matching
current-user uninstall registration. Keep upgrade and uninstall in the same
user context. This installer does not request administrator rights and cannot
bypass an organization policy, application allow-list, security product, or
device-management restriction.

Morrow keeps its private state outside the installed application. A repair,
upgrade, or uninstall procedure must not delete State, Materials, keys,
journals, bindings, or granted permissions unless the user separately selects
that data-removal action.

## The data-removal action

The action is **Remove Morrow's data**, in the *What stays on this computer*
section of the app. That section names the exact path of every place this
installation keeps data: `State`, the materials folder, `State\Backups`, the
Bridge folder Chrome loads, the Blackboard credential folder, the Blackboard
configuration file, and each assistant configuration file Morrow wrote.

The action asks for a confirmation that lists every path it will remove and
every path it will not. It removes only paths inside Morrow's own user-data
folder and inside the Blackboard credential folder. It never removes an
assistant's own configuration file. After the removal it reads each path again
and reports which are gone and which are still on the computer.

Removing the application itself stays a Windows step: Settings, Apps, Morrow,
Uninstall, or the uninstaller the installed copy registered for the current
user. `installer/test/installer-controller.test.cjs` proves the in-app removal
on macOS. `scripts/test/desktop-windows-smoke.mjs` runs the Windows uninstaller
and then compares State, Materials, backups, and the assistant configuration
byte for byte against the reading it took before the uninstall; that harness
refuses to run anywhere but native Windows, and only the `windows-2022` job
runs it. This checkout holds no receipt from that harness, so neither check has
a saved Windows result here.
