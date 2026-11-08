<#
.SYNOPSIS
  End-to-end test of the Windows test package: unpack the ZIP, start, first-run setup, sign-in,
  stop, start again (existing data), stop.
.EXAMPLE
  ./windows/smoke-test.ps1 -Zip C:\temp\cmdb-package\Infrastruktur-CMDB-Windows.zip
#>
param([Parameter(Mandatory = $true)][string]$Zip)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$dir = Join-Path ([System.IO.Path]::GetTempPath()) ("cmdb-smoke-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $dir | Out-Null
tar -xf $Zip -C $dir
if ($LASTEXITCODE) { throw 'Unpacking the ZIP failed' }
foreach ($f in 'Start CMDB.cmd', 'Stop CMDB.cmd', 'README.txt', 'app/launcher.mjs', 'app/node/node.exe', 'app/pgsql/bin/pg_ctl.exe', 'app/cmdb/dist/server.mjs') {
  if (-not (Test-Path (Join-Path $dir $f))) { throw "Missing in the package: $f" }
}
$node = Join-Path $dir 'app/node/node.exe'
$launcher = Join-Path $dir 'app/launcher.mjs'
$runtimeFile = Join-Path $dir 'data/runtime.json'

function Start-Cmdb([string]$name) {
  $p = Start-Process -FilePath $node -ArgumentList "`"$launcher`"", '--no-browser' -PassThru -NoNewWindow `
    -RedirectStandardOutput (Join-Path $dir "$name.out.log") -RedirectStandardError (Join-Path $dir "$name.err.log")
  for ($i = 0; $i -lt 180; $i++) {
    if ($p.HasExited) { Show-Logs; throw "Launcher exited early with code $($p.ExitCode)" }
    if (Test-Path $runtimeFile) {
      $rt = Get-Content $runtimeFile -Raw | ConvertFrom-Json
      try {
        $r = Invoke-RestMethod "http://127.0.0.1:$($rt.appPort)/readyz" -TimeoutSec 2
        if ($r.status -eq 'ok') { return @{ Process = $p; Base = "http://127.0.0.1:$($rt.appPort)" } }
      } catch { }
    }
    Start-Sleep -Seconds 1
  }
  Show-Logs
  throw 'The CMDB did not become ready'
}

function Stop-Cmdb($run) {
  & $node $launcher --stop
  if (-not $run.Process.WaitForExit(60000)) { throw 'Launcher did not exit after --stop' }
  & (Join-Path $dir 'app/pgsql/bin/pg_ctl.exe') status -D (Join-Path $dir 'data/postgres') | Out-Null
  if ($LASTEXITCODE -eq 0) { throw 'PostgreSQL is still running after --stop' }
}

function Show-Logs {
  Get-ChildItem $dir -Filter '*.log' | ForEach-Object { Write-Host "--- $($_.Name)"; Get-Content $_.FullName -Tail 60 }
  $pgLog = Join-Path $dir 'data/logs/postgres.log'
  if (Test-Path $pgLog) { Write-Host '--- postgres.log'; Get-Content $pgLog -Tail 60 }
}

Write-Host '==> first start'
$run = Start-Cmdb 'first'
$setup = Invoke-RestMethod "$($run.Base)/auth/setup"
if (-not $setup.needsSetup) { throw 'Expected the first-run setup' }
$body = @{ display_name = 'Smoke Test'; email = 'smoke@example.local'; password = 'smoke-test-password' } | ConvertTo-Json
Invoke-RestMethod "$($run.Base)/auth/setup" -Method Post -ContentType 'application/json' -Body $body -SessionVariable s1 | Out-Null
$me = Invoke-RestMethod "$($run.Base)/api/me" -WebSession $s1
if ($me.user.role -ne 'admin') { throw "Expected admin, got $($me.user.role)" }
$page = Invoke-WebRequest "$($run.Base)/" -UseBasicParsing
if ($page.Content -notmatch 'id="root"') { throw 'The web UI is not served' }
Write-Host '    setup, sign-in and web UI ok'

Write-Host '==> second double-click while running opens the existing instance'
& $node $launcher --no-browser
if ($LASTEXITCODE) { throw 'Second start while running failed' }

Write-Host '==> stop'
Stop-Cmdb $run

Write-Host '==> start again with existing data'
$run = Start-Cmdb 'second'
$setup = Invoke-RestMethod "$($run.Base)/auth/setup"
if ($setup.needsSetup) { throw 'Data was not kept between starts' }
$login = @{ email = 'smoke@example.local'; password = 'smoke-test-password' } | ConvertTo-Json
Invoke-RestMethod "$($run.Base)/auth/local-login" -Method Post -ContentType 'application/json' -Body $login -SessionVariable s2 | Out-Null
$me = Invoke-RestMethod "$($run.Base)/api/me" -WebSession $s2
if ($me.user.role -ne 'admin') { throw 'Sign-in after restart failed' }
Write-Host '    data kept, sign-in ok'
Stop-Cmdb $run

Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
Write-Host 'Windows package smoke test passed.'
