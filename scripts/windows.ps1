# Shared helpers for install-docker.ps1 and upgrade.ps1 (Windows PowerShell 5.1+).

$script:McUtf8NoBom = New-Object System.Text.UTF8Encoding $false

function Get-McAppDir {
    Split-Path -Parent $PSScriptRoot
}

function Write-McLog {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Green
}

function Write-McWarn {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Yellow
}

function Get-McEnvFile {
    Join-Path (Get-McAppDir) '.env'
}

function Get-McComposeFile {
    Join-Path (Get-McAppDir) 'docker-compose.wsl.yml'
}

function Get-McEnvValue {
    param(
        [string]$Key,
        [string]$Path = (Get-McEnvFile)
    )
    if (-not (Test-Path -LiteralPath $Path)) {
        return ''
    }
    $pattern = "^{0}=" -f [regex]::Escape($Key)
    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        if ($line -match $pattern) {
            return ($line.Substring($Key.Length + 1).Trim().Trim('"').Trim("'"))
        }
    }
    return ''
}

function Set-McEnvKey {
    param(
        [Parameter(Mandatory = $true)][string]$Key,
        [Parameter(Mandatory = $true)][string]$Value,
        [string]$Path = (Get-McEnvFile)
    )
    $lines = @()
    if (Test-Path -LiteralPath $Path) {
        $lines = [System.Collections.Generic.List[string]]::new()
        foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
            [void]$lines.Add($line)
        }
    } else {
        $lines = [System.Collections.Generic.List[string]]::new()
    }
    $pattern = "^{0}=" -f [regex]::Escape($Key)
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match $pattern) {
            $lines[$i] = "{0}={1}" -f $Key, $Value
            $found = $true
        }
    }
    if (-not $found) {
        [void]$lines.Add(("{0}={1}" -f $Key, $Value))
    }
    [System.IO.File]::WriteAllLines($Path, $lines.ToArray(), $script:McUtf8NoBom)
}

function Merge-McNewEnvKeys {
    $appDir = Get-McAppDir
    $example = Join-Path $appDir '.env.example'
    $envfile = Join-Path $appDir '.env'
    if (-not ((Test-Path -LiteralPath $example) -and (Test-Path -LiteralPath $envfile))) {
        return
    }
    foreach ($line in [System.IO.File]::ReadAllLines($example)) {
        if ($line -notmatch '^[A-Z_][A-Z0-9_]*=') {
            continue
        }
        $key = $line.Substring(0, $line.IndexOf('='))
        if (Select-String -LiteralPath $envfile -Pattern ("^{0}=" -f [regex]::Escape($key)) -Quiet) {
            continue
        }
        $text = [System.IO.File]::ReadAllText($envfile)
        if (-not $text.EndsWith("`n")) {
            $text += "`n"
        }
        $text += "$line`n"
        [System.IO.File]::WriteAllText($envfile, $text, $script:McUtf8NoBom)
        Write-McWarn "Added new .env key $key from .env.example (existing values were not changed)."
    }
}

function Test-McIPv4 {
    param([string]$Ip)
    return [bool]($Ip -match '^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$')
}

function Get-McWindowsLanIPv4 {
    try {
        $addrs = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object {
            $_.IPAddress -notlike '127.*' -and
            $_.IPAddress -notlike '169.254.*' -and
            $_.PrefixOrigin -ne 'WellKnown' -and
            $_.IPAddress -notmatch '^172\.(1[6-9]|2[0-9]|3[0-1])\.'
        })
        $ranked = $addrs | Sort-Object {
            if ($_.IPAddress -like '192.168.*') { 0 }
            elseif ($_.IPAddress -like '10.*') { 1 }
            else { 3 }
        }
        $ip = ($ranked | Select-Object -First 1).IPAddress
        if (Test-McIPv4 $ip) {
            return $ip
        }
    } catch {
        return ''
    }
    return ''
}

function Get-McIanaTimeZone {
    $windowsId = [TimeZoneInfo]::Local.Id
    $map = @{
        'Pacific Standard Time'         = 'America/Los_Angeles'
        'Mountain Standard Time'        = 'America/Denver'
        'US Mountain Standard Time'     = 'America/Phoenix'
        'Central Standard Time'         = 'America/Chicago'
        'Eastern Standard Time'         = 'America/New_York'
        'Alaskan Standard Time'         = 'America/Anchorage'
        'Hawaiian Standard Time'        = 'Pacific/Honolulu'
        'Atlantic Standard Time'        = 'America/Halifax'
        'Canada Central Standard Time'  = 'America/Regina'
        'Mexico Standard Time'          = 'America/Mexico_City'
        'SA Pacific Standard Time'      = 'America/Bogota'
        'UTC'                           = 'UTC'
        'GMT Standard Time'             = 'Europe/London'
        'Greenwich Standard Time'       = 'Atlantic/Reykjavik'
        'W. Europe Standard Time'       = 'Europe/Berlin'
        'Romance Standard Time'         = 'Europe/Paris'
        'Central Europe Standard Time'  = 'Europe/Budapest'
        'Central European Standard Time'= 'Europe/Warsaw'
        'GTB Standard Time'             = 'Europe/Bucharest'
        'FLE Standard Time'             = 'Europe/Helsinki'
        'Russian Standard Time'         = 'Europe/Moscow'
        'South Africa Standard Time'    = 'Africa/Johannesburg'
        'India Standard Time'           = 'Asia/Kolkata'
        'Singapore Standard Time'       = 'Asia/Singapore'
        'China Standard Time'           = 'Asia/Shanghai'
        'Tokyo Standard Time'           = 'Asia/Tokyo'
        'Korea Standard Time'           = 'Asia/Seoul'
        'AUS Eastern Standard Time'     = 'Australia/Sydney'
        'E. Australia Standard Time'    = 'Australia/Brisbane'
        'Cen. Australia Standard Time'  = 'Australia/Adelaide'
        'W. Australia Standard Time'    = 'Australia/Perth'
        'New Zealand Standard Time'     = 'Pacific/Auckland'
        'Israel Standard Time'          = 'Asia/Jerusalem'
        'Arabian Standard Time'         = 'Asia/Riyadh'
        'Middle East Standard Time'     = 'Asia/Beirut'
    }
    if ($map.ContainsKey($windowsId)) {
        return $map[$windowsId]
    }
    try {
        $converted = $null
        if ([TimeZoneInfo].GetMethod('TryConvertWindowsIdToIanaId')) {
            if ([TimeZoneInfo]::TryConvertWindowsIdToIanaId($windowsId, [ref]$converted) -and $converted) {
                return $converted
            }
        }
    } catch {
    }
    return ''
}

function Get-McManagerHostname {
    $name = [string]$env:COMPUTERNAME
    $name = $name.ToLowerInvariant() -replace '[^a-z0-9.-]', '-'
    $name = $name.Trim('-')
    if (-not $name) {
        return 'mc-server-manager'
    }
    if ($name.Length -gt 63) {
        $name = $name.Substring(0, 63).Trim('-')
    }
    return $name
}

function Assert-McDockerLinuxEngine {
    $docker = Get-Command docker -ErrorAction SilentlyContinue
    if (-not $docker) {
        throw @"
Docker is not installed, or it is not on PATH.

Install Docker Desktop for Windows, choose Linux containers, start it, then re-run this script:
https://docs.docker.com/desktop/setup/install/windows-install/
"@
    }
    $null = & docker info 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Desktop is installed but not ready. Start Docker Desktop, wait until it is running, then re-run this script."
    }
    $osType = (& docker info --format '{{.OSType}}' 2>$null | Out-String).Trim()
    if ($osType -ne 'linux') {
        throw "Docker is using Windows containers. In Docker Desktop, switch to Linux containers, then re-run this script."
    }
    & docker compose version 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Compose v2 is required (the 'docker compose' command that ships with Docker Desktop)."
    }
}

function Invoke-McCompose {
    param(
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$ComposeArgs
    )
    $file = Get-McComposeFile
    & docker compose -f $file @ComposeArgs
    if ($LASTEXITCODE -ne 0) {
        throw "docker compose failed (exit $LASTEXITCODE)."
    }
}

function Initialize-McWindowsEnv {
    $envfile = Get-McEnvFile
    $connect = Get-McEnvValue -Key CONNECT_HOST -Path $envfile
    if (-not (Test-McIPv4 $connect)) {
        $ip = Get-McWindowsLanIPv4
        if ($ip) {
            Set-McEnvKey -Key CONNECT_HOST -Value $ip -Path $envfile
            Write-McLog "Set CONNECT_HOST=$ip (this PC's LAN IPv4) so tiles are not a 172.x address."
        } else {
            Write-McWarn "Could not detect a LAN IPv4. Set CONNECT_HOST in .env if consoles should join this PC."
        }
    }
    Set-McEnvKey -Key COMPOSE_FILE -Value 'docker-compose.wsl.yml' -Path $envfile
    $tz = Get-McEnvValue -Key TZ -Path $envfile
    if (-not $tz) {
        $iana = Get-McIanaTimeZone
        if ($iana) {
            Set-McEnvKey -Key TZ -Value $iana -Path $envfile
            Write-McLog "Set TZ=$iana from this PC's timezone."
        }
    }
    $hostName = Get-McEnvValue -Key MANAGER_HOSTNAME -Path $envfile
    if (-not $hostName) {
        Set-McEnvKey -Key MANAGER_HOSTNAME -Value (Get-McManagerHostname) -Path $envfile
    }
}

function Get-McManagerPort {
    $port = Get-McEnvValue -Key PORT
    if ($port -match '^\d+$') {
        return [int]$port
    }
    return 3000
}

function Wait-McManagerHealth {
    $port = Get-McManagerPort
    $uri = "http://127.0.0.1:$port/api/health"
    for ($i = 0; $i -lt 30; $i++) {
        try {
            Invoke-RestMethod -Uri $uri -TimeoutSec 3 | Out-Null
            Write-McLog 'Manager is healthy.'
            return
        } catch {
            Start-Sleep -Seconds 2
        }
    }
    Write-McWarn "Timed out waiting for the manager health check. Try http://localhost:$port and check 'docker compose logs'."
}

function Write-McConnectUrls {
    $port = Get-McManagerPort
    $ip = Get-McEnvValue -Key CONNECT_HOST
    Write-Host ''
    Write-Host 'Connect to the manager using one of the following:'
    Write-Host "http://localhost:$port"
    if (Test-McIPv4 $ip) {
        Write-Host "http://${ip}:$port"
    }
}

function Install-McWindowsFirewall {
    param([int]$Port = 3000)
    $scriptPath = Join-Path $PSScriptRoot 'configure-windows-firewall.ps1'
    try {
        & $scriptPath -Port $Port
    } catch {
        Write-McWarn 'Could not add Windows Firewall rules (Administrator rights are required).'
        Write-McWarn "In an Administrator PowerShell run: $scriptPath -Port $Port"
    }
}

function Stop-McManagedServers {
    $port = Get-McManagerPort
    $base = "http://127.0.0.1:$port"
    try {
        Invoke-RestMethod -Uri "$base/api/health" -TimeoutSec 3 | Out-Null
    } catch {
        Write-McWarn 'Manager API is not reachable; Bedrock processes will stop when the manager restarts.'
        return
    }
    try {
        $servers = Invoke-RestMethod -Uri "$base/api/servers" -TimeoutSec 10
    } catch {
        Write-McWarn 'Could not list servers for a graceful stop.'
        return
    }
    foreach ($server in @($servers)) {
        if ($server.status -notin @('running', 'starting')) {
            continue
        }
        $name = $server.name
        if (-not $name) { $name = $server.id }
        try {
            Invoke-RestMethod -Method POST -Uri "$base/api/servers/$($server.id)/stop" -TimeoutSec 60 | Out-Null
            Write-Host "Stopped $name"
        } catch {
            Write-McWarn "Could not stop ${name}: $($_.Exception.Message)"
        }
    }
    Start-Sleep -Seconds 2
}
