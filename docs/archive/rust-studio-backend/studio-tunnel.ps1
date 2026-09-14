#Requires -Version 5.1
# SSH tunnel to the server Celestea Studio web UI (binds 127.0.0.1 only).
# Local port 13777 by default: 3777 is the Studio port on the server.
# If 13777 is busy, the script picks the next free port automatically.
# Usage: keep this window open, then browse http://127.0.0.1:<port>
param(
    [string]$Target = "ubuntu-mc",
    [int]$LocalPort = 13777,
    [int]$RemotePort = 3777
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    Write-Error "OpenSSH client (ssh) not found."
    exit 1
}

$config = Join-Path $env:USERPROFILE ".ssh\config"
$key = Join-Path $env:USERPROFILE ".ssh\id_ed25519_pve_mc"
if (-not (Test-Path -LiteralPath $config)) {
    Write-Error ("Missing SSH config: {0}" -f $config)
    exit 1
}
if (-not (Test-Path -LiteralPath $key)) {
    Write-Error ("Missing private key: {0}" -f $key)
    exit 1
}

# Pick the first free local port starting from $LocalPort
$port = $LocalPort
while (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    $port++
}
if ($port -ne $LocalPort) {
    Write-Host ("Port {0} is busy, using {1} instead" -f $LocalPort, $port) -ForegroundColor Yellow
}

Write-Host "Tunnel: localhost:$port -> $Target`:$RemotePort" -ForegroundColor Cyan
Write-Host "  (Celestea Studio on the server only binds 127.0.0.1; keep this window open)" -ForegroundColor DarkGray
Write-Host "  Open: http://127.0.0.1:$port" -ForegroundColor White
Write-Host "  Ctrl+C to close the tunnel" -ForegroundColor DarkGray
Write-Host ""

& ssh -N -L "${port}:127.0.0.1:${RemotePort}" -o ExitOnForwardFailure=yes $Target
exit $LASTEXITCODE
