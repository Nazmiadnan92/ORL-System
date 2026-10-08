param([switch]$WithOtExport,[switch]$WithSessionHelperGuard,[switch]$WithPostponeVersion,[switch]$WithMaintenance,[switch]$WithBookingWorkflow,[switch]$WithStatistics,[switch]$WithSharedStatistics,[switch]$WithPastOt)
if($WithPastOt){$WithSharedStatistics=$true}
if($WithSharedStatistics){$WithStatistics=$true}
if($WithStatistics){$WithBookingWorkflow=$true}
if($WithBookingWorkflow){$WithMaintenance=$true}
if($WithMaintenance){$WithPostponeVersion=$true}
if($WithPostponeVersion){$WithSessionHelperGuard=$true}
if($WithSessionHelperGuard){$WithOtExport=$true}
$ErrorActionPreference='Stop'
$orlBin='C:\Program Files\PostgreSQL\18\bin'
$orlRepo=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$orlRun=Join-Path $orlRepo ('.local-postgres\c7-'+[guid]::NewGuid().ToString('N'))
$orlPort='55461'
$orlData=Join-Path $orlRun 'data';$orlStarted=$false
$orlOldPsql=$env:ORL_IC_TEST_PSQL;$orlOldPort=$env:ORL_IC_TEST_PORT
$orlOldC7=$env:ORL_IC_TEST_C7;$env:ORL_IC_TEST_C7='1'
New-Item -ItemType Directory -Path $orlRun -Force|Out-Null
try{
  & "$orlBin\initdb.exe" -D $orlData -U orl_test_owner --auth=trust --encoding=UTF8 --locale=C|Out-Null
  if($LASTEXITCODE-ne 0){throw 'C7 database initialization failed.'}
  $orlLaunchArgs=@('-D',('"'+$orlData+'"'),'-l',('"'+(Join-Path $orlRun 'server.log')+'"'),'-o',('"-h 127.0.0.1 -p '+$orlPort+' -c autovacuum=off"'),'-w','start')
  $orlLauncher=Start-Process -FilePath "$orlBin\pg_ctl.exe" -ArgumentList $orlLaunchArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $orlRun 'launch.out') -RedirectStandardError (Join-Path $orlRun 'launch.err')
  if(!$orlLauncher.WaitForExit(30000)){throw 'C7 database launcher timed out.'};$orlLauncher.Refresh()
  if($orlLauncher.ExitCode-ne 0){& "$orlBin\pg_ctl.exe" -D $orlData status|Out-Null;if($LASTEXITCODE-ne0){throw 'C7 database start failed.'}};$orlStarted=$true
  $orlArgs=@('-X','-h','127.0.0.1','-p',$orlPort,'-U','orl_test_owner','-d','postgres','-v','ON_ERROR_STOP=1')
  & "$orlBin\psql.exe" @orlArgs -c 'CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto WITH SCHEMA extensions;'|Out-Null
  if($WithSessionHelperGuard){
    # Model explicit public-schema client grants, not only PostgreSQL PUBLIC.
    & "$orlBin\psql.exe" @orlArgs -c 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role;'|Out-Null
    if($LASTEXITCODE-ne0){throw 'Synthetic Supabase-style function grants failed.'}
  }
  foreach($orlMigration in (Get-ChildItem (Join-Path $orlRepo 'supabase\*.sql')|Where-Object{$_.Name-match '^0(0[1-9]|[1-3][0-9]|4[0-7])_'}|Sort-Object Name)){
    if($orlMigration.Name -like '018_*'){
      $orlFixture=@'
create type extensions.http_response as (status integer,content text);
create function extensions.http_get(varchar) returns extensions.http_response language sql as $$select 200,''::text$$;
'@
      $orlFixture|& "$orlBin\psql.exe" @orlArgs|Out-Null
      if($LASTEXITCODE-ne 0){throw 'Unable to create offline-only HTTP fixture.'}
      ((Get-Content $orlMigration.FullName -Raw).Replace('create extension if not exists http with schema extensions;','-- offline local fixture'))|& "$orlBin\psql.exe" @orlArgs 2>&1|Out-File (Join-Path $orlRun 'migrations.log') -Append
    }else{
      & "$orlBin\psql.exe" @orlArgs -f $orlMigration.FullName 2>&1|Out-File (Join-Path $orlRun 'migrations.log') -Append
    }
    if($LASTEXITCODE-ne 0){throw "C7 prerequisite failed: $($orlMigration.Name). Log: $orlRun"}
  }
  $orlSeed="insert into public.orl_users(id,username,password_hash,display_name,role) values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','c1_webmaster','unused','Synthetic Webmaster','WEBMASTER'); insert into public.orl_sessions(user_id,token_hash,expires_at) values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',encode(extensions.digest('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','sha256'),'hex'),now()+interval '1 hour');"
  $orlSeed|& "$orlBin\psql.exe" @orlArgs|Out-Null
  if($LASTEXITCODE-ne 0){throw 'C7 synthetic account seed failed.'}
  $env:ORL_IC_TEST_PSQL=Join-Path $orlBin 'psql.exe';$env:ORL_IC_TEST_PORT=$orlPort
  foreach($suite in @('c2-integration.test.mjs','c3-integration.test.mjs','c6-integration.test.mjs')){
    & node --test (Join-Path $PSScriptRoot $suite)
    if($LASTEXITCODE-ne 0){throw "C7 integration failed: $suite"}
  }
  if($WithSessionHelperGuard){
    & node --test (Join-Path $PSScriptRoot 'session-helper-integration.test.mjs')
    if($LASTEXITCODE-ne0){throw 'Session helper lockdown integration failed.'}
  }
  if($WithOtExport){
    & node --test (Join-Path $PSScriptRoot 'ot-export-integration.test.mjs')
    if($LASTEXITCODE-ne0){throw 'OT export integration failed.'}
  }
  if($WithPostponeVersion){
    & node --test (Join-Path $PSScriptRoot 'postpone-version-release.test.mjs')
    if($LASTEXITCODE-ne0){throw 'Postpone release safety tests failed.'}
    & node --test (Join-Path $PSScriptRoot 'postpone-version-integration.test.mjs')
    if($LASTEXITCODE-ne0){throw 'Postpone record-version integration failed.'}
  }
  if($WithMaintenance){
    & node --test (Join-Path $PSScriptRoot 'maintenance-integration.test.mjs')
    if($LASTEXITCODE-ne0){throw 'Maintenance integration failed.'}
  }
  if($WithBookingWorkflow){
    foreach($suite in @('booking-install-integration.test.mjs','booking-move-integration.test.mjs','special-capacity-integration.test.mjs')){
      & node --test (Join-Path $PSScriptRoot $suite)
      if($LASTEXITCODE-ne0){throw "Booking workflow integration failed: $suite"}
    }
  }
  if($WithStatistics){
    & node --test (Join-Path $PSScriptRoot 'statistics-integration.test.mjs')
    if($LASTEXITCODE-ne0){throw 'Global statistics integration failed.'}
  }
  if($WithSharedStatistics){
    & node --test (Join-Path $PSScriptRoot 'shared-statistics-release.test.mjs')
    if($LASTEXITCODE-ne0){throw 'Shared statistics release safety tests failed.'}
    & node --test (Join-Path $PSScriptRoot 'shared-statistics-integration.test.mjs')
    if($LASTEXITCODE-ne0){throw 'Shared statistics patient list integration failed.'}
  }
  if($WithPastOt){
    & node --test (Join-Path $PSScriptRoot 'past-ot-integration.test.mjs')
    if($LASTEXITCODE-ne0){throw 'Past OT booking protection integration failed.'}
  }
}finally{
  $env:ORL_IC_TEST_PSQL=$orlOldPsql;$env:ORL_IC_TEST_PORT=$orlOldPort
  $env:ORL_IC_TEST_C7=$orlOldC7
  if($orlStarted){& "$orlBin\pg_ctl.exe" -D $orlData -m fast -w stop|Out-Null;Write-Output 'STOPPED: disposable C7 database.'}
}
