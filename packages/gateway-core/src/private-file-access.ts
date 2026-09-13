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
}

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

function classifyWindowsPrivateAcl(path: string): WindowsPrivateFileAccessClassification {
  const encodedPath = Buffer.from(path, "utf16le").toString("base64");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    `$target = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedPath}'))`,
    "$allowed = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')",
    "$acl = if ([IO.Directory]::Exists($target)) { [IO.Directory]::GetAccessControl($target) } elseif ([IO.File]::Exists($target)) { [IO.File]::GetAccessControl($target) } else { throw 'Private path is unavailable' }",
    "try { $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value } catch { 'unresolved_identity'; exit 0 }",
    "if ($allowed -notcontains $owner) { 'untrusted_owner'; exit 0 }",
    "$sensitive = [Security.AccessControl.FileSystemRights]::ReadData -bor [Security.AccessControl.FileSystemRights]::ReadExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::ReadAttributes -bor [Security.AccessControl.FileSystemRights]::ReadPermissions -bor [Security.AccessControl.FileSystemRights]::ExecuteFile -bor [Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership",
    "foreach ($rule in $acl.Access) { if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or (($rule.FileSystemRights -band $sensitive) -eq 0)) { continue }; try { $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { 'unresolved_identity'; exit 0 }; if ($allowed -notcontains $sid) { 'additional_principal_access_allow'; exit 0 } }",
    "'private'",
  ].join("; ");
  const powershell = windowsPowerShell();
  const result = spawnSync(powershell.executable, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ], { encoding: "utf8", env: powershell.environment, timeout: 30_000, maxBuffer: 4 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  if (result.status !== 0) return "unavailable";
  const classification = String(result.stdout || "").trim() as WindowsPrivateFileAccessClassification;
  return WINDOWS_ACL_RESULTS.has(classification) ? classification : "unavailable";
}

function applyWindowsPrivateAcl(path: string): boolean {
  const encodedPath = Buffer.from(path, "utf16le").toString("base64");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$target = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedPath}'))`,
    "$current = [Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')",
    "$admins = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')",
    "$acl = [IO.Directory]::GetAccessControl($target)",
    "$acl.SetAccessRuleProtection($true, $false)",
    "$acl.SetOwner($current)",
    "$inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit",
    "foreach ($sid in @($current, $system, $admins)) { $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow); $acl.AddAccessRule($rule) }",
    "[IO.Directory]::SetAccessControl($target, $acl)",
  ].join("; ");
  const powershell = windowsPowerShell();
  const result = spawnSync(powershell.executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", env: powershell.environment, timeout: 30_000, maxBuffer: 4 * 1024, windowsHide: true, stdio: ["ignore", "ignore", "ignore"] });
  return result.status === 0;
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
  const classify = options.classifyWindowsAcl ?? classifyWindowsPrivateAcl;
  return classify(directoryPath) === "private";
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
  const platform = options.platform ?? process.platform;
  let file;
  let parent;
  try {
    file = lstatSync(filePath);
    parent = lstatSync(dirname(filePath));
  } catch {
    return false;
  }
  if (!file.isFile() || file.isSymbolicLink() || !parent.isDirectory() || parent.isSymbolicLink()) return false;
  if (options.trustedRoot && !trustedAncestorChainAccepted(filePath, options.trustedRoot)) return false;
  if (platform !== "win32") {
    if ((mode & 0o077) !== 0 || (parent.mode & 0o022) !== 0) return false;
    if (platform !== "darwin") return true;
    const classify = options.classifyMacAcl ?? classifyMacPrivateAcl;
    return classify(filePath) === "private" && classify(dirname(filePath)) === "private";
  }
  const classify = options.classifyWindowsAcl ?? classifyWindowsPrivateAcl;
  return classify(filePath) === "private" && classify(dirname(filePath)) === "private";
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
    const apply = options.applyWindowsPrivateAcl ?? applyWindowsPrivateAcl;
    const classify = options.classifyWindowsAcl ?? classifyWindowsPrivateAcl;
    return apply(directory) === true && classify(directory) === "private";
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
    } else if (!applyWindowsPrivateFileAcl(filePath)) return false;
    const after = lstatSync(filePath);
    return before.dev === after.dev && before.ino === after.ino && after.nlink === 1
      && privateFileAccessAccepted(filePath, after.mode, options);
  } catch {
    return false;
  }
}
