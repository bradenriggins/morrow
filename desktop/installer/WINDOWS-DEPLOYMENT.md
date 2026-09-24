# Windows deployment

Morrow uses the NSIS target in `electron-builder.config.cjs`. It is a
one-click, per-user installer. It does not offer a machine-wide mode, ask for
elevation, or package the NSIS elevation helper.

Build the x64 installer on Windows x64. Step 4 of the release procedure in
[docs/versioning.md](../../docs/versioning.md) names the install and build
commands to run first. Then, in `desktop/`, run one command:

```text
node scripts/package-mcp-bundle.mjs --target win32-x64 --unsigned-release --output <new absolute folder>
```

It writes `Morrow-<version>-win-x64.exe` and `receipt.json` into that folder.
The receipt ties the installer to the commit it was built from. The same step 4
installs, starts, repairs, and removes that exact installer in a test run.
Every Morrow Desktop release so far, including 1.0.5, is unsigned. Automatic
updates remain disabled. Use the complete NSIS installer; do not deploy an
unpacked app or a separately copied `MorrowPayload` directory.

## The Morrow Bridge delivery route

Every current build carries the temporary Load unpacked route. The package
script and builder do not accept an environment override for this choice. A
future Chrome Web Store route requires a publication check and a receipt bound
to the exact packaged extension before the builder can expose that route. The
Bridge identity, active-folder, and pairing checks stay required for every
delivery route.

On 7 September, on the native Windows machine `BOOTZ`, the unsigned 1.0.0
installer passed installation, startup, damaged-payload refusal, exact repair,
uninstall and retained-data checks through
`scripts/test/desktop-windows-smoke.mjs`. That harness runs on native Windows
only and uses isolated application state. Its receipt stayed on that machine
and is not in this repository. Public-download SmartScreen behavior and
institution-managed deployment remain live-unverified. No signed Windows
artifact exists.

## Silent deployment

Run the unsigned installer in the target user's context:

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

Deploy the same NSIS artifact only when institution policy permits unsigned applications in the user context. Detect installation
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
installation keeps data: `State`, the materials folder, the `Materials` folder
Morrow made first when a different materials folder was chosen later, the
`Assistant settings backups` folder, the `Window data` folder where Morrow's
window keeps its caches and site data while Morrow is open, the Bridge folder
Chrome loads, the Blackboard credential
folder, the Blackboard configuration file, and each assistant configuration file
Morrow wrote.

The action asks for a confirmation that lists every path it will remove and
every path it will not. It first takes Morrow's own `morrow` entry out of each
assistant configuration file Morrow wrote and leaves the rest of that file; if it
cannot, it stops, names the file, and removes nothing. It then removes only paths
inside Morrow's own user-data folder, the Blackboard credential folder, and the
Blackboard configuration file.
It keeps the `Assistant settings backups` folder and the `Window data`
folder; delete `Window data` after you remove the application. It never removes an
assistant's own configuration file. After the removal it reads each path again
and reports which are gone and which are still on the computer.

Removing the application itself stays a Windows step. Windows 11: Settings,
Apps, Installed apps, Morrow, More, Uninstall. Windows 10: Settings, Apps, Apps &
features, Morrow, Uninstall. The uninstaller the installed copy registered for
the current user does the same. `installer/test/installer-controller.test.cjs` proves the in-app removal
on macOS. `scripts/test/desktop-windows-smoke.mjs` runs the Windows uninstaller
and then compares State, Materials, backups, and the assistant configuration
byte for byte against the reading it took before the uninstall. The harness
refuses to run anywhere but native Windows. The 7 September `BOOTZ` run passed
with the configured upstream, assistant settings and journal preserved.
