# Shared installer version helpers. build-msi.ps1 is the only caller that
# passes the resolved product version into WiX.
Set-StrictMode -Version Latest

function Assert-MsiProductVersion {
  param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$Source = 'version'
  )
  if ($Version -notmatch '^(\d+)\.(\d+)\.(\d+)$') {
    throw "Invalid ${Source} '${Version}'. MSI product version must be exactly three numeric components (x.y.z)."
  }
  foreach ($part in @($Matches[1], $Matches[2], $Matches[3])) {
    $n = [int]$part
    if ($n -lt 0 -or $n -gt 65535) {
      throw "Invalid ${Source} '${Version}'. Each MSI version component must be between 0 and 65535."
    }
  }
}

function Get-RootManifestVersion {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "$Label was not found at $Path"
  }
  # Read the first version field only. Avoid ConvertFrom-Json on package-lock.json
  # because lockfile v3 uses an empty packages[""] key that Windows PowerShell rejects.
  $raw = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
  if ($raw -notmatch '"version"\s*:\s*"([^"]+)"') {
    throw "$Label does not contain a version field"
  }
  return [string]$Matches[1]
}

function Get-PackageJsonVersion {
  param([Parameter(Mandatory = $true)][string]$RepoRoot)
  $pkgPath = Join-Path $RepoRoot 'package.json'
  $lockPath = Join-Path $RepoRoot 'package-lock.json'
  $version = Get-RootManifestVersion -Path $pkgPath -Label 'package.json'
  Assert-MsiProductVersion -Version $version -Source 'package.json version'
  $lockVersion = Get-RootManifestVersion -Path $lockPath -Label 'package-lock.json'
  if ($lockVersion -ne $version) {
    throw "package.json version '$version' does not match package-lock.json version '$lockVersion'"
  }
  return $version
}

function Get-ProductVersion {
  param(
    [string]$Requested = '',
    [Parameter(Mandatory = $true)][string]$RepoRoot
  )
  if ([string]::IsNullOrWhiteSpace($Requested)) {
    return Get-PackageJsonVersion -RepoRoot $RepoRoot
  }
  if ($Requested -match '^(\d+\.\d+\.\d+)(?:_(\d+))?$') {
    Assert-MsiProductVersion -Version $Matches[1] -Source '-Version'
    return $Matches[1]
  }
  throw "Invalid -Version '$Requested'. Use x.y.z or x.y.z_NNNN (for example 0.6.0 or 0.6.0_0001)."
}

function Get-RequestedBuild {
  param(
    [string]$Requested = '',
    [int]$Build = 0
  )
  if ($Build -gt 0) { return $Build }
  if ($Requested -match '^(\d+\.\d+\.\d+)_(\d+)$') { return [int]$Matches[2] }
  return 0
}
