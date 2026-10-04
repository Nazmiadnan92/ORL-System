$ErrorActionPreference='Stop'
$orlBin='C:\Program Files\PostgreSQL\18\bin'
$orlSql=Join-Path $PSScriptRoot '..\..\supabase\047_mask_ic_last_six.sql'
$orlCa=Join-Path $PSScriptRoot '..\..\..\ic-encryption-package-b\certs\supabase-prod-ca-2021.crt'
$orlCaParameter=$orlCa.Replace('\','/').Replace("'","\'")
$orlConnection="host=aws-0-ap-southeast-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.imrfmilqehcrvassuvuw sslmode=verify-full sslrootcert='$orlCaParameter' connect_timeout=20"
$orlFolder=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ORL-Private-Backups'
$orlStamp=Get-Date -Format 'yyyyMMdd-HHmmss'
$orlFile=Join-Path $orlFolder ("ORL-before-047-$orlStamp.dump")
$orlPartial="$orlFile.partial"
$orlExpectedSql='9FAD29E497EE94D5A38CEB2CC8F85EF6CC765D662134A9058F14D94840E2F0D4'
$orlExpectedCa='807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'
. (Join-Path $PSScriptRoot 'Test-OrlReviewedCa.ps1')
function Get-OrlFileSha256([string]$Path) {
  $orlStream=[IO.File]::OpenRead($Path)
  $orlSha=[Security.Cryptography.SHA256]::Create()
  try { [BitConverter]::ToString($orlSha.ComputeHash($orlStream)).Replace('-','') }
  finally { $orlSha.Dispose(); $orlStream.Dispose() }
}
try {
  if ((Get-OrlFileSha256 -Path $orlSql) -ne $orlExpectedSql) { throw 'STOP: reviewed migration 047 changed.' }
  Test-OrlReviewedCa -Path $orlCa -ExpectedDerSha256 $orlExpectedCa
  foreach($orlTool in 'psql.exe','pg_dump.exe','pg_restore.exe') {
    if(!(Test-Path -LiteralPath (Join-Path $orlBin $orlTool))){throw "Missing PostgreSQL tool: $orlTool"}
  }
  New-Item -ItemType Directory -Force -Path $orlFolder | Out-Null
  Write-Host 'STEP 1/4: Read-only production preflight. Password entry is private.' -ForegroundColor Yellow
  $orlPreflight=@"
begin read only;
do `$`$begin
 if to_regprocedure('public.orl_ic_c1_create(uuid,uuid,jsonb,jsonb,jsonb,uuid)') is null then raise exception '046 missing'; end if;
 if not orl_private.c1_recovery_ready() then raise exception 'C1 recovery gate is not ready'; end if;
 if orl_private.c1_mask_ic('010203-04-5678') is distinct from '******-**-5678' then raise exception '047 already installed or masking baseline differs'; end if;
 if orl_private.c1_redact_text('IC 010203-04-5678.') is distinct from 'IC ******-**-5678.' then raise exception 'Free-text masking baseline differs'; end if;
end `$`$;
rollback;
"@
  $orlPreflight | & "$orlBin\psql.exe" -X --dbname=$orlConnection --password -v ON_ERROR_STOP=1
  if($LASTEXITCODE-ne 0){throw 'Preflight failed. Installation was not started.'}
  Write-Host 'STEP 2/4: Fresh full private database dump. Restore is not run.' -ForegroundColor Yellow
  & "$orlBin\pg_dump.exe" --dbname=$orlConnection --format=custom --file=$orlPartial --password
  if($LASTEXITCODE-ne 0){throw 'Backup failed. Installation was not started.'}
  & "$orlBin\pg_restore.exe" --list $orlPartial | Out-Null
  if($LASTEXITCODE-ne 0){throw 'Backup archive check failed. Installation was not started.'}
  Move-Item -LiteralPath $orlPartial -Destination $orlFile
  Write-Host "Private backup: $orlFile"
  if((Read-Host 'Type INSTALL 047 to continue') -cne 'INSTALL 047'){throw 'Operator cancelled before database mutation.'}
  Write-Host 'STEP 3/4: Install migration 047 atomically.' -ForegroundColor Yellow
  & "$orlBin\psql.exe" -X --dbname=$orlConnection --password -v ON_ERROR_STOP=1 -f $orlSql
  if($LASTEXITCODE-ne 0){throw 'Installation did not report success. Inspect production state before any retry.'}
  Write-Host 'STEP 4/4: Read-only post-install verification.' -ForegroundColor Yellow
  $orlPost=@"
begin read only;
select (orl_private.c1_mask_ic('010203-04-5678')='010203-**-****')
 and (orl_private.c1_mask_ic('010203045678')='010203-**-****')
 and (orl_private.c1_redact_text('IC 010203045678.')='IC 010203-**-****.')
 and not has_function_privilege('anon','orl_private.c1_mask_ic(text)','EXECUTE')
 and not has_function_privilege('authenticated','orl_private.c1_mask_ic(text)','EXECUTE')
 and not has_function_privilege('service_role','orl_private.c1_mask_ic(text)','EXECUTE');
rollback;
"@
  $orlResult=$orlPost | & "$orlBin\psql.exe" -X --dbname=$orlConnection --password -v ON_ERROR_STOP=1 -At
  if($LASTEXITCODE-ne 0 -or ($orlResult|Where-Object{$_ -eq 't'}).Count-ne 1){throw 'Post-install state is uncertain. Do not publish the matching website yet.'}
  Write-Host 'SUCCESS: migration 047 installed. IC display is now first 6 digits plus **-****.' -ForegroundColor Green
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host 'Keep the backup private. Do not retry an uncertain installation until the state is checked.'
  exit 1
}
