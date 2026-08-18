#Requires -Version 5.1
# ============================================
# One-step Docker Desktop install for Windows
# ============================================
# Prerequisite: Docker Desktop (Linux containers) must already be installed
# and running. Git is required for the README one-liner clone.
#
#   git clone https://sci-gitlab-01.sciamfam.com/jamey/minecraft-bedrock-manager.git; powershell -ExecutionPolicy Bypass -File .\minecraft-bedrock-manager\scripts\install-docker.ps1
# ============================================

[CmdletBinding()]
param(
    [Alias('h')]
    [switch]$Help,
    [switch]$SkipFirewall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($Help) {
    Write-Host @'
Install Minecraft Bedrock Server Manager with Docker Desktop on Windows.

Prerequisite: Docker Desktop with Linux containers.
  https://docs.docker.com/desktop/setup/install/windows-install/

From PowerShell, after cloning this repository:

  powershell -ExecutionPolicy Bypass -File .\scripts\install-docker.ps1

Options:
  -SkipFirewall   Do not add Windows Firewall rules
  -Help           Show this help
'@
    exit 0
}

$helpers = Join-Path $PSScriptRoot 'windows.ps1'
. $helpers

$appDir = Get-McAppDir
$composeFile = Get-McComposeFile
if (-not (Test-Path -LiteralPath $composeFile)) {
    throw "Run this script from a Minecraft Bedrock Server Manager checkout (missing docker-compose.wsl.yml)."
}

Assert-McDockerLinuxEngine
Set-Location -LiteralPath $appDir

$envfile = Get-McEnvFile
if (Test-Path -LiteralPath $envfile) {
    Write-McLog 'Existing .env found. Running an in-place upgrade so worlds, mods, and settings are kept.'
    Write-Host 'Do not clone into a new directory to update. That can create new Docker volumes.'
    $upgrade = Join-Path $PSScriptRoot 'upgrade.ps1'
    & $upgrade -Yes
    exit $LASTEXITCODE
}

Copy-Item -LiteralPath (Join-Path $appDir '.env.example') -Destination $envfile
Write-McLog 'Created .env from .env.example.'

Initialize-McWindowsEnv
$port = Get-McManagerPort

if (-not $SkipFirewall) {
    Install-McWindowsFirewall -Port $port
} else {
    Write-McWarn 'Skipped firewall configuration.'
}

Write-McLog 'Building and starting the manager (first build can take several minutes)...'
Invoke-McCompose -ComposeArgs @('up', '-d', '--build')

Write-McLog 'Install complete.'
Wait-McManagerHealth
Write-McConnectUrls
Write-Host ''
Write-Host 'Data is stored in Docker volumes mc-data and mc-logs. Never run docker compose down -v.'
Write-Host 'Later updates from this folder: powershell -ExecutionPolicy Bypass -File .\scripts\upgrade.ps1 -Yes'
