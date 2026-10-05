$ErrorActionPreference='Stop'
$orlBin='C:\Program Files\PostgreSQL\18\bin'
$orlSql=Join-Path $PSScriptRoot '..\..\supabase\049_ic_c3_authorized_reveal.sql'
$orlCa=Join-Path $PSScriptRoot '..\..\..\ic-encryption-package-b\certs\supabase-prod-ca-2021.crt'
$orlCaParameter=$orlCa.Replace('\','/').Replace("'","\'")
$orlConnection="host=aws-0-ap-southeast-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.imrfmilqehcrvassuvuw sslmode=verify-full sslrootcert='$orlCaParameter' connect_timeout=20"
$orlFolder=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ORL-Private-Backups'
$orlStamp=Get-Date -Format 'yyyyMMdd-HHmmss';$orlFile=Join-Path $orlFolder ("ORL-before-049-$orlStamp.dump");$orlPartial="$orlFile.partial"
$orlExpectedSql='B7F1D961BC2C8799D429CDFA9EA475498E7F4D65A8323BB621A0C7BBA7E2D238'
$orlExpectedCa='807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'
. (Join-Path $PSScriptRoot 'Test-OrlReviewedCa.ps1')
function Get-OrlFileSha256([string]$Path){$s=[IO.File]::OpenRead($Path);$h=[Security.Cryptography.SHA256]::Create();try{[BitConverter]::ToString($h.ComputeHash($s)).Replace('-','')}finally{$h.Dispose();$s.Dispose()}}
try{
  if((Get-OrlFileSha256 $orlSql)-ne$orlExpectedSql){throw 'STOP: reviewed migration 049 changed.'}
  Test-OrlReviewedCa -Path $orlCa -ExpectedDerSha256 $orlExpectedCa
  foreach($tool in 'psql.exe','pg_dump.exe','pg_restore.exe'){if(!(Test-Path -LiteralPath (Join-Path $orlBin $tool))){throw "Missing PostgreSQL tool: $tool"}}
  New-Item -ItemType Directory -Force -Path $orlFolder|Out-Null
  Write-Host 'STEP 1/4: Read-only C3 production preflight. Password entry is private.' -ForegroundColor Yellow
  $pre=@"
begin read only;
do `$`$declare s jsonb;begin
 if to_regprocedure('public.orl_ic_c2_finalize(uuid,text,uuid,uuid)') is null then raise exception '048 missing'; end if;
 if to_regprocedure('public.orl_ic_c3_reveal_view(uuid,text,uuid,text,uuid)') is not null or to_regclass('orl_private.c3_reveal_lease') is not null then raise exception '049 already installed or conflicts'; end if;
 if not orl_private.c1_recovery_ready() then raise exception 'Recovery readiness failed'; end if;
 s:=orl_private.c2_stats();
 if (s->>'complete')::boolean is distinct from true or (s->>'missing_unsupported')::integer<>0 or (s->>'blank_with_identity')::integer<>0 then raise exception 'C2 reconciliation is not complete'; end if;
 if not exists(select 1 from orl_private.c2_verification_runs where completed_at is not null) then raise exception 'C2 completion receipt missing'; end if;
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
  if((Read-Host 'Type INSTALL 049 to continue')-cne'INSTALL 049'){throw 'Operator cancelled before database mutation.'}
  Write-Host 'STEP 3/4: Install migration 049 atomically.' -ForegroundColor Yellow
  & "$orlBin\psql.exe" -X --dbname=$orlConnection --password -v ON_ERROR_STOP=1 -f $orlSql
  if($LASTEXITCODE-ne 0){throw 'Installation did not report success. Inspect production state before retrying.'}
  Write-Host 'STEP 4/4: Read-only role, privilege and audit-policy verification.' -ForegroundColor Yellow
  $post=@"
begin read only;
select to_regprocedure('public.orl_ic_c3_reveal_view(uuid,text,uuid,text,uuid)') is not null
 and to_regprocedure('public.orl_ic_c3_reveal_commit(uuid,text,uuid,uuid,uuid,timestamptz)') is not null
 and has_function_privilege('service_role','public.orl_ic_c3_reveal_view(uuid,text,uuid,text,uuid)','EXECUTE')
 and not has_function_privilege('anon','public.orl_ic_c3_reveal_view(uuid,text,uuid,text,uuid)','EXECUTE')
 and not has_function_privilege('authenticated','public.orl_ic_c3_reveal_view(uuid,text,uuid,text,uuid)','EXECUTE')
 and not has_table_privilege('service_role','orl_private.c3_reveal_lease','SELECT,INSERT,UPDATE,DELETE');
rollback;
"@
  $result=$post|& "$orlBin\psql.exe" -X --dbname=$orlConnection --password -v ON_ERROR_STOP=1 -At
  if($LASTEXITCODE-ne 0-or($result|Where-Object{$_-eq't'}).Count-ne 1){throw 'Post-install state is uncertain. Do not deploy C3 Edge yet.'}
  Write-Host 'SUCCESS: migration 049 installed. No IC was revealed or deleted.' -ForegroundColor Green
}catch{Write-Host $_.Exception.Message -ForegroundColor Red;Write-Host 'Keep the backup private. Do not retry an uncertain installation until state is checked.';exit 1}
