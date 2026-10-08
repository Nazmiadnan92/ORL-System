#Requires -Version 7.4
$ErrorActionPreference='Stop'
$bin='C:\Program Files\PostgreSQL\18\bin'
$migration057=Join-Path $PSScriptRoot '..\..\supabase\057_booking_move_requests.sql'
$migration058=Join-Path $PSScriptRoot '..\..\supabase\058_six_special_slots_2027.sql'
$auditFile=Join-Path $PSScriptRoot 'audit-booking-workflow.sql'
$ca=Join-Path $PSScriptRoot '..\..\..\ic-encryption-package-b\certs\supabase-prod-ca-2021.crt'
$folder=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ORL-Private-Backups'
$oldPassword=$env:PGPASSWORD;$password=$null
function Get-ReviewedHash([string]$Path) {
  $stream=[IO.File]::OpenRead($Path);$sha=[Security.Cryptography.SHA256]::Create()
  try{return [Convert]::ToHexString($sha.ComputeHash($stream))}finally{$stream.Dispose();$sha.Dispose()}
}
function Test-ReviewedFiles {
  if((Get-ReviewedHash $migration057)-cne'7CAEB2A6D637D4CC9979CB336E2D82024B1B8EF1B1BDE53E51C8754C52A4393F'){throw 'Reviewed migration 057 changed.'}
  if((Get-ReviewedHash $migration058)-cne'4D8D0E11E56F99972E755EC8AF6C3796813178D9473EB7742D700D12D6F9AE08'){throw 'Reviewed migration 058 changed.'}
  if((Get-ReviewedHash $auditFile)-cne'3F9C14C60778DD58C1204F5E2F1F1A029363171C8BA61E99984FD9E8BE640275'){throw 'Reviewed booking audit changed.'}
}
function Get-MigrationBody([string]$Path) {
  $body=[IO.File]::ReadAllText($Path)
  # Both reviewed migration bodies share ONE transaction; no partial installation.
  $begin=[regex]::new('(?m)^begin;\r?$');$commit=[regex]::new('(?m)^commit;\r?$')
  if($begin.Matches($body).Count-ne1-or$commit.Matches($body).Count-ne1){throw 'Unexpected migration transaction boundaries.'}
  return $commit.Replace($begin.Replace($body,'-- outer installer transaction'),'-- outer installer commit')
}
try {
  Test-ReviewedFiles
  . (Join-Path $PSScriptRoot 'Test-OrlReviewedCa.ps1')
  Test-OrlReviewedCa -Path $ca -ExpectedDerSha256 '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'
  $cap=$ca.Replace('\','/').Replace("'","\'")
  $conn="host=aws-0-ap-southeast-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.imrfmilqehcrvassuvuw sslmode=verify-full sslrootcert='$cap' connect_timeout=20"
  Write-Host 'BOOKING / 057 + 058: private full backup, then one atomic installation.' -ForegroundColor Yellow
  Write-Host 'Adds move approval and six Special slots from 2027. No patient is moved/deleted. Maintenance setting is unchanged.'
  $secure=Read-Host 'Paste DATABASE password (hidden; NOT website password)' -AsSecureString
  try{$password=[Net.NetworkCredential]::new('',$secure).Password}finally{$secure.Dispose()}
  if([string]::IsNullOrEmpty($password)){throw 'Database password was empty.'}
  $env:PGPASSWORD=$password
  $preflight=@'
begin read only;
select jsonb_build_object(
 'recovery_ready',orl_private.c1_recovery_ready(),
 'cutover_clean',coalesce((orl_private.c6_stats()->>'cutover_complete')::boolean
  and (orl_private.c6_stats()->>'plaintext_rows')::integer=0
  and (orl_private.c6_stats()->>'identity_mismatch')::integer=0,false),
 'not_installed',to_regclass('orl_private.booking_move_requests') is null,
 'maintenance_installed',to_regclass('orl_private.site_maintenance') is not null,
 'session_gate',(select md5(replace(prosrc,chr(13),''))='ba9d29923e7269729c8025bf1e266208' from pg_proc where oid=to_regprocedure('public.orl_require_session(uuid)')),
 'schedule_baseline',(select md5(replace(prosrc,chr(13),'')) in ('a3466ebff4648c78b6f1582beffb7d3c','544c5dfd927bef55e7b53eb56b84c598') from pg_proc where oid=to_regprocedure('orl_private.c1_prepare_schedule(uuid,integer,integer)')),
 'capacity_safe',not exists(select 1 from public.orl_ot_slots sl join public.orl_ot_sessions s on s.id=sl.session_id
  where s.ot_date>=date '2027-01-01' and sl.slot_type='SPECIAL' and sl.slot_number>6),
 'same_date_cases_clean',not exists(select 1 from public.orl_ot_slots sl join public.orl_ot_sessions s on s.id=sl.session_id
  join public.orl_requests r on r.id=sl.request_id where sl.status in('CONFIRMED','RESERVED') and r.status not in('CANCELLED','COMPLETED','REJECTED')
  group by s.ot_date,lower(btrim(r.mrn)),lower(regexp_replace(btrim(r.surgery),'\s+',' ','g')) having count(distinct r.id)>1)
);
rollback;
'@
  $lines=$preflight|& "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -At
  if($LASTEXITCODE-ne0){throw 'Read-only preflight failed. Nothing installed.'}
  $state=($lines|Where-Object{$_-match'^\{'}|Select-Object -Last 1)|ConvertFrom-Json
  if($null-eq$state-or@($state.PSObject.Properties).Count-ne8){throw 'Read-only preflight incomplete.'}
  foreach($p in $state.PSObject.Properties){if($p.Value-ne$true){
    if($p.Name-eq'schedule_baseline'){
      # Fingerprints only: no function body, password, or patient values are shown.
      $diagnostic="begin read only; select md5(replace(prosrc,chr(13),'')) from pg_proc where oid=to_regprocedure('orl_private.c1_prepare_schedule(uuid,integer,integer)'); rollback;"
      $fingerprints=$diagnostic|& "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -qAt
      if($LASTEXITCODE-eq0){foreach($fp in $fingerprints){if($fp-match'^[a-f0-9]{32}$'){Write-Host "Observed schedule fingerprint: $fp"}}}
    }
    throw "Preflight check failed: $($p.Name). Nothing installed; ask GPT to inspect safely."
  }}
  New-Item -ItemType Directory -Force -Path $folder|Out-Null
  $stamp=Get-Date -Format 'yyyyMMdd-HHmmss';$file=Join-Path $folder "ORL-before-057-058-$stamp.dump";$partial="$file.partial"
  Write-Host 'Creating fresh full private backup...'
  & "$bin\pg_dump.exe" --dbname=$conn --format=custom --file=$partial --no-password
  if($LASTEXITCODE-ne0){throw 'Backup failed. Nothing installed.'}
  & "$bin\pg_restore.exe" --list $partial|Out-Null
  if($LASTEXITCODE-ne0){throw 'Backup archive check failed. Nothing installed.'}
  Move-Item -LiteralPath $partial -Destination $file
  if((Read-Host 'Type INSTALL 057 058')-cne'INSTALL 057 058'){throw 'Cancelled before installation.'}
  Test-ReviewedFiles
  $sql=[string]::Join([Environment]::NewLine,@('begin;',(Get-MigrationBody $migration057),(Get-MigrationBody $migration058),'commit;'))
  $sql|& "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1
  if($LASTEXITCODE-ne0){throw 'Installation failed or result uncertain. Both migrations share one transaction. Inspect status before retrying.'}
  $lines=& "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -At -f $auditFile
  if($LASTEXITCODE-ne0){throw 'Post-install audit failed. Do not publish the website yet.'}
  $audit=($lines|Where-Object{$_-match'^\{'}|Select-Object -Last 1)|ConvertFrom-Json
  if($null-eq$audit-or@($audit.PSObject.Properties).Count-ne13){throw 'Post-install audit incomplete.'}
  foreach($p in $audit.PSObject.Properties){if($p.Value-ne$true){throw "Post-install check failed: $($p.Name). Do not publish yet."}}
  [ordered]@{format='ORL-057-058-SANITIZED-REPORT';completed_at=(Get-Date).ToUniversalTime().ToString('o');
    backup_file=[IO.Path]::GetFileName($file);backup_sha256=(Get-ReviewedHash $file);
    migration057_sha256=(Get-ReviewedHash $migration057);migration058_sha256=(Get-ReviewedHash $migration058);audit=$audit
  }|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $folder "ORL-057-058-report-$stamp.json") -Encoding utf8NoBOM
  Write-Host 'SUCCESS: 057 + 058 installed and audited. Existing patients and IC protection retained.' -ForegroundColor Green
  Write-Host 'Tell GPT SUCCESS so the reviewed website changes can be published. Keep backups private.'
}catch {
  Write-Host ('STOP: '+$_.Exception.Message) -ForegroundColor Red
  Write-Host 'No production Restore was run. Keep backups private; do not repeat an uncertain installation blindly.'
  exit 1
}finally{$env:PGPASSWORD=$oldPassword;$password=$null}
