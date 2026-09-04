# uninstall-host.ps1 - remove the webmcp-tools native messaging host registration.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File installer/uninstall-host.ps1
#
# Removes the HKCU registration from both Chrome and Edge (missing keys are
# ignored) and deletes the generated host manifest.
$ErrorActionPreference = "Continue"

$HostName = "com.webmcp.tools.host"

$InstallerDir = $PSScriptRoot
if (-not $InstallerDir) {
    $InstallerDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}

$RemovedAny = $false
foreach ($Browser in @("chrome", "edge")) {
    $RegRoot = if ($Browser -eq "edge") {
        "HKCU\Software\Microsoft\Edge\NativeMessagingHosts"
    } else {
        "HKCU\Software\Google\Chrome\NativeMessagingHosts"
    }
    $RegKey = "$RegRoot\$HostName"
    # reg.exe delete prints an error to stderr when the key does not exist;
    # that is fine — we check existence first to keep the output clean.
    & reg.exe query $RegKey *> $null
    if ($LASTEXITCODE -eq 0) {
        & reg.exe delete $RegKey /f | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "Removed $Browser registration: $RegKey"
            $RemovedAny = $true
        } else {
            Write-Warning "Failed to remove $RegKey (exit $LASTEXITCODE)."
        }
    } else {
        Write-Host "No $Browser registration found (ok): $RegKey"
    }
}

$ManifestPath = Join-Path $InstallerDir "$HostName.generated.json"
if (Test-Path -LiteralPath $ManifestPath) {
    Remove-Item -LiteralPath $ManifestPath -Force
    Write-Host "Removed manifest: $ManifestPath"
    $RemovedAny = $true
} else {
    Write-Host "No manifest found (ok): $ManifestPath"
}

Write-Host ""
if ($RemovedAny) {
    Write-Host "webmcp-tools native host uninstalled. You may also remove the unpacked"
    Write-Host "extension from chrome://extensions."
} else {
    Write-Host "Nothing to uninstall."
}
