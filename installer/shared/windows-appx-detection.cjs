const APPX_QUERY_MAX_BYTES = 8 * 1024;

// This is the identity in the signed ChatGPT-x64.msix release inspected on
// 2026-09-06. The package family remains stable across version updates.
// `.github/workflows/windows-chatgpt-inventory.yml` is the read-only inventory
// that reports these same fields. Run it on a Windows host that has the
// desktop assistant installed to re-derive them; a host without it installed
// reports an empty package list, which is not a contradiction of this record.
const CODEX_WINDOWS_APPX_IDENTITY = Object.freeze({
  name: "OpenAI.Codex",
  publisher: "CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B",
  publisherId: "2p2nqsd0c76g0",
  packageFamilyName: "OpenAI.Codex_2p2nqsd0c76g0",
  applicationId: "App",
  applicationUserModelId: "OpenAI.Codex_2p2nqsd0c76g0!App",
  executable: "app/ChatGPT.exe"
});

const WINDOWS_CODEX_APPX_QUERY = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "$packages = @(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; publisher = [string]$_.Publisher; packageFamilyName = [string]$_.PackageFamilyName; packageFullName = [string]$_.PackageFullName; signatureKind = [string]$_.SignatureKind; status = [string]$_.Status; architecture = [string]$_.Architecture } })",
  "$packages | ConvertTo-Json -Compress"
].join("; ");

function parseAppxPackages(output) {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > APPX_QUERY_MAX_BYTES) return null;
  const value = output.trim();
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
    return parsed && typeof parsed === "object" ? [parsed] : null;
  } catch {
    return null;
  }
}

function hasExpectedPackageFullName(fullName) {
  return typeof fullName === "string"
    && /^OpenAI\.Codex_[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+_(?:x64|arm64)__2p2nqsd0c76g0$/.test(fullName);
}

function isTrustedCodexAppxPackage(candidate) {
  return Boolean(candidate
    && typeof candidate === "object"
    && candidate.name === CODEX_WINDOWS_APPX_IDENTITY.name
    && candidate.publisher === CODEX_WINDOWS_APPX_IDENTITY.publisher
    && candidate.packageFamilyName === CODEX_WINDOWS_APPX_IDENTITY.packageFamilyName
    && candidate.signatureKind === "Store"
    && candidate.status === "Ok"
    && (candidate.architecture === "x64" || candidate.architecture === "arm64")
    && hasExpectedPackageFullName(candidate.packageFullName));
}

async function detectWindowsCodexPackage({ assistantId, runPowerShell }) {
  if (assistantId !== "codex") return false;
  if (typeof runPowerShell !== "function") {
    throw new TypeError("Windows Codex package detection requires a PowerShell runner.");
  }
  let output;
  try {
    output = await runPowerShell(WINDOWS_CODEX_APPX_QUERY);
  } catch {
    return false;
  }
  const packages = parseAppxPackages(output);
  return Array.isArray(packages) && packages.length === 1 && isTrustedCodexAppxPackage(packages[0]);
}

module.exports = {
  APPX_QUERY_MAX_BYTES,
  CODEX_WINDOWS_APPX_IDENTITY,
  WINDOWS_CODEX_APPX_QUERY,
  detectWindowsCodexPackage,
  hasExpectedPackageFullName,
  isTrustedCodexAppxPackage,
  parseAppxPackages
};
