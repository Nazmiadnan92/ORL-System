$ErrorActionPreference='Stop';$bin='C:\Program Files\PostgreSQL\18\bin';$passwordPtr=[IntPtr]::Zero;$plainPassword=$null
$ca=Join-Path $PSScriptRoot '..\..\..\ic-encryption-package-b\certs\supabase-prod-ca-2021.crt';$caParam=$ca.Replace('\','/').Replace("'","\'")
$connection="host=aws-0-ap-southeast-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.imrfmilqehcrvassuvuw sslmode=verify-full sslrootcert='$caParam' connect_timeout=20"
$folder=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ORL-Private-Backups';$stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
$backup=Join-Path $folder "ORL-before-C2-placeholder-$stamp.dump";$partial="$backup.partial"
. (Join-Path $PSScriptRoot 'Test-OrlReviewedCa.ps1')
try{
  Test-OrlReviewedCa -Path $ca -ExpectedDerSha256 '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'
  $securePassword=Read-Host 'Paste DATABASE password using Ctrl+V, then press Enter (input is hidden)' -AsSecureString
  $passwordPtr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword);$plainPassword=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPtr)
  if([string]::IsNullOrEmpty($plainPassword)){throw 'Database password is required.'};$env:PGPASSWORD=$plainPassword
  $pre=@"
begin read only;
select count(*)=1 from public.orl_requests r left join orl_private.request_identity i on i.request_id=r.id
where i.request_id is null and character_length(r.patient_ic)=1 and r.patient_ic~'^[ -~]`$'
  and r.patient_ic!~'[A-Za-z0-9]' and trim(r.patient_ic)<>'';
rollback;
"@
  $ready=$pre|& "$bin\psql.exe" -X --dbname=$connection --no-password -v ON_ERROR_STOP=1 -At
  if($LASTEXITCODE-ne 0 -or ($ready|Where-Object{$_-eq't'}).Count-ne 1){throw 'Expected exactly one safe one-character placeholder. Nothing changed.'}
  New-Item -ItemType Directory -Force -Path $folder|Out-Null
  Write-Host 'Creating and checking a fresh full private backup. Restore is not run.' -ForegroundColor Yellow
  & "$bin\pg_dump.exe" --dbname=$connection --format=custom --file=$partial --no-password
  if($LASTEXITCODE-ne 0){throw 'Backup failed. Placeholder was not changed.'}
  & "$bin\pg_restore.exe" --list $partial|Out-Null
  if($LASTEXITCODE-ne 0){throw 'Backup archive check failed. Placeholder was not changed.'}
  Move-Item -LiteralPath $partial -Destination $backup;Write-Host "Private backup: $backup"
  if((Read-Host 'Type CLEAR PLACEHOLDER to continue')-cne'CLEAR PLACEHOLDER'){throw 'Operator cancelled before data correction.'}
  $fix=@"
begin;
set local lock_timeout='5s';
lock table public.orl_requests,orl_private.request_identity in share row exclusive mode;
do `$`$
declare target_id uuid; targets integer;
begin
 select count(*) into targets
 from public.orl_requests r left join orl_private.request_identity i on i.request_id=r.id
 where i.request_id is null and character_length(r.patient_ic)=1 and r.patient_ic~'^[ -~]`$'
   and r.patient_ic!~'[A-Za-z0-9]' and trim(r.patient_ic)<>'';
 if targets<>1 then raise exception 'Placeholder snapshot changed. Nothing corrected'; end if;
 select r.id into target_id from public.orl_requests r left join orl_private.request_identity i on i.request_id=r.id
 where i.request_id is null and character_length(r.patient_ic)=1 and r.patient_ic~'^[ -~]`$'
   and r.patient_ic!~'[A-Za-z0-9]' and trim(r.patient_ic)<>'';
 update public.orl_requests set patient_ic='',updated_at=clock_timestamp() where id=target_id;
 insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
 values(null,'SYSTEM MAINTENANCE','DATABASE_OWNER','IC_PLACEHOLDER_CLEARED','REQUEST',target_id::text,
   'One-character punctuation placeholder cleared to optional blank before Package C2; no identifier value logged.');
end `$`$;
commit;
"@
  $fix|& "$bin\psql.exe" -X --dbname=$connection --no-password -v ON_ERROR_STOP=1
  if($LASTEXITCODE-ne 0){throw 'Correction failed or is uncertain. Inspect state before retrying.'}
  $post="begin read only; select count(*)=0 from public.orl_requests r left join orl_private.request_identity i on i.request_id=r.id where i.request_id is null and trim(coalesce(r.patient_ic,''))<>'' and not orl_private.c2_supported(r.patient_ic); rollback;"
  $result=$post|& "$bin\psql.exe" -X --dbname=$connection --no-password -v ON_ERROR_STOP=1 -At
  if($LASTEXITCODE-ne 0 -or ($result|Where-Object{$_-eq't'}).Count-ne 1){throw 'Correction committed but C2 blocker status is uncertain. Stop before C2.'}
  Write-Host 'SUCCESS: one invalid placeholder cleared to optional blank; C2 unsupported count is now zero.' -ForegroundColor Green
}catch{Write-Host $_.Exception.Message -ForegroundColor Red;Write-Host 'Do not repeat after an uncertain result until state is checked.';exit 1}
finally{$env:PGPASSWORD=$null;$plainPassword=$null;if($passwordPtr -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPtr)}}
