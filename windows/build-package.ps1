<#
.SYNOPSIS
  Builds the portable Windows test package: Infrastruktur-CMDB-Windows.zip
.DESCRIPTION
  Contents: portable Node.js 22 (nodejs.org, SHA-256 verified), PostgreSQL 17 binaries (EnterpriseDB),
  the built CMDB with its production dependencies, the launcher and "Start CMDB.cmd" / "Stop CMDB.cmd".
  Runs on Windows with Node.js 22 and npm (GitHub Actions: windows-latest).
.EXAMPLE
  ./windows/build-package.ps1 -OutDir C:\temp\cmdb-package
#>
param(
  [Parameter(Mandatory = $true)][string]$OutDir,
  [string]$NodeMajor = '22',
  [string]$PostgresMajor = '17'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar

$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
$downloads = Join-Path $OutDir 'downloads'
$pkg = Join-Path $OutDir 'package'
$app = Join-Path $pkg 'app'
$zip = Join-Path $OutDir 'Infrastruktur-CMDB-Windows.zip'

if (Test-Path $pkg) { Remove-Item $pkg -Recurse -Force }
New-Item -ItemType Directory -Force $downloads, $app | Out-Null

function Get-File([string]$Url, [string]$Target) {
  if (-not (Test-Path $Target)) {
    Write-Host "  downloading $Url"
    Invoke-WebRequest -Uri $Url -OutFile $Target -UseBasicParsing
  }
}

# ---- Node.js (portable node.exe, checksum from SHASUMS256.txt) ----------------------------------
Write-Host '==> Node.js'
$index = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
$node = $index | Where-Object { $_.version -like "v$NodeMajor.*" -and $_.files -contains 'win-x64-zip' } | Select-Object -First 1
if (-not $node) { throw "No Node.js $NodeMajor release with a win-x64 zip found" }
$nodeName = "node-$($node.version)-win-x64"
$nodeZip = Join-Path $downloads "$nodeName.zip"
Get-File "https://nodejs.org/dist/$($node.version)/$nodeName.zip" $nodeZip
$sums = (Invoke-WebRequest "https://nodejs.org/dist/$($node.version)/SHASUMS256.txt" -UseBasicParsing).Content
$expected = ($sums -split "`n" | Where-Object { $_ -match " $nodeName\.zip$" }) -replace '\s.*$', ''
$actual = (Get-FileHash $nodeZip -Algorithm SHA256).Hash.ToLower()
if ($expected -ne $actual) { throw "Checksum mismatch for $nodeName.zip" }
tar -xf $nodeZip -C $downloads "$nodeName/node.exe" "$nodeName/LICENSE"
New-Item -ItemType Directory -Force (Join-Path $app 'node') | Out-Null
Copy-Item (Join-Path $downloads "$nodeName/node.exe") (Join-Path $app 'node/node.exe')
Copy-Item (Join-Path $downloads "$nodeName/LICENSE") (Join-Path $app 'node/LICENSE')
Write-Host "    Node.js $($node.version)"

# ---- PostgreSQL (EnterpriseDB binaries, newest minor release of the major version) -------------
Write-Host '==> PostgreSQL'
$pgUrl = $null
for ($minor = 30; $minor -ge 0; $minor--) {
  $candidate = "https://get.enterprisedb.com/postgresql/postgresql-$PostgresMajor.$minor-1-windows-x64-binaries.zip"
  try {
    $head = Invoke-WebRequest -Uri $candidate -Method Head -UseBasicParsing
    if ($head.StatusCode -eq 200) { $pgUrl = $candidate; $pgVersion = "$PostgresMajor.$minor"; break }
  } catch { }
}
if (-not $pgUrl) { throw "No PostgreSQL $PostgresMajor Windows binaries found at get.enterprisedb.com" }
$pgZip = Join-Path $downloads "postgresql-$pgVersion.zip"
Get-File $pgUrl $pgZip
$pgExtract = Join-Path $downloads "pg-$pgVersion"
if (-not (Test-Path $pgExtract)) {
  New-Item -ItemType Directory -Force $pgExtract | Out-Null
  tar -xf $pgZip -C $pgExtract
}
$pgsql = Join-Path $app 'pgsql'
Copy-Item (Join-Path $pgExtract 'pgsql') $pgsql -Recurse
# not needed to run the database: GUI, docs, headers, debug symbols, installer helper
foreach ($dir in 'pgAdmin 4', 'doc', 'include', 'symbols', 'StackBuilder') {
  $p = Join-Path $pgsql $dir
  if (Test-Path $p) { Remove-Item $p -Recurse -Force }
}
Get-ChildItem $pgsql -Recurse -Include '*.pdb', '*.lib', '*.a' | Remove-Item -Force
# Visual C++ runtime next to the binaries (app-local), in case the computer does not have it
foreach ($dll in 'vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll') {
  $target = Join-Path $pgsql "bin/$dll"
  $source = Join-Path $env:SystemRoot "System32/$dll"
  if (-not (Test-Path $target) -and (Test-Path $source)) { Copy-Item $source $target }
}
foreach ($tool in 'initdb.exe', 'pg_ctl.exe', 'postgres.exe') {
  if (-not (Test-Path (Join-Path $pgsql "bin/$tool"))) { throw "PostgreSQL package is missing bin/$tool" }
}
Write-Host "    PostgreSQL $pgVersion"

# ---- CMDB --------------------------------------------------------------------------------------
Write-Host '==> CMDB build'
Push-Location $repo
try {
  npm ci --no-audit --no-fund
  if ($LASTEXITCODE) { throw 'npm ci failed' }
  npm run build
  if ($LASTEXITCODE) { throw 'npm run build failed' }
} finally { Pop-Location }

$cmdb = Join-Path $app 'cmdb'
New-Item -ItemType Directory -Force $cmdb | Out-Null
Copy-Item (Join-Path $repo 'dist') $cmdb -Recurse
Copy-Item (Join-Path $repo 'package.json'), (Join-Path $repo 'package-lock.json'), (Join-Path $repo 'LICENSE') $cmdb
Push-Location $cmdb
try {
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE) { throw 'npm ci --omit=dev failed' }
} finally { Pop-Location }
# keep paths short (Explorer cannot unpack paths longer than 260 characters) and the package small
Get-ChildItem (Join-Path $cmdb 'node_modules') -Recurse -File -Include '*.d.ts', '*.d.mts', '*.d.cts', '*.map', '*.md', '*.markdown' |
  Remove-Item -Force
Get-ChildItem (Join-Path $cmdb 'node_modules') -Recurse -Directory |
  Sort-Object { $_.FullName.Length } -Descending |
  Where-Object { -not (Get-ChildItem $_.FullName -Force) } |
  Remove-Item -Force

# ---- launcher and start files ------------------------------------------------------------------
Copy-Item (Join-Path $PSScriptRoot 'launcher.mjs') $app
Copy-Item (Join-Path $PSScriptRoot 'Start CMDB.cmd'), (Join-Path $PSScriptRoot 'Stop CMDB.cmd'), (Join-Path $PSScriptRoot 'README.txt') $pkg

$longest = Get-ChildItem $pkg -Recurse -File | ForEach-Object { $_.FullName.Substring($pkg.Length + 1) } |
  Sort-Object Length -Descending | Select-Object -First 1
Write-Host "    longest path inside the package: $($longest.Length) characters"
if ($longest.Length -gt 150) { throw "Path too long for Windows Explorer extraction: $longest" }

# ---- ZIP (contents at the root, so "Extract all" does not create a nested folder) ---------------
Write-Host '==> ZIP'
if (Test-Path $zip) { Remove-Item $zip -Force }
$items = Get-ChildItem $pkg -Name   # PowerShell does not expand * for native commands
tar -a -c -f $zip -C $pkg @items
if ($LASTEXITCODE) { throw 'Creating the ZIP file failed' }
$size = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "    $zip ($size MB)"
