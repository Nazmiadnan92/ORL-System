$ErrorActionPreference='Stop'
$orlBin='C:\Program Files\PostgreSQL\18\bin';$orlSql=Join-Path $PSScriptRoot '..\..\supabase\051_ic_c6_scoped_updates.sql'
$orlCa=Join-Path $PSScriptRoot '..\..\..\ic-encryption-package-b\certs\supabase-prod-ca-2021.crt';$ca=$orlCa.Replace('\','/').Replace("'","\'")
$orlConnection="host=aws-0-ap-southeast-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.imrfmilqehcrvassuvuw sslmode=verify-full sslrootcert='$ca' connect_timeout=20"
$orlFolder=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ORL-Private-Backups';$stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
$file=Join-Path $orlFolder "ORL-before-051-$stamp.dump";$partial="$file.partial";$expected='8AA9CA227797D4EC3B86A291E1493F2973CEF7FC39E6118DA1F031C19E548C23'
. (Join-Path $PSScriptRoot 'Test-OrlReviewedCa.ps1')
function Get-OrlHash([string]$Path){
  $orlStream=[IO.File]::OpenRead($Path);$orlSha=[Security.Cryptography.SHA256]::Create()
  try{[BitConverter]::ToString($orlSha.ComputeHash($orlStream)).Replace('-','')}
  finally{$orlSha.Dispose();$orlStream.Dispose()}
}
try{
  if((Get-OrlHash $orlSql)-ne$expected){throw 'STOP: reviewed migration 051 changed.'}
  Test-OrlReviewedCa -Path $orlCa -ExpectedDerSha256 '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'
  New-Item -ItemType Directory -Force -Path $orlFolder|Out-Null
  Write-Host 'C6 REPAIR 051: function definition only. Enter DATABASE password privately.' -ForegroundColor Yellow
  $pre=@"
begin read only;
do `$`$declare s jsonb;begin
 if to_regprocedure('public.orl_ic_c3_reveal_commit(uuid,text,uuid,uuid,uuid,timestamptz)') is null then raise exception '049 missing'; end if;
 if to_regprocedure('public.orl_ic_c6_cutover(uuid,text,uuid,uuid)') is null then raise exception '050 missing'; end if;
 if exists(select 1 from orl_private.c6_cutover_receipt where singleton) then raise exception 'C6 already complete'; end if;
 if (select md5(replace(prosrc,chr(13),'')) from pg_proc where oid='public.orl_ic_c6_cutover(uuid,text,uuid,uuid)'::regprocedure) is distinct from '5977247e4a158cf152bc77cbaf263a8e' then raise exception 'Reviewed 050 baseline differs or 051 already installed'; end if;
 if not orl_private.c1_recovery_ready() then raise exception 'Recovery readiness failed'; end if;
 s:=orl_private.c2_stats();
 if (s->>'complete')::boolean is distinct from true or (s->>'missing_unsupported')::integer<>0 or (s->>'blank_with_identity')::integer<>0 then raise exception 'Identity coverage incomplete'; end if;
end `$`$;
rollback;
"@
  $pre|& "$orlBin\psql.exe" -X --dbname=$orlConnection --password -v ON_ERROR_STOP=1
  if($LASTEXITCODE-ne0){throw 'Preflight failed. Nothing was installed.'}
  Write-Host 'Creating fresh full private backup before migration 051. Restore is not run.' -ForegroundColor Yellow
  & "$orlBin\pg_dump.exe" --dbname=$orlConnection --format=custom --file=$partial --password
  if($LASTEXITCODE-ne0){throw 'Backup failed. Installation was not started.'}
  & "$orlBin\pg_restore.exe" --list $partial|Out-Null;if($LASTEXITCODE-ne0){throw 'Backup archive check failed.'}
  Move-Item -LiteralPath $partial -Destination $file;Write-Host "Private backup: $file"
  if((Read-Host 'Type INSTALL 051')-cne'INSTALL 051'){throw 'Operator cancelled before database mutation.'}
  & "$orlBin\psql.exe" -X --dbname=$orlConnection --password -v ON_ERROR_STOP=1 -f $orlSql
  if($LASTEXITCODE-ne0){throw 'Migration result uncertain. Inspect state before retrying.'}
  $post="begin read only;select (select position('where description is distinct from' in prosrc)>0 and position('where details is distinct from' in prosrc)>0 and position('where remark is distinct from' in prosrc)>0 and position('where note is distinct from' in prosrc)>0 from pg_proc where oid='public.orl_ic_c6_cutover(uuid,text,uuid,uuid)'::regprocedure) and not exists(select 1 from orl_private.c6_cutover_receipt);rollback;"
  $result=$post|& "$orlBin\psql.exe" -X --dbname=$orlConnection --password -v ON_ERROR_STOP=1 -At
  if($LASTEXITCODE-ne0-or($result|Where-Object{$_-eq't'}).Count-ne1){throw '051 postcheck uncertain. Do not start cutover.'}
  Write-Host 'SUCCESS: repair 051 installed. No patient values were changed. Run a fresh C6 verification next.' -ForegroundColor Green
}catch{Write-Host $_.Exception.Message -ForegroundColor Red;Write-Host 'Keep the backup private. Do not retry an uncertain installation blindly.';exit 1}
