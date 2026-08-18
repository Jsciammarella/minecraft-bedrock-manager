#Requires -Version 5.1
# ============================================
# In-place upgrade for Docker Desktop on Windows
# ============================================
# Pulls the latest application code and rebuilds without deleting .env or
# Docker volumes. Never runs docker compose down -v.
#
#   powershell -ExecutionPolicy Bypass -File .\scripts\upgrade.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\upgrade.ps1 -Yes
# ============================================

[CmdletBinding()]
param(
    [Alias('h')]
    [switch]$Help,
    [switch]$Yes,
    [switch]$SkipBackup,
    [switch]$Resume
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($Help) {
    Write-Host @'
Upgrade the Minecraft Bedrock Server Manager in place on Windows.

Preserved: .env, Docker volumes (mc-data, mc-logs), worlds, mods, and settings.
Not preserved across the restart: running Bedrock processes. Start them again
from the dashboard after the upgrade.

Options:
  -Yes           Do not prompt for confirmation
  -SkipBackup    Do not copy data to upgrade-backups\
  -Help          Show this help
'@
    exit 0
}

$helpers = Join-Path $PSScriptRoot 'windows.ps1'
. $helpers

$appDir = Get-McAppDir
Set-Location -LiteralPath $appDir

if (-not (Test-Path -LiteralPath (Join-Path $appDir 'docker-compose.wsl.yml'))) {
    throw 'Run this script from a Minecraft Bedrock Server Manager checkout.'
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'git is required. Install Git for Windows: https://git-scm.com/downloads/win'
}
& git rev-parse --is-inside-work-tree 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw 'This directory is not a git checkout.'
}

Assert-McDockerLinuxEngine

function Backup-McDockerData {
    param([string]$Dest)
    New-Item -ItemType Directory -Force -Path $Dest | Out-Null
    $envfile = Get-McEnvFile
    if (Test-Path -LiteralPath $envfile) {
        Copy-Item -LiteralPath $envfile -Destination (Join-Path $Dest 'env')
    }
    $running = $false
    & docker inspect mc-server-manager 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        $running = $true
    }
    if ($running) {
        Invoke-McCompose -ComposeArgs @('cp', 'mc-manager:/app/data', (Join-Path $Dest 'data'))
        return
    }
    Write-McWarn 'No running manager container found; skipped data copy. Named volumes are left in place.'
}

$branch = (& git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -eq 'HEAD') {
    throw 'Checkout is in a detached HEAD state. Check out a branch such as main.'
}

if (-not $Resume) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backupDir = Join-Path $appDir (Join-Path 'upgrade-backups' $stamp)

    Write-Host ''
    Write-McLog 'Minecraft Bedrock Server Manager in-place upgrade'
    Write-Host "Install directory: $appDir"
    Write-Host 'Detected mode:     docker (Windows / Docker Desktop)'
    Write-Host ''
    Write-Host 'This keeps:'
    Write-Host '  - .env'
    Write-Host '  - Docker volumes mc-data and mc-logs'
    Write-Host ''
    Write-Host 'This will:'
    Write-Host '  - git pull --ff-only the current branch'
    Write-Host '  - rebuild and restart the manager'
    Write-Host '  - stop running Bedrock servers for the restart (start them again from the dashboard)'
    if ($SkipBackup) {
        Write-Host '  - skip the local backup copy'
    } else {
        Write-Host "  - copy current data to $backupDir"
    }
    Write-Host ''
    Write-Host 'This will not:'
    Write-Host '  - run docker compose down -v'
    Write-Host '  - delete named volumes'
    Write-Host '  - overwrite existing .env values'

    if (-not $Yes) {
        $answer = Read-Host 'Continue with the in-place upgrade? [y/N]'
        if ($answer -notin @('y', 'Y')) {
            throw 'Upgrade cancelled.'
        }
    }

    $dirty = & git status --porcelain --untracked-files=no
    if ($dirty) {
        Write-Host $dirty
        throw 'Tracked files have local changes. Commit, stash, or revert them, then rerun.'
    }

    Write-McLog 'Stopping managed Bedrock servers (if the API is up)...'
    Stop-McManagedServers

    if (-not $SkipBackup) {
        Write-McLog "Backing up configuration and data to $backupDir"
        Backup-McDockerData -Dest $backupDir
        Write-McLog 'Backup complete.'
    } else {
        $backupDir = ''
    }

    Write-McLog "Fetching $branch..."
    & git fetch origin $branch
    if ($LASTEXITCODE -ne 0) { throw 'git fetch failed.' }
    & git pull --ff-only origin $branch
    if ($LASTEXITCODE -ne 0) { throw 'git pull --ff-only failed.' }

    Write-McLog 'Reloading the upgrade script so the messages match this branch...'
    $env:MC_UPGRADE_BACKUP_DIR = $backupDir
    $resumeArgs = @('-Yes', '-Resume', '-SkipBackup')
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath @resumeArgs
    exit $LASTEXITCODE
}

$backupDir = $env:MC_UPGRADE_BACKUP_DIR
Write-McLog "Continuing upgrade with the scripts from $branch..."

Merge-McNewEnvKeys
Initialize-McWindowsEnv

Write-McLog 'Rebuilding and recreating the manager container (volumes are left in place)...'
Invoke-McCompose -ComposeArgs @('up', '-d', '--build')

Wait-McManagerHealth
Write-McLog 'Upgrade finished.'
Write-McConnectUrls
Write-Host ''
Write-Host 'Start Bedrock servers from the dashboard if they were running before the upgrade.'
if ($backupDir) {
    Write-Host "Backup kept at: $backupDir"
    Write-Host 'Remove old copies under upgrade-backups\ when you no longer need them.'
}
