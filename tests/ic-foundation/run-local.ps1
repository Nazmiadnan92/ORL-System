$ErrorActionPreference='Stop'
$orlBin='C:\Program Files\PostgreSQL\18\bin'
$orlRepo=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$orlRun=Join-Path $orlRepo ('.local-postgres\ic-b-'+[guid]::NewGuid().ToString('N'))
$orlData=Join-Path $orlRun 'data'
$orlPort='55461'
$orlConn=@('-X','-h','127.0.0.1','-p',$orlPort,'-U','orl_test_owner','-d','postgres','-v','ON_ERROR_STOP=1')
$orlStarted=$false
$orlOldOptions=$env:PGOPTIONS
$orlOldPsql=$env:ORL_IC_TEST_PSQL
$orlOldPort=$env:ORL_IC_TEST_PORT
New-Item -ItemType Directory -Path $orlRun -Force | Out-Null
try {
  $env:PGOPTIONS=''
  & "$orlBin\initdb.exe" -D $orlData -U orl_test_owner --auth=trust --encoding=UTF8 --locale=C | Out-Null
  if ($LASTEXITCODE -ne 0 -or !(Test-Path (Join-Path $orlData 'PG_VERSION'))) { throw 'Synthetic database initialization failed.' }
  # Separate handles keep the background server from holding the PowerShell pipe open.
  $orlLaunchArgs=@('-D',('"'+$orlData+'"'),'-l',('"'+(Join-Path $orlRun 'server.log')+'"'),'-o',('"-h 127.0.0.1 -p '+$orlPort+'"'),'-w','start')
  $orlLauncher=Start-Process -FilePath "$orlBin\pg_ctl.exe" -ArgumentList $orlLaunchArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $orlRun 'launch.out') -RedirectStandardError (Join-Path $orlRun 'launch.err')
  if (!$orlLauncher.WaitForExit(30000)) { throw 'Synthetic launcher timed out; inspect this run before retrying.' }
  if ($orlLauncher.ExitCode -ne 0) { throw 'Synthetic server start failed.' }
  $orlStarted=$true
  & "$orlBin\psql.exe" @orlConn -c 'CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto WITH SCHEMA extensions;' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Synthetic role setup failed.' }
  foreach ($orlMigration in (Get-ChildItem (Join-Path $orlRepo 'supabase\*.sql') | Where-Object { $_.Name -match '^0(0[1-9]|[1-3][0-9]|4[0-4])_' -and $_.Name -notmatch '^018_' } | Sort-Object Name)) {
    & "$orlBin\psql.exe" @orlConn -f $orlMigration.FullName 2>&1 | Out-File (Join-Path $orlRun 'migrations.log') -Append
    if ($LASTEXITCODE -ne 0) { throw "Migration failed: $($orlMigration.Name). See synthetic log: $orlRun" }
  }
  Write-Output 'PASS: migrations 001-017 and 019-044 replayed on empty local PostgreSQL (no production export).'
  Write-Output 'LIMIT: 018 holiday-fetch extension http is Supabase-specific and excluded; holiday fetching is not tested by this package.'
  $orlMigration=Join-Path $orlRepo 'supabase\045_ic_encryption_foundation.sql'
  & "$orlBin\psql.exe" @orlConn -f (Join-Path $PSScriptRoot 'before.sql') -f $orlMigration -f (Join-Path $PSScriptRoot 'regression.sql')
  if ($LASTEXITCODE -ne 0) { throw 'Foundation SQL regression failed.' }
  $orlAgain=& "$orlBin\psql.exe" @orlConn -f $orlMigration 2>&1
  if ($LASTEXITCODE -eq 0 -or ($orlAgain -join "`n") -notmatch 'foundation already exists') { throw 'Reinstall guard failed.' }
  Write-Output 'PASS: second installation refused without overwriting foundation.'
  $env:ORL_IC_TEST_PSQL=Join-Path $orlBin 'psql.exe'
  $env:ORL_IC_TEST_PORT=$orlPort
  & node --test (Join-Path $PSScriptRoot 'crypto.test.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Crypto/HTTP/PostgreSQL integration tests failed.' }
} finally {
  $env:PGOPTIONS=$orlOldOptions
  $env:ORL_IC_TEST_PSQL=$orlOldPsql
  $env:ORL_IC_TEST_PORT=$orlOldPort
  if ($orlStarted) {
    & "$orlBin\pg_ctl.exe" -D $orlData -m fast -w stop | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Test server shutdown failed; inspect before continuing.' }
    Write-Output 'STOPPED: disposable local test server.'
  }
}
