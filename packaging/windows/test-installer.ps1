#Requires -Version 5.1
<#
.SYNOPSIS
  Validate Windows installer packaging without changing Linux CI.

.DESCRIPTION
  Always runs static checks (version resolution, firewall symmetry, .env copy,
  required source files). Pass -Build to stage the application, confirm bundled
  JDK/native modules, build the MSI/Burn EXE, and probe /api/health.

  This is a mandatory Windows release step. Do not add a required GitLab job
  until a Windows runner exists.
#>
[CmdletBinding()]
param(
  [string]$RepoRoot = '',
  [switch]$Build,
  [switch]$SkipHealth
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $RepoRoot) {
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}

. (Join-Path $PSScriptRoot 'InstallerVersion.ps1')

$failures = New-Object System.Collections.Generic.List[string]
$checks = 0

function Write-Check {
  param([string]$Name, [scriptblock]$Body)
  $script:checks += 1
  Write-Host "CHECK: $Name"
  try {
    & $Body
    Write-Host "  ok"
  } catch {
    $script:failures.Add("${Name}: $($_.Exception.Message)")
    Write-Host "  FAIL: $($_.Exception.Message)"
  }
}

function Get-QuotedRuleNames {
  param([string]$Text, [string]$Verb)
  $names = New-Object System.Collections.Generic.List[string]
  foreach ($line in ($Text -split '\r?\n')) {
    if ($line -match ("firewall $Verb rule name=`"([^`"]+)`"")) {
      $names.Add($Matches[1])
    }
  }
  return @($names)
}

function Test-NativeBinding {
  param([string]$Stage, [string]$Package, [string[]]$FileNames)
  $root = Join-Path $Stage "node_modules\$Package"
  if (-not (Test-Path -LiteralPath $root)) {
    throw "$Package is missing from staged node_modules"
  }
  $found = $null
  foreach ($name in $FileNames) {
    $hit = Get-ChildItem -LiteralPath $root -Recurse -Filter $name -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($hit) {
      $found = $hit
      break
    }
  }
  if (-not $found) {
    throw "$Package native binding ($($FileNames -join ', ')) was not found"
  }
}

$pkgVersionLine = Get-Content -LiteralPath (Join-Path $RepoRoot 'package.json') -TotalCount 8 |
  Where-Object { $_ -match '"version"\s*:\s*"([^"]+)"' } |
  Select-Object -First 1
if (-not ($pkgVersionLine -match '"version"\s*:\s*"([^"]+)"')) {
  throw 'package.json version field was not found'
}
$expectedVersion = [string]$Matches[1]
$buildMsi = Join-Path $PSScriptRoot 'build-msi.ps1'
$stage = Join-Path $RepoRoot 'dist\windows\stage'

Write-Check 'package.json version is a valid MSI product version' {
  Assert-MsiProductVersion -Version $expectedVersion -Source 'package.json version'
}

Write-Check 'omitted -Version reads package.json and matching package-lock.json' {
  $resolved = Get-ProductVersion -Requested '' -RepoRoot $RepoRoot
  if ($resolved -ne $expectedVersion) {
    throw "resolved '$resolved' but package.json is '$expectedVersion'"
  }
}

Write-Check 'explicit x.y.z and x.y.z_NNNN versions are accepted' {
  $plain = Get-ProductVersion -Requested $expectedVersion -RepoRoot $RepoRoot
  $suffixed = Get-ProductVersion -Requested "${expectedVersion}_0007" -RepoRoot $RepoRoot
  if ($plain -ne $expectedVersion -or $suffixed -ne $expectedVersion) {
    throw 'explicit versions did not round-trip to the product version'
  }
  $build = Get-RequestedBuild -Requested "${expectedVersion}_0007" -Build 0
  if ($build -ne 7) { throw "expected build 7 from suffix, got $build" }
}

Write-Check 'invalid explicit versions are rejected' {
  foreach ($bad in @('banana', '0.6', 'v0.6.0', '0.6.0.1', 'latest')) {
    $rejected = $false
    try {
      $null = Get-ProductVersion -Requested $bad -RepoRoot $RepoRoot
    } catch {
      $rejected = $true
      if ($_.Exception.Message -notmatch 'Invalid') {
        throw "rejection for '$bad' was not a clear Invalid error: $($_.Exception.Message)"
      }
    }
    if (-not $rejected) { throw "-Version $bad was accepted" }
  }
}

Write-Check 'build-msi.ps1 rejects invalid -Version before staging' {
  $outDir = Join-Path $env:TEMP ("mbm-version-reject-" + [guid]::NewGuid().ToString('n'))
  New-Item -ItemType Directory -Path $outDir | Out-Null
  $stdout = Join-Path $outDir 'stdout.txt'
  $stderr = Join-Path $outDir 'stderr.txt'
  try {
    $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $buildMsi, '-Version', 'banana'
    ) -Wait -PassThru -NoNewWindow -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    if ($proc.ExitCode -eq 0) { throw 'build-msi.ps1 accepted -Version banana' }
    $text = ((Get-Content -LiteralPath $stdout -Raw -ErrorAction SilentlyContinue) + (Get-Content -LiteralPath $stderr -Raw -ErrorAction SilentlyContinue))
    if ($text -notmatch 'Invalid -Version') {
      throw "build-msi.ps1 did not report a clear Invalid -Version error:`n$text"
    }
  } finally {
    Remove-Item -LiteralPath $outDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Check 'WiX sources require -d Version from the build script' {
  $product = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Product.wxs') -Raw
  $bundle = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Bundle.wxs') -Raw
  if ($product -match '0\.3\.6' -or $bundle -match '0\.3\.6') {
    throw 'stale 0.3.6 fallback is still present in WiX sources'
  }
  if ($product -notmatch 'Version must be passed by packaging/windows/build-msi.ps1') {
    throw 'Product.wxs should error when Version is not passed'
  }
}

Write-Check 'build script has no unused -SkipNpm switch' {
  $script = Get-Content -LiteralPath $buildMsi -Raw
  if ($script -match 'SkipNpm') { throw 'remove unused -SkipNpm or implement it' }
  if ($script -notmatch 'SkipFrontend') { throw 'frontend skip switch is missing' }
}

Write-Check 'firewall install/uninstall rule symmetry and Java TCP ranges' {
  $install = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'firewall-install.cmd') -Raw
  $uninstall = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'firewall-uninstall.cmd') -Raw
  $added = Get-QuotedRuleNames -Text $install -Verb 'add'
  $installDeletes = Get-QuotedRuleNames -Text $install -Verb 'delete'
  $uninstallDeletes = Get-QuotedRuleNames -Text $uninstall -Verb 'delete'
  if ($added.Count -eq 0) { throw 'firewall-install.cmd added no rules' }
  foreach ($name in $added) {
    if ($installDeletes -notcontains $name) { throw "install does not delete existing rule before add: $name" }
    if ($uninstallDeletes -notcontains $name) { throw "uninstall does not remove rule: $name" }
  }
  foreach ($range in @('19132-19199', '25565-25665', '30000-30100')) {
    $tcpName = "%RULE% Java TCP $range"
    if ($added -notcontains $tcpName) { throw "missing Java TCP rule $tcpName" }
    if ($install -notmatch [regex]::Escape("protocol=TCP localport=$range")) {
      throw "Java TCP $range is not opened over TCP"
    }
    $udpName = "%RULE% Bedrock UDP $range"
    if ($added -notcontains $udpName) { throw "missing Bedrock UDP rule $udpName" }
  }
  if ($install -notmatch 'protocol=TCP localport=3000') { throw 'manager TCP 3000 rule is missing' }
  if ($install -notmatch 'protocol=UDP localport=53' -or $install -notmatch 'protocol=TCP localport=53') {
    throw 'DNS TCP/UDP 53 rules are missing'
  }
}

Write-Check '.env copy uses the batch-file directory and does not overwrite' {
  $copyEnv = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'copy-env.cmd') -Raw
  if ($copyEnv -notmatch 'APPDIR=%~dp0') { throw 'copy-env.cmd must resolve paths from %~dp0' }
  $probe = Join-Path $env:TEMP ("mbm-copy-env-" + [guid]::NewGuid().ToString('n'))
  New-Item -ItemType Directory -Path $probe | Out-Null
  try {
    Copy-Item (Join-Path $PSScriptRoot 'copy-env.cmd') $probe
    Set-Content -LiteralPath (Join-Path $probe '.env.example') -Value "LOG_LEVEL=debug`r`nCONNECT_HOST=192.0.2.10`r`n" -Encoding ascii
    $cmd = Join-Path $probe 'copy-env.cmd'
    Push-Location $env:SystemRoot\System32
    try {
      & cmd.exe /c "`"$cmd`""
      if ($LASTEXITCODE -ne 0) { throw "copy-env.cmd exited $LASTEXITCODE when .env was missing" }
    } finally {
      Pop-Location
    }
    $envPath = Join-Path $probe '.env'
    if (-not (Test-Path -LiteralPath $envPath)) { throw '.env was not created beside the batch file' }
    if ((Get-Content -LiteralPath $envPath -Raw) -notmatch 'LOG_LEVEL=debug') {
      throw 'copied .env did not come from .env.example'
    }
    Set-Content -LiteralPath $envPath -Value "LOG_LEVEL=keep-me`r`n" -Encoding ascii
    Push-Location $env:SystemRoot\System32
    try {
      & cmd.exe /c "`"$cmd`""
      if ($LASTEXITCODE -ne 0) { throw "copy-env.cmd exited $LASTEXITCODE when .env already existed" }
    } finally {
      Pop-Location
    }
    if ((Get-Content -LiteralPath $envPath -Raw) -notmatch 'LOG_LEVEL=keep-me') {
      throw 'existing .env was overwritten'
    }
  } finally {
    Remove-Item -LiteralPath $probe -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Check 'WinSW points at bundled JDK java/javac' {
  $xml = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'MinecraftBedrockManager.xml') -Raw
  if ($xml -match 'runtime\\jre') { throw 'WinSW still references runtime\jre; use runtime\jdk' }
  if ($xml -notmatch 'runtime\\jdk\\bin\\java.exe') { throw 'MC_MANAGER_JAVA must point at bundled java.exe' }
  if ($xml -notmatch 'runtime\\jdk\\bin\\javac.exe') { throw 'MC_MANAGER_JAVAC must point at bundled javac.exe' }
  if ($xml -notmatch 'JAVA_HOME" value="%BASE%\\runtime\\jdk"') { throw 'JAVA_HOME must be the bundled JDK root' }
}

Write-Check 'required catalog-filter plugin files are in the repository' {
  $plugin = Join-Path $RepoRoot 'server\bundled-plugins\catalog-java-server-compatibility'
  foreach ($name in @('plugin.json', 'backend.js')) {
    $path = Join-Path $plugin $name
    if (-not (Test-Path -LiteralPath $path)) { throw "missing $path" }
  }
}

Write-Check 'frontend build output exists unless -Build will rebuild it' {
  $index = Join-Path $RepoRoot 'public\index.html'
  if (-not (Test-Path -LiteralPath $index) -and -not $Build) {
    throw 'public\index.html is missing; run the frontend build or pass -Build'
  }
}

if ($Build) {
  Write-Host 'Building Windows installer (this downloads runtimes on first run)...'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $buildMsi -RepoRoot $RepoRoot
  if ($LASTEXITCODE -ne 0) { throw "build-msi.ps1 failed with exit code $LASTEXITCODE" }

  Write-Check 'installer filename matches package.json version' {
    $exe = Get-ChildItem -LiteralPath (Join-Path $RepoRoot 'dist\windows') -Filter ("MinecraftBedrockManager-{0}_*.exe" -f $expectedVersion) |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
    if (-not $exe) { throw "no MinecraftBedrockManager-${expectedVersion}_NNNN.exe was produced" }
    if ($exe.Name -notmatch ("^MinecraftBedrockManager-{0}_\d{{4}}\.exe$" -f [regex]::Escape($expectedVersion))) {
      throw "unexpected installer name $($exe.Name)"
    }
    $msi = Join-Path $exe.DirectoryName ($exe.BaseName + '.msi')
    if (-not (Test-Path -LiteralPath $msi)) { throw "MSI $($exe.BaseName).msi was not created" }
  }

  Write-Check 'staged runtime includes Node, JDK javac, and native bindings' {
    if (-not (Test-Path -LiteralPath $stage)) { throw "staging folder missing: $stage" }
    $node = Join-Path $stage 'runtime\node\node.exe'
    $java = Join-Path $stage 'runtime\jdk\bin\java.exe'
    $javac = Join-Path $stage 'runtime\jdk\bin\javac.exe'
    foreach ($path in @($node, $java, $javac)) {
      if (-not (Test-Path -LiteralPath $path)) { throw "missing $path" }
    }
    $nodeVer = & $node -v
    if ($nodeVer -notmatch '^v20\.') { throw "bundled Node is $nodeVer, expected v20.x" }
    Test-NativeBinding -Stage $stage -Package 'better-sqlite3' -FileNames @('better_sqlite3.node')
    Test-NativeBinding -Stage $stage -Package 'node-pty' -FileNames @('conpty.node', 'pty.node')
    foreach ($name in @('plugin.json', 'backend.js')) {
      $path = Join-Path $stage "server\bundled-plugins\catalog-java-server-compatibility\$name"
      if (-not (Test-Path -LiteralPath $path)) { throw "staged catalog filter missing $name" }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $stage 'public\index.html'))) {
      throw 'staged frontend output is missing'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $stage 'node_modules\dotenv\package.json'))) {
      throw 'dotenv must be a production dependency in the staged app'
    }
    if (Test-Path -LiteralPath (Join-Path $stage 'node_modules\socket.io-client')) {
      throw 'socket.io-client must not be staged as a production dependency'
    }
  }

  if (-not $SkipHealth) {
    Write-Check 'staged application /api/health reports version and security profile' {
      $node = Join-Path $stage 'runtime\node\node.exe'
      $familyJson = ''
      Push-Location $RepoRoot
      try {
        $familyJson = & $node -e "const f=require('./scripts/verify-release-family'); const p=require('./package.json'); process.stdout.write(JSON.stringify(f.validate(p.version)));"
      } finally {
        Pop-Location
      }
      if ($LASTEXITCODE -ne 0 -or -not $familyJson) { throw 'verify-release-family failed' }
      $expected = $familyJson | ConvertFrom-Json
      $healthDir = Join-Path $env:TEMP ("mbm-health-" + [guid]::NewGuid().ToString('n'))
      New-Item -ItemType Directory -Path $healthDir | Out-Null
      $stdout = Join-Path $healthDir 'stdout.txt'
      $stderr = Join-Path $healthDir 'stderr.txt'
      $port = 18765
      $wrapper = Join-Path $healthDir 'run.cmd'
      @"
@echo off
set PORT=$port
set NODE_ENV=production
set MC_MANAGER_DB_PATH=$healthDir\mc_manager.db
set MC_MANAGER_USER_PLUGINS_DIR=$healthDir\plugins
set MC_MANAGER_PLUGIN_DATA_DIR=$healthDir\plugin-data
cd /d "$stage"
"$node" server\index.js
"@ | Set-Content -LiteralPath $wrapper -Encoding ascii
      $proc = Start-Process -FilePath $wrapper -WorkingDirectory $stage -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
      try {
        $body = $null
        for ($i = 0; $i -lt 40; $i++) {
          if ($proc.HasExited) { break }
          Start-Sleep -Seconds 1
          try {
            $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/health" -UseBasicParsing -TimeoutSec 2
            $body = $resp.Content | ConvertFrom-Json
            if ($body.status -eq 'ok') { break }
          } catch {
            $body = $null
          }
        }
        if (-not $body -or $body.status -ne 'ok') {
          $errText = (Get-Content -LiteralPath $stderr -Raw -ErrorAction SilentlyContinue)
          throw "health endpoint did not become ready. process exit=$($proc.HasExited)/$($proc.ExitCode) stderr=$errText"
        }
        if ([string]$body.version -ne $expectedVersion) {
          throw "health version '$($body.version)' != '$expectedVersion'"
        }
        if ([string]$body.securityProfile -ne [string]$expected.securityProfile) {
          throw "health securityProfile '$($body.securityProfile)' != '$($expected.securityProfile)'"
        }
      } finally {
        if (-not $proc.HasExited) {
          Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
          Start-Sleep -Milliseconds 500
        }
        Remove-Item -LiteralPath $healthDir -Recurse -Force -ErrorAction SilentlyContinue
      }
    }
  }
} else {
  Write-Host 'Skipping installer build. Pass -Build for JDK, native module, WiX, and health checks.'
}

Write-Host ""
if ($failures.Count -gt 0) {
  Write-Host "test-installer: $checks checks, $($failures.Count) failed"
  foreach ($item in $failures) { Write-Host " - $item" }
  exit 1
}

Write-Host "test-installer: $checks checks passed"
exit 0
