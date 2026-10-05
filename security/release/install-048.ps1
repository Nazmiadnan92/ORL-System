$ErrorActionPreference='Stop'
$orlBin='C:\Program Files\PostgreSQL\18\bin'
$orlSql=Join-Path $PSScriptRoot '..\..\supabase\048_ic_c2_controlled_legacy_backfill.sql'
$orlCa=Join-Path $PSScriptRoot '..\..\..\ic-encryption-package-b\certs\supabase-prod-ca-2021.crt'
$orlCaParameter=$orlCa.Replace('\','/').Replace("'","\'")
$orlConnection="host=aws-0-ap-southeast-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.imrfmilqehcrvassuvuw sslmode=verify-full sslrootcert='$orlCaParameter' connect_timeout=20"
$orlFolder=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ORL-Private-Backups'
$orlStamp=Get-Date -Format 'yyyyMMdd-HHmmss';$orlFile=Join-Path $orlFolder ("ORL-before-048-$orlStamp.dump");$orlPartial="$orlFile.partial"
$orlExpectedSql='B46A795C96ADCEC977DE02E4CDCD341F7AF7B23313A75BF0FCC3529A62896FD3'
$orlExpectedCa='807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'
. (Join-Path $PSScriptRoot 'Test-OrlReviewedCa.ps1')
function Get-OrlFileSha256([string]$Path){$s=[IO.File]::OpenRead($Path);$h=[Security.Cryptography.SHA256]::Create();try{[BitConverter]::ToString($h.ComputeHash($s)).Replace('-','')}finally{$h.Dispose();$s.Dispose()}}
try{
  if((Get-OrlFileSha256 $orlSql)-ne $orlExpectedSql){throw 'STOP: reviewed migration 048 changed.'}
  Test-OrlReviewedCa -Path $orlCa -ExpectedDerSha256 $orlExpectedCa
  foreach($tool in 'psql.exe','pg_dump.exe','pg_restore.exe'){if(!(Test-Path -LiteralPath (Join-Path $orlBin $tool))){throw "Missing PostgreSQL tool: $tool"}}
  New-Item -ItemType Directory -Force -Path $orlFolder|Out-Null
  Write-Host 'STEP 1/4: Read-only production preflight. Password entry is private.' -ForegroundColor Yellow
  $pre=@"
begin read only;
do `$`$begin
 if to_regprocedure('public.orl_ic_c1_create(uuid,uuid,jsonb,jsonb,jsonb,uuid)') is null then raise exception '046 missing'; end if;
 if orl_private.c1_mask_ic('010203-04-5678') is distinct from '010203-**-****' then raise exception '047 missing'; end if;
 if not orl_private.c1_recovery_ready() then raise exception 'C1 recovery gate is not ready'; end if;
 if to_regprocedure('public.orl_ic_c2_status(uuid,text)') is not null or to_regclass('orl_private.c2_verification_runs') is not null then raise exception '048 already installed or conflicts'; end if;
end `$`$;
rollback;
"@
  $pre|& "$orlBin\psql.exe" -X --dbname=$orlConnection --password -v ON_ERROR_STOP=1
  if($LASTEXITCODE-ne 0){throw 'Preflight failed. Installation was not started.'}
  Write-Host 'STEP 2/4: Fresh full private database dump. Restore is not run.' -ForegroundColor Yellow
  & "$orlBin\pg_dump.exe" --dbname=$orlConnection --format=custom --file=$orlPartial --password
  if($LASTEXITCODE-ne 0){throw 'Backup failed. Installation was not started.'}
  & "$orlBin\pg_restore.exe" --list $orlPartial|Out-Null
  if($LASTEXITCODE-ne 0){throw 'Backup archive check failed. Installation was not started.'}
  Move-Item -LiteralPath $orlPartial -Destination $orlFile;Write-Host "Private backup: $orlFile"
  if((Read-Host 'Type INSTALL 048 to continue')-cne 'INSTALL 048'){throw 'Operator cancelled before database mutation.'}
  Write-Host 'STEP 3/4: Install migration 048 atomically.' -ForegroundColor Yellow
  & "$orlBin\psql.exe" -X --dbname=$orlConnection --password -v ON_ERROR_STOP=1 -f $orlSql
  if($LASTEXITCODE-ne 0){throw 'Installation did not report success. Inspect production state before any retry.'}
  Write-Host 'STEP 4/4: Read-only privilege and structure verification.' -ForegroundColor Yellow
  $post=@"
begin read only;
select to_regprocedure('public.orl_ic_c2_finalize(uuid,text,uuid,uuid)') is not null
 and to_regclass('orl_private.c2_verified_identity') is not null
 and has_function_privilege('service_role','public.orl_ic_c2_status(uuid,text)','EXECUTE')
 and not has_function_privilege('anon','public.orl_ic_c2_status(uuid,text)','EXECUTE')
 and not has_function_privilege('authenticated','public.orl_ic_c2_status(uuid,text)','EXECUTE')
 and not has_table_privilege('service_role','orl_private.c2_verified_identity','SELECT,INSERT,UPDATE,DELETE');
rollback;
"@
  $result=$post|& "$orlBin\psql.exe" -X --dbname=$orlConnection --password -v ON_ERROR_STOP=1 -At
  if($LASTEXITCODE-ne 0-or($result|Where-Object{$_-eq't'}).Count-ne 1){throw 'Post-install state is uncertain. Do not start C2.'}
  Write-Host 'SUCCESS: migration 048 installed. No legacy IC has been encrypted or deleted yet.' -ForegroundColor Green
}catch{Write-Host $_.Exception.Message -ForegroundColor Red;Write-Host 'Keep the backup private. Do not retry an uncertain installation until state is checked.';exit 1}
