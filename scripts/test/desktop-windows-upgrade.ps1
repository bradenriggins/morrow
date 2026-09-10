[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $OldInstaller,
  [Parameter(Mandatory = $true)][string] $OldSha256,
  [Parameter(Mandatory = $true)][string] $OldSourceHead,
  [Parameter(Mandatory = $true)][string] $NewInstaller,
  [Parameter(Mandatory = $true)][string] $NewSha256,
  [Parameter(Mandatory = $true)][string] $NewSourceHead,
  [Parameter(Mandatory = $true)][string] $InstallDirectory,
  [Parameter(Mandatory = $true)][string] $StateDirectory,
  [Parameter(Mandatory = $true)][string] $Receipt
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:MORROW_INSTALLER_TEST_MODE = '1'
$InstallTimeoutMs = 240000
$ApplicationTimeoutMs = 300000
$NativeWindowsPowerShellModulePath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules'
$PinnedOldSha256 = '2750cd7b6746fb7f6701a92920158691eb9ad787732826597f6de4c3ed0fadf1'
$PinnedOldSourceHead = '3720b76bfd5dc5d132627777be4034bf9ef0dae5'
$PrivateAclClassification = 'current_user_system_admin_sensitive_access_only'
$Pinned3720LegacyAclClassification = 'additional_principal_sensitive_access_allow'
$ExpectedWindowsApplicationMetadata = [ordered]@{
  companyName = 'Braden Riggins'
  productName = 'Morrow'
  fileDescription = 'Morrow'
  fileVersion = '1.0.4'
  productVersion = '1.0.4.0'
}

function Assert-AbsolutePath([string] $Name, [string] $Value) {
  if (-not [IO.Path]::IsPathFullyQualified($Value)) { throw "$Name must be an absolute path." }
}

function Hash([string] $Path) {
  $deadline = (Get-Date).AddSeconds(20)
  do {
    try { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() }
    catch {
      if ((Get-Date) -ge $deadline) { throw }
      Start-Sleep -Milliseconds 250
    }
  } while ($true)
}

function Run-Process([string] $Path, [string[]] $Arguments, [int] $TimeoutMs, [string] $Label) {
  $previousModulePath = $env:PSModulePath
  try {
    $env:PSModulePath = $NativeWindowsPowerShellModulePath
    $process = Start-Process -FilePath $Path -ArgumentList $Arguments -PassThru
  } finally {
    if ($null -eq $previousModulePath) { Remove-Item Env:PSModulePath -ErrorAction SilentlyContinue }
    else { $env:PSModulePath = $previousModulePath }
  }
  if (-not $process.WaitForExit($TimeoutMs)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "$Label did not exit in $TimeoutMs ms."
  }
  if ($process.ExitCode -ne 0) { throw "$Label exited $($process.ExitCode)." }
}

function Install-App([string] $Installer) {
  Run-Process $Installer @('/S', "/D=$InstallDirectory") $InstallTimeoutMs 'Morrow installer'
  if (-not (Test-Path -LiteralPath "$InstallDirectory\Morrow.exe" -PathType Leaf)) { throw 'Installed application is absent.' }
}

function Assert-ReadyReceipt($Value, [string] $Label, [bool] $RequireGatewayReady = $true, [bool] $AllowPinned3720Acl = $false) {
  if ($Value.schema -ne 'morrow.desktop-windows-smoke.v1' -or -not $Value.runtime.ready -or -not $Value.health.attempted `
    -or ($RequireGatewayReady -and -not $Value.health.gatewayReady)) {
    $trace = $Value.runtimeTrace | ConvertTo-Json -Depth 8 -Compress
    throw "The $Label packaged runtime did not become ready: runtime=$($Value.runtime.ready), attempted=$($Value.health.attempted), gateway=$($Value.health.gatewayReady), trace=$trace."
  }
  $private = $PrivateAclClassification
  $legacy = $Pinned3720LegacyAclClassification
  $stateAcl = $Value.stateSecurity.state.acl
  $descriptorAcl = $Value.stateSecurity.descriptor.acl
  $privateAcl = $stateAcl -eq $private -and $descriptorAcl -eq $private
  $allowedPinned3720Acl = $AllowPinned3720Acl -and $stateAcl -eq $legacy -and $descriptorAcl -eq $legacy
  if (-not $privateAcl -and -not $allowedPinned3720Acl) {
    throw "The private Windows state ACL classification is absent: state=$($Value.stateSecurity.state.acl), descriptor=$($Value.stateSecurity.descriptor.acl)."
  }
}

function Run-App([string] $Label, [bool] $RequireGatewayReady = $true, [bool] $AllowPinned3720Acl = $false) {
  $appReceipt = Join-Path $StateDirectory "$Label.json"
  if (Test-Path -LiteralPath $appReceipt) { throw "The $Label application receipt already exists." }
  Run-Process "$InstallDirectory\Morrow.exe" @(
    "--morrow-test-root=$StateDirectory",
    "--morrow-smoke-receipt=$appReceipt",
    '--morrow-smoke-install-codex'
  ) $ApplicationTimeoutMs 'Morrow application'
  $value = Get-Content -LiteralPath $appReceipt -Raw | ConvertFrom-Json
  Copy-Item -LiteralPath $appReceipt -Destination (Join-Path (Split-Path -Parent $Receipt) "upgrade-$Label.json")
  Assert-ReadyReceipt $value $Label $RequireGatewayReady $AllowPinned3720Acl
  return $value
}

function Package-Source {
  $manifest = Get-Content -LiteralPath "$InstallDirectory\resources\MorrowPayload\app\package-input-manifest.json" -Raw | ConvertFrom-Json
  if ($manifest.schema -ne 'morrow.desktop-package-input.v1' -or $manifest.source.dirty -ne $false) {
    throw 'The installed package source binding is unavailable or dirty.'
  }
  return $manifest.source.head
}

function App-Metadata {
  $app = Get-Item -LiteralPath "$InstallDirectory\Morrow.exe"
  $signature = Get-AuthenticodeSignature -LiteralPath $app.FullName
  return [ordered]@{
    sha256 = Hash $app.FullName
    fileVersion = $app.VersionInfo.FileVersion
    productVersion = $app.VersionInfo.ProductVersion
    productName = $app.VersionInfo.ProductName
    companyName = $app.VersionInfo.CompanyName
    fileDescription = $app.VersionInfo.FileDescription
    signatureStatus = $signature.Status.ToString()
    signerCertificate = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
  }
}

function Assert-AppMetadata($Value) {
  $mismatches = @($ExpectedWindowsApplicationMetadata.GetEnumerator() | ForEach-Object {
    $actual = $Value[$_.Key]
    if ($actual -ne $_.Value) { "$($_.Key)=$actual (expected $($_.Value))" }
  } | Where-Object { $_ })
  if ($mismatches.Count -ne 0) {
    throw "The installed application metadata is wrong: $($mismatches -join '; ')."
  }
}

function Registry-Matches {
  $roots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKCU:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
  )
  return @($roots | ForEach-Object {
    if (Test-Path -LiteralPath $_) {
      Get-ChildItem -LiteralPath $_ -ErrorAction SilentlyContinue | ForEach-Object {
        $entry = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
        if ($entry.UninstallString -like "*$InstallDirectory*" -or $entry.DisplayIcon -like "$InstallDirectory*") {
          [ordered]@{
            key = $_.Name
            displayName = $entry.DisplayName
            displayVersion = $entry.DisplayVersion
            publisher = $entry.Publisher
            uninstallString = $entry.UninstallString
          }
        }
      }
    }
  })
}

function Residual-Processes {
  return @(Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $PID -and (($_.ExecutablePath -and $_.ExecutablePath -like "$InstallDirectory*") -or
      ($_.CommandLine -and ($_.CommandLine -like "*$InstallDirectory*" -or $_.CommandLine -like "*$StateDirectory*")))
  } | Select-Object ProcessId, Name, ExecutablePath, CommandLine)
}

function Residual-Shortcuts {
  $shortcutRoots = @([Environment]::GetFolderPath('Desktop'), "$env:APPDATA\Microsoft\Windows\Start Menu\Programs")
  $shell = New-Object -ComObject WScript.Shell
  return @($shortcutRoots | ForEach-Object {
    if ($_ -and (Test-Path -LiteralPath $_)) {
      Get-ChildItem -LiteralPath $_ -Filter '*Morrow*.lnk' -File -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
        $target = $shell.CreateShortcut($_.FullName).TargetPath
        if ($target -like "$InstallDirectory*") { [ordered]@{ target = $target } }
      }
    }
  })
}

function Uninstall-CleanupSnapshot {
  return [ordered]@{
    installDirectoryPresent = [bool](Test-Path -LiteralPath $InstallDirectory)
    registration = @(Registry-Matches)
    shortcuts = @(Residual-Shortcuts)
    processes = @(Residual-Processes)
  }
}

function Test-UninstallComplete($Snapshot) {
  return -not $Snapshot.installDirectoryPresent -and $Snapshot.registration.Count -eq 0 `
    -and $Snapshot.shortcuts.Count -eq 0 -and $Snapshot.processes.Count -eq 0
}

function Capture-Files($Targets) {
  return @($Targets | ForEach-Object {
    $present = Test-Path -LiteralPath $_.path -PathType Leaf
    [ordered]@{ id = $_.id; path = $_.path; present = $present; sha256 = if ($present) { Hash $_.path } else { $null } }
  })
}

function Assert-Present($Entries, [string] $Label) {
  $missing = @($Entries | Where-Object { -not $_.present })
  if ($missing.Count -ne 0) { throw "$Label is absent: $($missing.id -join ', ')." }
}

function Compare-Files($Before, $After, [string] $Label) {
  $comparison = @($Before | ForEach-Object {
    $prior = $_
    $current = @($After | Where-Object { $_.id -eq $prior.id })
    [ordered]@{
      id = $prior.id
      sha256Before = $prior.sha256
      presentAfter = $current.Count -eq 1 -and $current[0].present
      sha256After = if ($current.Count -eq 1) { $current[0].sha256 } else { $null }
      unchanged = $current.Count -eq 1 -and $current[0].present -and $current[0].sha256 -eq $prior.sha256
    }
  })
  if (@($comparison | Where-Object { -not $_.unchanged }).Count -ne 0) { throw "$Label changed or was removed." }
  return $comparison
}

if ($env:OS -ne 'Windows_NT') { throw 'The Windows upgrade harness requires Windows.' }
foreach ($entry in @(
  @('OldInstaller', $OldInstaller), @('NewInstaller', $NewInstaller), @('InstallDirectory', $InstallDirectory),
  @('StateDirectory', $StateDirectory), @('Receipt', $Receipt)
)) { Assert-AbsolutePath $entry[0] $entry[1] }
if ($OldSha256 -notmatch '^[a-f0-9]{64}$' -or $NewSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Expected installer hashes must be lowercase SHA-256 values.' }
if ($OldSourceHead -notmatch '^[a-f0-9]{40}$' -or $NewSourceHead -notmatch '^[a-f0-9]{40}$') { throw 'Expected source heads must be lowercase Git object ids.' }
if ($OldSha256 -ne $PinnedOldSha256 -or $OldSourceHead -ne $PinnedOldSourceHead) { throw 'The old installer inputs are not the pinned published 3720 build.' }
$localAppDataRoot = [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\') + '\'
$resolvedStateDirectory = [IO.Path]::GetFullPath($StateDirectory)
if (-not $resolvedStateDirectory.StartsWith($localAppDataRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The upgrade state directory must use this account local application data boundary.'
}
if (-not (Test-Path -LiteralPath $OldInstaller -PathType Leaf) -or -not (Test-Path -LiteralPath $NewInstaller -PathType Leaf)) {
  throw 'Both installer inputs must be regular files.'
}
if (Test-Path -LiteralPath $InstallDirectory) { throw 'The upgrade install directory must be new.' }
if (Test-Path -LiteralPath $StateDirectory) { throw 'The upgrade state directory must be new.' }
if (Test-Path -LiteralPath $Receipt) { throw 'The upgrade receipt already exists.' }
if ((Hash $OldInstaller) -ne $OldSha256) { throw 'The published installer has the wrong hash.' }
if ((Hash $NewInstaller) -ne $NewSha256) { throw 'The new installer has the wrong hash.' }
New-Item -ItemType Directory -Path $StateDirectory -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $Receipt) -Force | Out-Null

Install-App $OldInstaller
$oldSource = Package-Source
if ($oldSource -ne $OldSourceHead) { throw 'The published installer has the wrong source binding.' }
$oldCold = Run-App 'before-upgrade-cold' $false $true
$oldRetryUsed = -not $oldCold.health.gatewayReady
$oldReady = if ($oldRetryUsed) { Run-App 'before-upgrade-retry' $true $true } else { $oldCold }

$material = Join-Path $StateDirectory 'retained-course-material.txt'
[IO.File]::WriteAllText($material, "Keep this isolated course material through the installer upgrade.`n", [Text.UTF8Encoding]::new($false))
$retainedTargets = @(
  [ordered]@{ id = 'course_material'; path = $material },
  [ordered]@{ id = 'assistant_configuration'; path = "$StateDirectory\Home\.codex\config.toml" }
)
$stateTargets = @(
  [ordered]@{ id = 'state_upstreams'; path = "$StateDirectory\UserData\State\morrow.upstreams.json" },
  [ordered]@{ id = 'state_journal'; path = "$StateDirectory\UserData\State\morrow.sqlite3" }
)
$retainedBefore = Capture-Files $retainedTargets
$stateBefore = Capture-Files $stateTargets
Assert-Present $retainedBefore 'Required retained data'
Assert-Present $stateBefore 'Required application state'

Install-App $NewInstaller
$newSource = Package-Source
if ($newSource -ne $NewSourceHead -or $newSource -eq $oldSource) { throw 'The new installer did not replace the published packaged source.' }
$stateAfterInstall = Compare-Files $stateBefore (Capture-Files $stateTargets) 'The installer upgrade application state'
$newReady = Run-App 'after-upgrade'
$newApp = App-Metadata
Assert-AppMetadata $newApp
if ($newApp.signatureStatus -ne 'NotSigned' -or $newApp.signerCertificate) { throw 'The private QA application is not the expected unsigned build.' }

$retainedAfterUpgrade = Compare-Files $retainedBefore (Capture-Files $retainedTargets) 'The installer upgrade retained data'
$stateAfterUpgrade = Capture-Files $stateTargets
Assert-Present $stateAfterUpgrade 'Application state after upgrade'
$registryAfterUpgrade = @(Registry-Matches)
if ($registryAfterUpgrade.Count -ne 1) { throw "Expected one current-user Morrow registration after upgrade; found $($registryAfterUpgrade.Count)." }
if ($registryAfterUpgrade[0].publisher -ne 'Braden Riggins' -or $registryAfterUpgrade[0].displayName -ne 'Morrow 1.0.4' -or $registryAfterUpgrade[0].displayVersion -ne '1.0.4') {
  throw 'The uninstall registration metadata is wrong.'
}

$uninstaller = "$InstallDirectory\Uninstall Morrow.exe"
$uninstallSignature = (Get-AuthenticodeSignature -LiteralPath $uninstaller).Status.ToString()
if ($uninstallSignature -ne 'NotSigned') { throw 'The private QA uninstaller is not the expected unsigned build.' }
Run-Process $uninstaller @('/S', "/D=$InstallDirectory") $InstallTimeoutMs 'Morrow uninstaller'
$cleanupDeadline = (Get-Date).AddSeconds(30)
do {
  $uninstallSnapshot = Uninstall-CleanupSnapshot
  if (Test-UninstallComplete $uninstallSnapshot) { break }
  Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $cleanupDeadline)
$retainedAfterUninstall = Compare-Files $retainedBefore (Capture-Files $retainedTargets) 'The uninstaller retained data'
$stateAfterUninstall = Compare-Files $stateAfterUpgrade (Capture-Files $stateTargets) 'The uninstaller retained application state'
$registryAfterUninstall = @($uninstallSnapshot.registration)
$processesAfterUninstall = @($uninstallSnapshot.processes)
$shortcutsAfterUninstall = @($uninstallSnapshot.shortcuts)
if (-not (Test-UninstallComplete $uninstallSnapshot)) {
  $residue = [ordered]@{
    schema = 'morrow.native-windows-upgrade-uninstall-residue.v1'
    capturedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    installDirectoryPresent = [bool]$uninstallSnapshot.installDirectoryPresent
    registration = @($registryAfterUninstall | ForEach-Object { [ordered]@{
      key = $_.key; displayName = $_.displayName; displayVersion = $_.displayVersion; publisher = $_.publisher
      uninstallReferencesInstall = [bool]($_.uninstallString -like "*$InstallDirectory*")
    } })
    shortcuts = @($shortcutsAfterUninstall | ForEach-Object { [ordered]@{ target = $_.target } })
    processes = @($processesAfterUninstall | ForEach-Object { [ordered]@{
      processId = $_.ProcessId; name = $_.Name
      executableReferencesInstall = [bool]($_.ExecutablePath -and $_.ExecutablePath -like "$InstallDirectory*")
      commandReferencesInstall = [bool]($_.CommandLine -and $_.CommandLine -like "*$InstallDirectory*")
      commandReferencesState = [bool]($_.CommandLine -and $_.CommandLine -like "*$StateDirectory*")
    } })
    counts = [ordered]@{ installation = [int][bool]$uninstallSnapshot.installDirectoryPresent; registration = $registryAfterUninstall.Count; shortcuts = $shortcutsAfterUninstall.Count; processes = $processesAfterUninstall.Count }
  }
  $residuePath = Join-Path (Split-Path -Parent $Receipt) 'upgrade-uninstall-residue.json'
  [IO.File]::WriteAllText($residuePath, ($residue | ConvertTo-Json -Depth 8) + "`n", [Text.UTF8Encoding]::new($false))
  throw "The uninstaller did not finish complete cleanup before the deadline; residue receipt=$residuePath."
}

$result = [ordered]@{
  schema = 'morrow.native-windows-upgrade.v1'
  capturedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
  oldArtifact = [ordered]@{ role = 'published_v1.0.0'; sha256 = $OldSha256; source = $oldSource }
  newArtifact = [ordered]@{ role = 'workflow_build'; sha256 = $NewSha256; source = $newSource }
  beforeReady = [bool]($oldReady.runtime.ready -and $oldReady.health.gatewayReady)
  beforeReadiness = [ordered]@{
    coldGatewayReady = [bool]$oldCold.health.gatewayReady
    retryUsed = [bool]$oldRetryUsed
    retryUsedIffColdNotReady = [bool]($oldRetryUsed -eq (-not [bool]$oldCold.health.gatewayReady))
    finalGatewayReady = [bool]$oldReady.health.gatewayReady
  }
  afterReady = [bool]($newReady.runtime.ready -and $newReady.health.gatewayReady)
  stateSecurity = [ordered]@{
    before = [ordered]@{
      stateAcl = $oldReady.stateSecurity.state.acl
      descriptorAcl = $oldReady.stateSecurity.descriptor.acl
      acceptedAs = if ($oldReady.stateSecurity.state.acl -eq $PrivateAclClassification) { 'private' } else { 'pinned_3720_legacy' }
    }
    after = [ordered]@{
      stateAcl = $newReady.stateSecurity.state.acl
      descriptorAcl = $newReady.stateSecurity.descriptor.acl
      acceptedAs = 'private'
    }
  }
  privateAclBefore = $oldReady.stateSecurity.state.acl
  privateAclAfter = $newReady.stateSecurity.state.acl
  retainedAfterUpgrade = @($retainedAfterUpgrade | ForEach-Object { [ordered]@{ id = $_.id; sha256Before = $_.sha256Before; sha256After = $_.sha256After; unchanged = $_.unchanged } })
  statePresentAfterUpgrade = [bool](@($stateAfterUpgrade | Where-Object { -not $_.present }).Count -eq 0)
  retention = [ordered]@{
    exactAcrossUpgrade = @($retainedAfterUpgrade | ForEach-Object { [ordered]@{ id = $_.id; sha256Before = $_.sha256Before; sha256After = $_.sha256After; unchanged = $_.unchanged } })
    applicationStateExactAfterInstall = @($stateAfterInstall | ForEach-Object { [ordered]@{ id = $_.id; sha256Before = $_.sha256Before; sha256After = $_.sha256After; unchanged = $_.unchanged } })
    applicationStateAfterRuntime = [ordered]@{
      ids = @($stateTargets | ForEach-Object { $_.id })
      presentAfterUpgrade = [bool](@($stateAfterUpgrade | Where-Object { -not $_.present }).Count -eq 0)
      exactAcrossUninstall = [bool](@($stateAfterUninstall | Where-Object { -not $_.unchanged }).Count -eq 0)
    }
  }
  newApplication = $newApp
  registration = [ordered]@{ displayName = $registryAfterUpgrade[0].displayName; displayVersion = $registryAfterUpgrade[0].displayVersion; publisher = $registryAfterUpgrade[0].publisher }
  uninstall = [ordered]@{
    completed = $true
    uninstallerSignatureStatus = $uninstallSignature
    dataRetained = [bool](@($retainedAfterUninstall | Where-Object { -not $_.unchanged }).Count -eq 0)
    stateRetained = [bool](@($stateAfterUninstall | Where-Object { -not $_.unchanged }).Count -eq 0)
    registryCount = $registryAfterUninstall.Count
    shortcutCount = $shortcutsAfterUninstall.Count
    processCount = $processesAfterUninstall.Count
  }
}
[IO.File]::WriteAllText($Receipt, ($result | ConvertTo-Json -Depth 12) + "`n", [Text.UTF8Encoding]::new($false))
$result | ConvertTo-Json -Depth 12
