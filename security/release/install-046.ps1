$ErrorActionPreference='Stop'
$orlBin='C:\Program Files\PostgreSQL\18\bin'
$orlSql=Join-Path $PSScriptRoot '..\..\supabase\046_ic_c1_guarded_cutover.sql'
$orlCa=Join-Path $PSScriptRoot '..\..\..\ic-encryption-package-b\certs\supabase-prod-ca-2021.crt'
$orlCaParameter=$orlCa.Replace('\','/').Replace("'","\'")
$orlConnection="host=aws-0-ap-southeast-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.imrfmilqehcrvassuvuw sslmode=verify-full sslrootcert='$orlCaParameter' connect_timeout=20"
$orlFolder=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ORL-Private-Backups'
$orlStamp=Get-Date -Format 'yyyyMMdd-HHmmss'
$orlFile=Join-Path $orlFolder ("ORL-before-046-$orlStamp.dump")
$orlPartial="$orlFile.partial"
$orlReport=Join-Path $orlFolder ("ORL-before-046-$orlStamp.preflight.txt")
$orlExpectedSql='F7CD04881D13A5D88E3ECF3B36D266D3A58DF9AD1C97EACF4C32507EBEF7B154'
$orlExpectedCa='807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'
. (Join-Path $PSScriptRoot 'Test-OrlReviewedCa.ps1')
try {
  if ((Get-FileHash -LiteralPath $orlSql -Algorithm SHA256).Hash -ne $orlExpectedSql) { throw 'STOP: reviewed migration 046 changed.' }
  Test-OrlReviewedCa -Path $orlCa -ExpectedDerSha256 $orlExpectedCa
  foreach($orlTool in 'psql.exe','pg_dump.exe','pg_restore.exe') { if(!(Test-Path -LiteralPath (Join-Path $orlBin $orlTool))){throw "Missing PostgreSQL tool: $orlTool"} }
  New-Item -ItemType Directory -Force -Path $orlFolder | Out-Null
  Write-Host 'STEP 1/4: Read-only production preflight. Password entry is private.' -ForegroundColor Yellow
  $orlPreflight=@"
begin read only;
select jsonb_build_object('checked_at',clock_timestamp(),'foundation_045',to_regprocedure('public.orl_ic_foundation_probe(uuid)') is not null,
'cutover_046',to_regprocedure('public.orl_ic_c1_create(uuid,uuid,jsonb,jsonb,jsonb,uuid)') is not null,
'create_040_md5',(select md5(replace(prosrc,chr(13),'')) from pg_proc where oid=to_regprocedure('public.orl_create_request(uuid,jsonb)')),
'requests',(select count(*) from public.orl_requests),'identities',(select count(*) from orl_private.request_identity),
'database_bytes',pg_database_size(current_database()));
do `$`$begin
 if to_regprocedure('public.orl_ic_foundation_probe(uuid)') is null then raise exception '045 missing'; end if;
 if to_regprocedure('public.orl_ic_c1_create(uuid,uuid,jsonb,jsonb,jsonb,uuid)') is not null then raise exception '046 already present'; end if;
 if (select md5(replace(prosrc,chr(13),'')) from pg_proc where oid=to_regprocedure('public.orl_create_request(uuid,jsonb)')) is distinct from '510bb2377c27c11629428fe90244aba7' then raise exception '040 baseline differs'; end if;
 if (select count(*) from public.orl_requests)>2000 then raise exception 'request count exceeds C1 policy'; end if;
 if (select count(*) from orl_private.request_identity)<>0 then raise exception 'pre-C1 identity table is not empty'; end if;
end `$`$; rollback;
"@
  $orlPreflightOutput=$orlPreflight | & "$orlBin\psql.exe" -X --dbname=$orlConnection --password -v ON_ERROR_STOP=1 -At
  if($LASTEXITCODE-ne 0){throw 'Preflight failed. Installation was not started.'}
  $orlPreflightOutput | Out-File -LiteralPath $orlReport -Encoding utf8
  Write-Host 'STEP 2/4: Fresh full private database dump. This does not run Restore.' -ForegroundColor Yellow
  & "$orlBin\pg_dump.exe" --dbname=$orlConnection --format=custom --file=$orlPartial --password
  if($LASTEXITCODE-ne 0){throw 'Backup failed. Installation was not started.'}
  & "$orlBin\pg_restore.exe" --list $orlPartial | Out-Null
  if($LASTEXITCODE-ne 0){throw 'Backup archive check failed. Installation was not started.'}
  Move-Item -LiteralPath $orlPartial -Destination $orlFile
  Write-Host "Private backup: $orlFile"
  if((Read-Host 'Type INSTALL C1 046 to continue') -cne 'INSTALL C1 046'){throw 'Operator cancelled before database mutation.'}
  Write-Host 'STEP 3/4: Install migration 046 atomically. Do not retry an uncertain result.' -ForegroundColor Yellow
  & "$orlBin\psql.exe" -X --dbname=$orlConnection --password -v ON_ERROR_STOP=1 -f $orlSql
  if($LASTEXITCODE-ne 0){throw 'Installation did not report success. Inspect production state before any retry.'}
  Write-Host 'STEP 4/4: Read-only post-install state check.' -ForegroundColor Yellow
  $orlPost=& "$orlBin\psql.exe" -X --dbname=$orlConnection --password -v ON_ERROR_STOP=1 -Atc "begin read only; select (to_regprocedure('public.orl_ic_c1_create(uuid,uuid,jsonb,jsonb,jsonb,uuid)') is not null) and orl_private.c1_recovery_ready() and (select count(*) from orl_private.request_identity)=0; rollback;"
  if($LASTEXITCODE-ne 0 -or ($orlPost|Where-Object{$_ -eq 't'}).Count-ne 1){throw 'Post-install state is uncertain. Keep C1 Edge and website OFF.'}
  Write-Host 'SUCCESS: migration 046 installed; Edge and website activation remain separate.' -ForegroundColor Green
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host 'Keep ORL_IC_C1_ENABLED=false and website icProtectionEnabled=false. Preserve the backup/report and inspect before retrying.'
  exit 1
}
