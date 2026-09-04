# install-host.ps1 - register the webmcp-tools native messaging host for Chrome (or Edge).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File installer/install-host.ps1
#   powershell -ExecutionPolicy Bypass -File installer/install-host.ps1 -Browser edge
#
# What it does:
#   1. Runs scripts/ensure-key.mjs to derive the deterministic extension ID
#      from the deterministic manifest key (repo-root key.pem).
#   2. Writes installer/com.webmcp.tools.host.generated.json (the native host
#      manifest) pointing at server/bin/webmcp-host.cmd.
#   3. Registers the manifest under HKCU (no admin needed).
[CmdletBinding()]
param(
    [ValidateSet("chrome", "edge")]
    [string]$Browser = "chrome"
)

$ErrorActionPreference = "Stop"

$HostName = "com.webmcp.tools.host"

$InstallerDir = $PSScriptRoot
if (-not $InstallerDir) {
    $InstallerDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$RepoRoot = (Resolve-Path (Join-Path $InstallerDir "..")).Path

# --- prerequisites -----------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "node was not found in PATH. Install Node.js 20+ first."
    exit 1
}

$EnsureKeyScript = Join-Path $RepoRoot "scripts\ensure-key.mjs"
if (-not (Test-Path -LiteralPath $EnsureKeyScript)) {
    Write-Error "Missing $EnsureKeyScript"
    exit 1
}

$HostLauncher = Join-Path $RepoRoot "server\bin\webmcp-host.cmd"
if (-not (Test-Path -LiteralPath $HostLauncher)) {
    Write-Error "Missing $HostLauncher"
    exit 1
}

$DistEntry = Join-Path $RepoRoot "server\dist\index.js"
if (-not (Test-Path -LiteralPath $DistEntry)) {
    Write-Warning "server\dist\index.js not found. Build the server first:"
    Write-Warning "  cd server; npm install; npm run build"
}

# --- 1. derive the deterministic extension id --------------------------------
$KeyOutput = & node $EnsureKeyScript
if ($LASTEXITCODE -ne 0) {
    Write-Error "scripts/ensure-key.mjs failed (exit $LASTEXITCODE)."
    exit 1
}
$KeyJson = ($KeyOutput | Out-String)
# Be robust to any stray output around the JSON document.
$JsonStart = $KeyJson.IndexOf("{")
if ($JsonStart -lt 0) {
    Write-Error "Could not parse output of ensure-key.mjs: $KeyJson"
    exit 1
}
$KeyInfo = $KeyJson.Substring($JsonStart) | ConvertFrom-Json
$ExtensionId = $KeyInfo.extensionId
if (-not $ExtensionId -or $ExtensionId -notmatch '^[a-p]{32}$') {
    Write-Error "Unexpected extension id from ensure-key.mjs: '$ExtensionId'"
    exit 1
}

# --- 2. write the native host manifest ---------------------------------------
$ManifestPath = Join-Path $InstallerDir "$HostName.generated.json"
$Manifest = [ordered]@{
    name            = $HostName
    description     = "WebMCP Tools bridge: connects the Chrome extension to the webmcp-browser MCP server"
    path            = $HostLauncher
    type            = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
$Manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ManifestPath -Encoding ascii
Write-Host "Wrote native host manifest: $ManifestPath"

# --- 3. register under HKCU --------------------------------------------------
$RegRoot = if ($Browser -eq "edge") {
    "HKCU\Software\Microsoft\Edge\NativeMessagingHosts"
} else {
    "HKCU\Software\Google\Chrome\NativeMessagingHosts"
}
$RegKey = "$RegRoot\$HostName"

# reg.exe writes status to stdout; keep it quiet. Errors still set $LASTEXITCODE.
& reg.exe add $RegKey /ve /t REG_SZ /d $ManifestPath /f | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error "reg.exe add failed for $RegKey (exit $LASTEXITCODE)."
    exit 1
}

$BrowserDisplayName = if ($Browser -eq "edge") { "Microsoft Edge" } else { "Google Chrome" }

Write-Host ""
Write-Host "Installed native messaging host '$HostName' for $BrowserDisplayName (current user, no admin)."
Write-Host "  Extension ID : $ExtensionId"
Write-Host "  Manifest     : $ManifestPath"
Write-Host "  Launcher     : $HostLauncher"
Write-Host ""
Write-Host "Next step: open ${BrowserDisplayName}, go to extensions (chrome://extensions),"
Write-Host "enable Developer mode, then 'Load unpacked' and select:"
Write-Host "  $RepoRoot\extension"
Write-Host ""
Write-Host "The extension id shown there should be: $ExtensionId"
