#Requires -Version 5.1
<#
.SYNOPSIS
  Stage the manager and build a 64-bit Windows installer.

  Output is dist\windows\MinecraftBedrockManager-<version>_<build>.exe
  (for example MinecraftBedrockManager-0.3.0_0001.exe). The product version
  stays 0.3.0 until you pass -Version; the build number increments automatically.

.DESCRIPTION
  Linux Docker and native installers are not used here. Run this on Windows 10/11 x64
  with Node 20 (the script bundles it and uses it to compile native modules), WiX 5+ (`dotnet tool install -g wix`), and Visual Studio Build Tools
  (for node-pty / better-sqlite3). Minecraft Bedrock Dedicated Server is downloaded
  later by the manager, not packed into the MSI.
#>
[CmdletBinding()]
param(
  [string]$RepoRoot = '',
  [string]$Version = '',
  [int]$Build = 0,
  [switch]$SkipOptionalRuntimes,
  [switch]$SkipGit,
  [switch]$SkipNpm,
  [switch]$SkipFrontend
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (-not $RepoRoot) {
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}

$NodeVersion = '20.19.0'
$WinSwVersion = '2.12.0'
$PythonVersion = '3.12.10'
$GitLfsVersion = '3.6.1'
$MinGitVersion = '2.47.1'
$MinGitTag = 'v2.47.1.windows.1'
$MinGitZipName = 'MinGit-2.47.1-64-bit.zip'

function Get-ProductVersion {
  param([string]$Requested)
  if ($Requested -match '^(\d+\.\d+\.\d+)(?:_(\d+))?$') { return $Matches[1] }
  return '0.3.0'
}

function Get-RequestedBuild {
  param([string]$Requested, [int]$Build)
  if ($Build -gt 0) { return $Build }
  if ($Requested -match '^(\d+\.\d+\.\d+)_(\d+)$') { return [int]$Matches[2] }
  return 0
}

function Read-BuildNumberFile {
  param([string]$Path, [string]$ProductVersion)
  if (-not (Test-Path $Path)) { return 0 }
  $line = (Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue | Select-Object -Last 1)
  if ($line -match '^(\d+\.\d+\.\d+)\s+(\d+)\s*$' -and $Matches[1] -eq $ProductVersion) {
    return [int]$Matches[2]
  }
  return 0
}

function Write-BuildNumberFile {
  param([string]$Path, [string]$ProductVersion, [int]$Build)
  Set-Content -LiteralPath $Path -Value ("{0} {1}" -f $ProductVersion, $Build) -Encoding ascii
}

function Get-HighestExistingBuild {
  param([string]$OutDir, [string]$ProductVersion)
  $highest = 0
  if (-not (Test-Path $OutDir)) { return 0 }
  Get-ChildItem -LiteralPath $OutDir -Filter ("MinecraftBedrockManager-{0}_*.exe" -f $ProductVersion) -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.BaseName -match ('_(\d+)$')) {
      $n = [int]$Matches[1]
      if ($n -gt $highest) { $highest = $n }
    }
  }
  return $highest
}

function Get-NextBuildNumber {
  param([string]$ProductVersion, [int]$RequestedBuild, [string]$StampPath, [string]$OutDir)
  if ($RequestedBuild -gt 0) { return $RequestedBuild }
  $fromFile = Read-BuildNumberFile $StampPath $ProductVersion
  $fromDist = Get-HighestExistingBuild $OutDir $ProductVersion
  return [Math]::Max($fromFile, $fromDist) + 1
}

function Get-CachedFile {
  param([string]$Url, [string]$FileName)
  $dest = Join-Path $CacheDir $FileName
  if (Test-Path $dest) { return $dest }
  Write-Host "Downloading $FileName"
  Invoke-WebRequest -Uri $Url -OutFile "$dest.partial" -UseBasicParsing
  Move-Item -Force "$dest.partial" $dest
  return $dest
}

function Copy-FlattenedZip {
  param([string]$ZipPath, [string]$DestDir, [int]$SkipTop = 0)
  $extract = Join-Path $CacheDir ("extract-" + [IO.Path]::GetFileNameWithoutExtension($ZipPath))
  if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
  New-Item -ItemType Directory -Path $extract | Out-Null
  Expand-Archive -LiteralPath $ZipPath -DestinationPath $extract -Force
  $source = $extract
  for ($i = 0; $i -lt $SkipTop; $i++) {
    $dirs = @(Get-ChildItem $source -Directory)
    if ($dirs.Count -eq 1 -and @(Get-ChildItem $source -File).Count -eq 0) {
      $source = $dirs[0].FullName
    }
  }
  New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
  Copy-Item -Path (Join-Path $source '*') -Destination $DestDir -Recurse -Force
}

function Copy-Tree {
  param([string]$Source, [string]$Dest)
  New-Item -ItemType Directory -Path $Dest -Force | Out-Null
  Copy-Item -Path (Join-Path $Source '*') -Destination $Dest -Recurse -Force
}

$ProductVersion = Get-ProductVersion $Version
$OutDir = Join-Path $RepoRoot 'dist\windows'
$Stage = Join-Path $OutDir 'stage'
$CacheDir = Join-Path $PSScriptRoot 'cache'
$BuildStamp = Join-Path $PSScriptRoot 'installer-build-number.txt'
$BuildNumber = Get-NextBuildNumber $ProductVersion (Get-RequestedBuild $Version $Build) $BuildStamp $OutDir
$DisplayVersion = '{0}_{1:D4}' -f $ProductVersion, $BuildNumber
# MSI ProductVersion is only x.y.z. Burn can use a fourth field so 0.3.0_0002 replaces 0.3.0_0001.
$BundleVersion = '{0}.{1}' -f $ProductVersion, $BuildNumber
$MsiOut = Join-Path $OutDir ("MinecraftBedrockManager-$DisplayVersion.msi")
$ExeOut = Join-Path $OutDir ("MinecraftBedrockManager-$DisplayVersion.exe")

New-Item -ItemType Directory -Path $CacheDir -Force | Out-Null
if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
New-Item -ItemType Directory -Path $Stage | Out-Null

Write-Host "Staging Minecraft Bedrock Manager $DisplayVersion"

if (-not $SkipFrontend) {
  Push-Location $RepoRoot
  try {
    npm --prefix frontend ci
    if ($LASTEXITCODE -ne 0) { throw 'frontend npm ci failed' }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'frontend build failed' }
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path (Join-Path $RepoRoot 'public\index.html'))) {
  throw 'public/index.html is missing. Run without -SkipNpm so the frontend is built.'
}

Copy-Tree (Join-Path $RepoRoot 'server') (Join-Path $Stage 'server')
Copy-Tree (Join-Path $RepoRoot 'vendor') (Join-Path $Stage 'vendor')
Copy-Tree (Join-Path $RepoRoot 'public') (Join-Path $Stage 'public')
if (Test-Path (Join-Path $RepoRoot 'docs')) {
  Copy-Tree (Join-Path $RepoRoot 'docs') (Join-Path $Stage 'docs')
}
Copy-Item (Join-Path $RepoRoot 'package.json') $Stage
Copy-Item (Join-Path $RepoRoot 'package-lock.json') $Stage
Copy-Item (Join-Path $RepoRoot '.env.example') $Stage
Copy-Item (Join-Path $RepoRoot 'README.md') $Stage
Copy-Item (Join-Path $RepoRoot 'SECURITY.md') $Stage -ErrorAction SilentlyContinue

Get-ChildItem -Path (Join-Path $Stage 'server') -Recurse -Directory -Filter '__pycache__' | Remove-Item -Recurse -Force

$nodeZip = Get-CachedFile "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" "node-v$NodeVersion-win-x64.zip"
Copy-FlattenedZip -ZipPath $nodeZip -DestDir (Join-Path $Stage 'runtime\node') -SkipTop 1
$bundledNode = Join-Path $Stage 'runtime\node\node.exe'
$bundledNpm = Join-Path $Stage 'runtime\node\npm.cmd'
if (-not (Test-Path $bundledNode)) {
  throw 'Bundled Node did not extract to runtime\node\node.exe'
}

Write-Host "Installing production node_modules with bundled Node $NodeVersion"
$originalPath = $env:PATH
Push-Location $Stage
try {
  $env:PATH = ((Join-Path $Stage 'runtime\node') + ';' + $originalPath)
  & $bundledNpm ci --omit=dev
  if ($LASTEXITCODE -ne 0) { throw 'npm ci --omit=dev in the MSI stage failed (need VS Build Tools for native modules, or Node 20 prebuilds)' }
} finally {
  $env:PATH = $originalPath
  Pop-Location
}

$winSw = Get-CachedFile "https://github.com/winsw/winsw/releases/download/v$WinSwVersion/WinSW-x64.exe" "WinSW-x64-$WinSwVersion.exe"
Copy-Item $winSw (Join-Path $Stage 'MinecraftBedrockManager.exe')
Copy-Item (Join-Path $PSScriptRoot 'MinecraftBedrockManager.xml') $Stage
Copy-Item (Join-Path $PSScriptRoot 'firewall-install.cmd') $Stage
Copy-Item (Join-Path $PSScriptRoot 'firewall-uninstall.cmd') $Stage
Copy-Item (Join-Path $PSScriptRoot 'copy-env.cmd') $Stage
Copy-Item (Join-Path $PSScriptRoot 'Open Manager.url') $Stage

if (-not $SkipOptionalRuntimes) {
  Write-Host 'Bundling Temurin JRE 21 and Python embeddable'
  $jreZip = Get-CachedFile 'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse?project=jdk' 'temurin-21-jre-windows-x64.zip'
  Copy-FlattenedZip -ZipPath $jreZip -DestDir (Join-Path $Stage 'runtime\jre') -SkipTop 1
  if (-not (Test-Path (Join-Path $Stage 'runtime\jre\bin\java.exe'))) {
    throw 'Temurin JRE did not extract to runtime\jre\bin\java.exe'
  }

  $pyZip = Get-CachedFile "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip" "python-$PythonVersion-embed-amd64.zip"
  Copy-FlattenedZip -ZipPath $pyZip -DestDir (Join-Path $Stage 'runtime\python') -SkipTop 0
  $pth = Get-ChildItem (Join-Path $Stage 'runtime\python') -Filter 'python*._pth' | Select-Object -First 1
  if ($pth) {
    $text = Get-Content -Raw $pth.FullName
    if ($text -notmatch '(?m)^import site') {
      Set-Content -Path $pth.FullName -Value ($text.TrimEnd() + "`r`nimport site`r`n") -NoNewline
    }
  }
  if (-not (Test-Path (Join-Path $Stage 'runtime\python\python.exe'))) {
    throw 'Python embeddable did not extract to runtime\python\python.exe'
  }
}

if (-not $SkipGit) {
  Write-Host 'Bundling MinGit and Git LFS'
  $gitZip = Get-CachedFile "https://github.com/git-for-windows/git/releases/download/$MinGitTag/$MinGitZipName" $MinGitZipName
  Copy-FlattenedZip -ZipPath $gitZip -DestDir (Join-Path $Stage 'runtime\git') -SkipTop 0
  $lfsZip = Get-CachedFile "https://github.com/git-lfs/git-lfs/releases/download/v$GitLfsVersion/git-lfs-windows-amd64-v$GitLfsVersion.zip" "git-lfs-windows-amd64-v$GitLfsVersion.zip"
  $lfsExtract = Join-Path $CacheDir "git-lfs-$GitLfsVersion"
  if (Test-Path $lfsExtract) { Remove-Item -Recurse -Force $lfsExtract }
  Expand-Archive -LiteralPath $lfsZip -DestinationPath $lfsExtract -Force
  $lfsExe = Get-ChildItem $lfsExtract -Recurse -Filter 'git-lfs.exe' | Select-Object -First 1
  if (-not $lfsExe) { throw 'git-lfs.exe was not in the Git LFS zip' }
  foreach ($dir in @('cmd', 'mingw64\bin')) {
    $targetDir = Join-Path $Stage "runtime\git\$dir"
    if (Test-Path $targetDir) {
      Copy-Item $lfsExe.FullName $targetDir -Force
    }
  }
  if (-not (Test-Path (Join-Path $Stage 'runtime\git\cmd\git.exe'))) {
    throw 'MinGit did not extract to runtime\git\cmd\git.exe'
  }
}

$wix = Get-Command wix -ErrorAction SilentlyContinue
if (-not $wix) {
  throw 'WiX is not on PATH. Install it with: dotnet tool install -g wix'
}

Write-Host "Building $MsiOut"
& wix build (Join-Path $PSScriptRoot 'Product.wxs') `
  -arch x64 `
  -d "Version=$ProductVersion" `
  -d "DisplayVersion=$DisplayVersion" `
  -bindpath "Stage=$Stage" `
  -acceptEula wix7 `
  -o $MsiOut
if ($LASTEXITCODE -ne 0) { throw "wix build failed with exit code $LASTEXITCODE" }

Write-Host "Building $ExeOut"
& wix build (Join-Path $PSScriptRoot 'Bundle.wxs') `
  -arch x64 `
  -d "Version=$ProductVersion" `
  -d "BundleVersion=$BundleVersion" `
  -d "DisplayVersion=$DisplayVersion" `
  -d "MsiPath=$MsiOut" `
  -ext WixToolset.BootstrapperApplications.wixext `
  -ext WixToolset.Util.wixext `
  -acceptEula wix7 `
  -o $ExeOut
if ($LASTEXITCODE -ne 0) { throw "wix bundle build failed with exit code $LASTEXITCODE" }

Write-BuildNumberFile $BuildStamp $ProductVersion $BuildNumber
Write-Host "Installer written to $ExeOut"
Write-Host 'Double-click the .exe, approve UAC, then open http://127.0.0.1:3000'
