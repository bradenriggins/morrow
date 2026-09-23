import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync } from "node:fs";
import { dirname, relative, resolve, sep, win32 } from "node:path";

export type WindowsPrivateFileAccessClassification =
  | "private"
  | "additional_principal_access_allow"
  | "untrusted_owner"
  | "unresolved_identity"
  | "unavailable";

export type MacPrivateFileAccessClassification =
  | "private"
  | "extended_acl"
  | "unavailable";

export interface PrivateFileAccessOptions {
  readonly platform?: NodeJS.Platform;
  readonly classifyWindowsAcl?: (path: string) => WindowsPrivateFileAccessClassification;
  readonly classifyMacAcl?: (path: string) => MacPrivateFileAccessClassification;
  /**
   * When set, every existing path component from this root through the file's
   * immediate parent must be a real directory inside the root, never a link.
   */
  readonly trustedRoot?: string;
  readonly applyWindowsPrivateAcl?: (path: string) => boolean;
  readonly removeMacAcl?: (path: string) => boolean;
  /** Runs one encoded PowerShell script in place of powershell.exe. */
  readonly runWindowsPowerShell?: WindowsPowerShellRunner;
}

export interface WindowsPowerShellResult {
  /** The exit status, or null when the process failed to start, timed out, or overflowed its output limit. */
  readonly status: number | null;
  readonly stdout: string;
}

export type WindowsPowerShellRunner = (encodedCommand: string, maxBuffer: number) => WindowsPowerShellResult;

const WINDOWS_ACL_RESULTS = new Set<WindowsPrivateFileAccessClassification>([
  "private",
  "additional_principal_access_allow",
  "untrusted_owner",
  "unresolved_identity",
  "unavailable",
]);

/**
 * Classifies one macOS `ls -lde` listing. The mode column carries `+` when
 * an extended ACL is present, and each ACL entry follows on its own numbered
 * line. This is the complete darwin decision, so a test can prove it without
 * a macOS host.
 */
export function classifyMacAclListing(output: string): MacPrivateFileAccessClassification {
  const mode = String(output || "").match(/^(\S+)/)?.[1];
  if (!mode) return "unavailable";
  return mode.includes("+") || /\n\s*\d+:\s/u.test(output) ? "extended_acl" : "private";
}

function classifyMacPrivateAcl(path: string): MacPrivateFileAccessClassification {
  const result = spawnSync("/bin/ls", ["-lde", resolve(path)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    timeout: 30_000,
    maxBuffer: 16 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return "unavailable";
  return classifyMacAclListing(String(result.stdout || ""));
}

function removeMacPrivateAcl(path: string): boolean {
  const result = spawnSync("/bin/chmod", ["-N", resolve(path)], {
    timeout: 30_000,
    maxBuffer: 4 * 1024,
    stdio: ["ignore", "ignore", "ignore"],
  });
  return result.status === 0;
}

function windowsPowerShell() {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  return {
    executable: win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    environment: { ...process.env, PSModulePath: win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules") },
  };
}

// Each PowerShell start costs hundreds of milliseconds on Windows, so one
// question names every path it needs, and within one operation (see
// withPrivateAccessOperation) a file object already found private is not asked
// about again.
const WINDOWS_ACCESS_FUNCTION = [
  "$allowed = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')",
  "$sensitive = [Security.AccessControl.FileSystemRights]::ReadData -bor [Security.AccessControl.FileSystemRights]::ReadExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::ReadAttributes -bor [Security.AccessControl.FileSystemRights]::ReadPermissions -bor [Security.AccessControl.FileSystemRights]::ExecuteFile -bor [Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership",
  "function Get-MorrowPrivateAccess([string]$target) {",
  "  $acl = if ([IO.Directory]::Exists($target)) { [IO.Directory]::GetAccessControl($target) } elseif ([IO.File]::Exists($target)) { [IO.File]::GetAccessControl($target) } else { throw 'Private path is unavailable' }",
  "  try { $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value } catch { return 'unresolved_identity' }",
  "  if ($allowed -notcontains $owner) { return 'untrusted_owner' }",
  "  foreach ($rule in $acl.Access) { if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or (($rule.FileSystemRights -band $sensitive) -eq 0)) { continue }; try { $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { return 'unresolved_identity' }; if ($allowed -notcontains $sid) { return 'additional_principal_access_allow' } }",
  "  return 'private'",
  "}",
  "for ($index = 0; $index -lt $morrowTargets.Count; $index++) {",
  "  $verdict = 'unavailable'",
  "  try { $verdict = Get-MorrowPrivateAccess ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($morrowTargets[$index]))) } catch { $verdict = 'unavailable' }",
  "  \"$index $verdict\"",
  "}",
];

const WINDOWS_APPLY_DIRECTORY_ACL = [
  "$target = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($morrowTargets[0]))",
  "$current = [Security.Principal.WindowsIdentity]::GetCurrent().User",
  "$system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')",
  "$admins = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')",
  "$acl = [IO.Directory]::GetAccessControl($target)",
  "$acl.SetAccessRuleProtection($true, $false)",
  "$acl.SetOwner($current)",
  "$inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit",
  "foreach ($sid in @($current, $system, $admins)) { $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow); $acl.AddAccessRule($rule) }",
  "[IO.Directory]::SetAccessControl($target, $acl)",
];

// A command line on Windows holds at most 32,767 characters.
const WINDOWS_ENCODED_COMMAND_LIMIT = 30_000;

function windowsAccessCommand(paths: readonly string[], applyDirectoryAcl: boolean): string {
  const targets = paths.map((path) => `'${Buffer.from(path, "utf16le").toString("base64")}'`).join(", ");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    `$morrowTargets = @(${targets})`,
    ...(applyDirectoryAcl ? WINDOWS_APPLY_DIRECTORY_ACL : []),
    ...WINDOWS_ACCESS_FUNCTION,
  ].join("\n");
  return Buffer.from(script, "utf16le").toString("base64");
}

function runWindowsPowerShell(encodedCommand: string, maxBuffer: number): WindowsPowerShellResult {
  const powershell = windowsPowerShell();
  const result = spawnSync(powershell.executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand], {
    encoding: "utf8",
    env: powershell.environment,
    timeout: 30_000,
    maxBuffer,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return { status: result.error ? null : result.status, stdout: String(result.stdout || "") };
}

/**
 * Reads one answer as a verdict for each asked path, in order. Anything but a
 * clean exit with exactly one known verdict line per path, numbered in order,
 * answers "unavailable" for every path.
 */
function windowsAccessAnswer(result: WindowsPowerShellResult, count: number): WindowsPrivateFileAccessClassification[] {
  const unavailable = Array.from({ length: count }, (): WindowsPrivateFileAccessClassification => "unavailable");
  if (result.status !== 0 || typeof result.stdout !== "string") return unavailable;
  const lines = result.stdout.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== count) return unavailable;
  const verdicts: WindowsPrivateFileAccessClassification[] = [];
  for (const [index, line] of lines.entries()) {
    const match = /^(0|[1-9][0-9]*) ([a-z_]+)$/u.exec(line);
    const verdict = match?.[2] as WindowsPrivateFileAccessClassification | undefined;
    if (!match || Number(match[1]) !== index || !verdict || !WINDOWS_ACL_RESULTS.has(verdict)) return unavailable;
    verdicts.push(verdict);
  }
  return verdicts;
}

/** Asks about several paths in as few PowerShell starts as the command-line limit allows. */
function askWindowsAccess(
  paths: readonly string[],
  run: WindowsPowerShellRunner,
  applyDirectoryAcl = false,
): WindowsPrivateFileAccessClassification[] {
  const verdicts: WindowsPrivateFileAccessClassification[] = [];
  let start = 0;
  while (start < paths.length) {
    let end = start + 1;
    while (end < paths.length && !applyDirectoryAcl
      && windowsAccessCommand(paths.slice(start, end + 1), false).length <= WINDOWS_ENCODED_COMMAND_LIMIT) end += 1;
    const chunk = paths.slice(start, end);
    const command = windowsAccessCommand(chunk, applyDirectoryAcl);
    verdicts.push(...(command.length <= WINDOWS_ENCODED_COMMAND_LIMIT
      ? windowsAccessAnswer(run(command, 1_024 + 64 * chunk.length), chunk.length)
      : chunk.map((): WindowsPrivateFileAccessClassification => "unavailable")));
    start = end;
  }
  return verdicts;
}

interface PrivateAccessOperation {
  open: boolean;
  /** File objects (path, volume and file id) found private during this operation. */
  readonly privateObjects: Set<string>;
}

const privateAccessOperations = new AsyncLocalStorage<PrivateAccessOperation>();

/**
 * Runs one operation, such as a Morrow runtime start, in which a Windows path
 * found private is not asked about again while it names the same file object.
 * Only a private answer is kept, only until the operation settles, and never
 * after Morrow changes that path's access control. Work the operation leaves
 * running afterwards asks again.
 */
export async function withPrivateAccessOperation<T>(run: () => Promise<T>): Promise<T> {
  const operation: PrivateAccessOperation = { open: true, privateObjects: new Set() };
  try {
    return await privateAccessOperations.run(operation, run);
  } finally {
    operation.open = false;
    operation.privateObjects.clear();
  }
}

function currentPrivateAccessOperation(): PrivateAccessOperation | null {
  const operation = privateAccessOperations.getStore();
  return operation?.open ? operation : null;
}

function fileObject(path: string): string | null {
  try {
    const info = lstatSync(path, { bigint: true });
    return `${path}\u0000${info.dev}\u0000${info.ino}`;
  } catch {
    return null;
  }
}

function forgetPrivateObject(path: string): void {
  const operation = currentPrivateAccessOperation();
  if (!operation) return;
  const prefix = `${resolve(path)}\u0000`;
  for (const object of [...operation.privateObjects]) {
    if (object.startsWith(prefix)) operation.privateObjects.delete(object);
  }
}

/**
 * Classifies each path's Windows access control, asking PowerShell once for
 * every path not already found private in the current operation.
 */
function windowsAccessVerdicts(
  paths: readonly string[],
  options: PrivateFileAccessOptions,
  applyDirectoryAcl = false,
): WindowsPrivateFileAccessClassification[] {
  const operation = currentPrivateAccessOperation();
  const resolved = paths.map((path) => resolve(path));
  const verdicts = new Map<string, WindowsPrivateFileAccessClassification>();
  const asked: string[] = [];
  for (const path of resolved) {
    if (verdicts.has(path) || asked.includes(path)) continue;
    const object = operation && !applyDirectoryAcl ? fileObject(path) : null;
    if (object && operation!.privateObjects.has(object)) verdicts.set(path, "private");
    else asked.push(path);
  }
  if (asked.length !== 0) {
    const before = operation ? asked.map(fileObject) : [];
    const answers = askWindowsAccess(asked, options.runWindowsPowerShell ?? runWindowsPowerShell, applyDirectoryAcl);
    for (const [index, path] of asked.entries()) {
      verdicts.set(path, answers[index]!);
      const object = before[index];
      if (operation && answers[index] === "private" && object && fileObject(path) === object) operation.privateObjects.add(object);
    }
  }
  return resolved.map((path) => verdicts.get(path)!);
}

/**
 * Classifies the Windows access control of each path in one PowerShell start
 * where the command line allows. A path that cannot be read, and every path of
 * an answer that is incomplete or malformed, is "unavailable".
 */
export function classifyWindowsPrivateAccess(
  paths: readonly string[],
  options: Pick<PrivateFileAccessOptions, "runWindowsPowerShell"> = {},
): WindowsPrivateFileAccessClassification[] {
  return windowsAccessVerdicts(paths, options);
}

function applyWindowsPrivateFileAcl(path: string): boolean {
  const encodedPath = Buffer.from(path, "utf16le").toString("base64");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$target = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedPath}'))`,
    "$current = [Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')",
    "$admins = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')",
    "$acl = [IO.File]::GetAccessControl($target)",
    "$acl.SetAccessRuleProtection($true, $false)",
    "$acl.SetOwner($current)",
    "foreach ($sid in @($current, $system, $admins)) { $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.InheritanceFlags]::None, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow); $acl.AddAccessRule($rule) }",
    "[IO.File]::SetAccessControl($target, $acl)",
  ].join("; ");
  const powershell = windowsPowerShell();
  const result = spawnSync(powershell.executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", env: powershell.environment, timeout: 30_000, maxBuffer: 4 * 1024, windowsHide: true, stdio: ["ignore", "ignore", "ignore"] });
  return result.status === 0;
}

function trustedAncestorChainAccepted(filePath: string, trustedRoot: string): boolean {
  const root = resolve(trustedRoot);
  const file = resolve(filePath);
  const fromRoot = relative(root, file);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || fromRoot.includes(`${sep}..${sep}`) || fromRoot.endsWith(`${sep}..`)) {
    return false;
  }
  const parts = fromRoot.split(sep).filter(Boolean);
  if (parts.length < 1) return false;
  let current = root;
  try {
    const rootInfo = lstatSync(current);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return false;
    for (const part of parts.slice(0, -1)) {
      current = resolve(current, part);
      const info = lstatSync(current);
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Accepts a sensitive directory only when its access control is private.
 * `trustedRoot` limits link validation to an explicit application-owned path.
 */
export function privateDirectoryAccessAccepted(
  directoryPath: string,
  options: PrivateFileAccessOptions = {},
): boolean {
  const platform = options.platform ?? process.platform;
  let directory;
  try { directory = lstatSync(directoryPath); } catch { return false; }
  if (!directory.isDirectory() || directory.isSymbolicLink()) return false;
  if (options.trustedRoot && !trustedAncestorChainAccepted(resolve(directoryPath, ".morrow-directory-probe"), options.trustedRoot)) {
    return false;
  }
  if (platform !== "win32") {
    if ((directory.mode & 0o077) !== 0) return false;
    if (platform !== "darwin") return true;
    const classify = options.classifyMacAcl ?? classifyMacPrivateAcl;
    return classify(directoryPath) === "private";
  }
  if (options.classifyWindowsAcl) return options.classifyWindowsAcl(directoryPath) === "private";
  return windowsAccessVerdicts([directoryPath], options)[0] === "private";
}

/** Reads a file and its parent, and accepts their shape: a regular file in a real directory, no links. */
function privateFileShape(filePath: string, options: PrivateFileAccessOptions): { readonly parentMode: number } | null {
  let file;
  let parent;
  try {
    file = lstatSync(filePath);
    parent = lstatSync(dirname(filePath));
  } catch {
    return null;
  }
  if (!file.isFile() || file.isSymbolicLink() || !parent.isDirectory() || parent.isSymbolicLink()) return null;
  if (options.trustedRoot && !trustedAncestorChainAccepted(filePath, options.trustedRoot)) return null;
  return { parentMode: parent.mode };
}

/**
 * Accepts a sensitive regular file only when its access control is private.
 * POSIX proves this from mode bits. macOS also rejects extended ACLs on the
 * file and parent. Windows uses owner-restricted DACLs for both paths because
 * mode bits there are synthetic.
 */
export function privateFileAccessAccepted(
  filePath: string,
  mode: number,
  options: PrivateFileAccessOptions = {},
): boolean {
  return privateFilesAccessAccepted([{ path: filePath, mode }], options)[0] === true;
}

/**
 * Accepts each of several sensitive regular files by the rules of
 * privateFileAccessAccepted. On Windows one question covers every file and
 * its parent.
 */
export function privateFilesAccessAccepted(
  files: readonly { readonly path: string; readonly mode: number }[],
  options: PrivateFileAccessOptions = {},
): boolean[] {
  const platform = options.platform ?? process.platform;
  const shapes = files.map((file) => privateFileShape(file.path, options));
  if (platform !== "win32") {
    return files.map((file, index) => {
      const shape = shapes[index];
      if (!shape || (file.mode & 0o077) !== 0 || (shape.parentMode & 0o022) !== 0) return false;
      if (platform !== "darwin") return true;
      const classify = options.classifyMacAcl ?? classifyMacPrivateAcl;
      return classify(file.path) === "private" && classify(dirname(file.path)) === "private";
    });
  }
  if (options.classifyWindowsAcl) {
    const classify = options.classifyWindowsAcl;
    return files.map((file, index) => shapes[index] !== null
      && classify(file.path) === "private" && classify(dirname(file.path)) === "private");
  }
  const asked = files.flatMap((file, index) => shapes[index] ? [file.path, dirname(file.path)] : []);
  const verdicts = asked.length === 0 ? [] : windowsAccessVerdicts(asked, options);
  let next = 0;
  return files.map((_file, index) => {
    if (!shapes[index]) return false;
    const accepted = verdicts[next] === "private" && verdicts[next + 1] === "private";
    next += 2;
    return accepted;
  });
}

/** Hardens one app-owned directory without recursing into its contents. */
export function hardenPrivateDirectory(directory: string, options: PrivateFileAccessOptions = {}): boolean {
  const platform = options.platform ?? process.platform;
  try {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    if (platform !== "win32") {
      chmodSync(directory, 0o700);
      if (platform === "darwin") {
        const remove = options.removeMacAcl ?? removeMacPrivateAcl;
        if (!remove(directory)) return false;
      }
      const refreshed = lstatSync(directory);
      if (!refreshed.isDirectory() || refreshed.isSymbolicLink() || (refreshed.mode & 0o077) !== 0) return false;
      if (platform !== "darwin") return true;
      const classify = options.classifyMacAcl ?? classifyMacPrivateAcl;
      return classify(directory) === "private";
    }
    forgetPrivateObject(directory);
    if (options.applyWindowsPrivateAcl || options.classifyWindowsAcl) {
      if (!options.applyWindowsPrivateAcl || !options.classifyWindowsAcl) return false;
      return options.applyWindowsPrivateAcl(directory) === true && options.classifyWindowsAcl(directory) === "private";
    }
    return windowsAccessVerdicts([directory], options, true)[0] === "private";
  } catch {
    return false;
  }
}

/** Tightens one singly linked app-owned regular file and verifies the result. */
export function hardenPrivateFile(filePath: string, options: PrivateFileAccessOptions = {}): boolean {
  const platform = options.platform ?? process.platform;
  try {
    const before = lstatSync(filePath);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || (typeof process.getuid === "function" && before.uid !== process.getuid())) return false;
    if (platform !== "win32") {
      chmodSync(filePath, 0o600);
      if (platform === "darwin") {
        const remove = options.removeMacAcl ?? removeMacPrivateAcl;
        if (!remove(filePath)) return false;
      }
    } else {
      forgetPrivateObject(filePath);
      if (!applyWindowsPrivateFileAcl(filePath)) return false;
    }
    const after = lstatSync(filePath);
    return before.dev === after.dev && before.ino === after.ino && after.nlink === 1
      && privateFileAccessAccepted(filePath, after.mode, options);
  } catch {
    return false;
  }
}
