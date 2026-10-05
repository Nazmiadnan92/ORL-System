param([switch]$IncludeC1)
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
  # Deterministic disposable fixtures: explicit writer/maintenance-lock tests cover
  # NOWAIT refusal. Background autovacuum otherwise races mass restore test churn.
  # This switch applies ONLY to this newly initialized localhost test cluster.
  $orlLaunchArgs=@('-D',('"'+$orlData+'"'),'-l',('"'+(Join-Path $orlRun 'server.log')+'"'),'-o',('"-h 127.0.0.1 -p '+$orlPort+' -c autovacuum=off"'),'-w','start')
  $orlLauncher=Start-Process -FilePath "$orlBin\pg_ctl.exe" -ArgumentList $orlLaunchArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $orlRun 'launch.out') -RedirectStandardError (Join-Path $orlRun 'launch.err')
  if (!$orlLauncher.WaitForExit(30000)) { throw 'Synthetic launcher timed out; inspect this run before retrying.' }
  # Windows PowerShell can retain a stale/null ExitCode after WaitForExit when
  # stdout/stderr are redirected. Refresh before deciding that startup failed.
  $orlLauncher.Refresh()
  if ($orlLauncher.ExitCode -ne 0) {
    # Some Windows PostgreSQL builds report a non-zero launcher exit after
    # printing "server started". Trust only an exact data-directory status
    # check; this cannot accidentally bless another server on the same port.
    & "$orlBin\pg_ctl.exe" -D $orlData status | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Synthetic server start failed.' }
  }
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
  & (Join-Path $PSScriptRoot '..\ic-write\preflight-recovery.test.ps1') -Phase Pre
  if ($LASTEXITCODE -ne 0) { throw 'C1 pre-046 release preflight regression failed.' }
  & node --test (Join-Path $PSScriptRoot 'crypto.test.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Crypto/HTTP/PostgreSQL integration tests failed.' }
  if ($IncludeC1) {
    & node --test (Join-Path $PSScriptRoot '..\ic-write\create.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'C1 synthetic creation tests failed.' }
    & (Join-Path $PSScriptRoot '..\ic-write\migration-047.test.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'Migration 047 display-mask regression failed.' }
    & node --test (Join-Path $PSScriptRoot '..\ic-write\c2-gateway.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'C2 Edge encryption/reconciliation tests failed.' }
    & node --test (Join-Path $PSScriptRoot '..\ic-write\c2-integration.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'C2 migration/backfill integration tests failed.' }
    & node --test (Join-Path $PSScriptRoot '..\ic-write\c3-gateway.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'C3 gateway/reveal tests failed.' }
    & node --test (Join-Path $PSScriptRoot '..\ic-write\c3-integration.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'C3 migration/lease/audit integration tests failed.' }
    & node --test (Join-Path $PSScriptRoot '..\ic-write\c6-gateway.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'C6 gateway/backup/search tests failed.' }
    & node --test (Join-Path $PSScriptRoot '..\ic-write\c6-integration.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'C6 migration/cutover integration tests failed.' }
    & (Join-Path $PSScriptRoot '..\ic-write\preflight-recovery.test.ps1') -Phase Post
    if ($LASTEXITCODE -ne 0) { throw 'C1 post-046 release preflight regression failed.' }
    & node --test (Join-Path $PSScriptRoot '..\ic-write\browser.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'C1 browser/portable-backup compatibility tests failed.' }
    & node --test (Join-Path $PSScriptRoot '..\ic-write\app-wiring.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'C1 staged application wiring tests failed.' }
    & node --test (Join-Path $PSScriptRoot '..\ic-write\backup-conversion-ui.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'C1 backup conversion UI/file tests failed.' }
    & node --test (Join-Path $PSScriptRoot '..\ic-write\creation-recovery.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'C1 pending creation recovery tests failed.' }
    & node --test (Join-Path $PSScriptRoot '..\ic-write\legacy-backup.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'C1 local legacy backup conversion tests failed.' }
    & node --test (Join-Path $PSScriptRoot '..\ic-write\gateway.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'C1 gateway tests failed.' }
    & node --test (Join-Path $PSScriptRoot '..\ic-write\runtime.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'C1 desktop/mobile/Edge runtime policy tests failed.' }
    & node --test (Join-Path $PSScriptRoot '..\ic-write\release.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'C1 guarded release artifact tests failed.' }
    & node --test (Join-Path $PSScriptRoot '..\ic-write\c2-release.test.mjs') (Join-Path $PSScriptRoot '..\ic-write\c3-release.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'C2/C3 guarded release artifact tests failed.' }
    & node --test (Join-Path $PSScriptRoot '..\ic-write\c4-release.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'C4 guarded verification artifact tests failed.' }
    & (Join-Path $orlRepo 'security\release\verify-c4.ps1') -SelfTest
    if ($LASTEXITCODE -ne 0) { throw 'C4 synthetic recovery/identity verification failed.' }
    & node --test (Join-Path $PSScriptRoot '..\ic-write\c5-observation.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'C5 observation artifact tests failed.' }
    & (Join-Path $orlRepo 'security\release\observe-c5.ps1') -SelfTest
    if ($LASTEXITCODE -ne 0) { throw 'C5 masking observer self-test failed.' }
    & node --test (Join-Path $PSScriptRoot '..\ic-write\c6-release.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'C6 guarded release artifact tests failed.' }
    & node --test (Join-Path $PSScriptRoot '..\ic-write\c7-release.test.mjs') (Join-Path $PSScriptRoot '..\ic-write\c7-browser.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'C7 release/browser tests failed.' }
    & (Join-Path $orlRepo 'security\release\verify-c7.ps1') -SelfTest
    if ($LASTEXITCODE -ne 0) { throw 'C7 synthetic masked-source recovery test failed.' }
    & (Join-Path $orlRepo 'security\release\observe-c7.ps1') -SelfTest
    if ($LASTEXITCODE -ne 0) { throw 'C7 masked observer test failed.' }
  }
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
if($IncludeC1){
  # C7 hash guards apply to shipped 046 definitions, not the C1 local-only fixtures.
  & (Join-Path $PSScriptRoot '..\ic-write\run-c7-local.ps1')
  if($LASTEXITCODE-ne0){throw 'C7 production-definition integration failed.'}
}
