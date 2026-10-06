#Requires -Version 7.4
$ErrorActionPreference='Stop'
$bin='C:\Program Files\PostgreSQL\18\bin'
$sql=Join-Path $PSScriptRoot '..\..\supabase\056_webmaster_maintenance.sql'
$auditFile=Join-Path $PSScriptRoot 'audit-maintenance.sql'
$ca=Join-Path $PSScriptRoot '..\..\..\ic-encryption-package-b\certs\supabase-prod-ca-2021.crt'
$folder=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ORL-Private-Backups'
$oldPassword=$env:PGPASSWORD;$password=$null
function Test-ReviewedFiles {
  if((Get-FileHash -LiteralPath $sql -Algorithm SHA256).Hash-cne'28617ECFA70A40D7FBEF419FEAEF7A39B0FBDA6F48FD50D5BFB7303CBAFDC72B'){throw 'Reviewed migration changed.'}
  if((Get-FileHash -LiteralPath $auditFile -Algorithm SHA256).Hash-cne'341673E4837DBDAE5C0D5D2B621BF4477D9BF2821E752A5CC02DE3C69DA2B109'){throw 'Reviewed audit changed.'}
}
try{
  Test-ReviewedFiles
  . (Join-Path $PSScriptRoot 'Test-OrlReviewedCa.ps1')
  Test-OrlReviewedCa -Path $ca -ExpectedDerSha256 '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'
  $cap=$ca.Replace('\','/').Replace("'","\'")
  $conn="host=aws-0-ap-southeast-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.imrfmilqehcrvassuvuw sslmode=verify-full sslrootcert='$cap' connect_timeout=20"
  Write-Host 'MAINTENANCE / 056: private full backup, then install server maintenance controls (OFF).' -ForegroundColor Yellow
  Write-Host 'No patient or encryption values will change. Maintenance remains OFF. Website publication follows verification.'
  $secure=Read-Host 'Paste DATABASE password (hidden; NOT website password)' -AsSecureString
  try{$password=[Net.NetworkCredential]::new('',$secure).Password}finally{$secure.Dispose()}
  if([string]::IsNullOrEmpty($password)){throw 'Database password was empty.'}
  $env:PGPASSWORD=$password
  $check=@'
begin read only;
select jsonb_build_object('ready',orl_private.c1_recovery_ready(),
 'complete',(orl_private.c6_stats()->>'cutover_complete')::boolean,
 'plaintext',(orl_private.c6_stats()->>'plaintext_rows')::integer,
 'mismatch',(orl_private.c6_stats()->>'identity_mismatch')::integer,
 'baseline',(select md5(replace(prosrc,chr(13),''))='e7412ffba464e9c480f461a2839a35ec'
   from pg_proc where oid=to_regprocedure('public.orl_require_session(uuid)')),
 'not_installed',to_regclass('orl_private.site_maintenance') is null,
 'closed',not exists(select 1 from unnest(array['anon','authenticated','service_role']) r
   where has_function_privilege(r,'public.orl_require_session(uuid)','EXECUTE')
      or has_function_privilege(r,'orl_private.c1_mask_json(jsonb,date)','EXECUTE')));
rollback;
'@
  $lines=$check|& "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -At
  if($LASTEXITCODE-ne0){throw 'Read-only preflight failed. Nothing installed.'}
  $status=($lines|Where-Object{$_-match'^\{'}|Select-Object -Last 1)|ConvertFrom-Json
  if($status.ready-ne$true-or$status.complete-ne$true-or$status.plaintext-ne0-or$status.mismatch-ne0-or$status.baseline-ne$true-or$status.closed-ne$true-or$status.not_installed-ne$true){throw 'Production baseline not confirmed. Nothing installed.'}
  New-Item -ItemType Directory -Force -Path $folder|Out-Null
  $stamp=Get-Date -Format 'yyyyMMdd-HHmmss';$file=Join-Path $folder "ORL-before-056-$stamp.dump";$partial="$file.partial"
  Write-Host 'Creating fresh full private backup...'
  & "$bin\pg_dump.exe" --dbname=$conn --format=custom --file=$partial --no-password
  if($LASTEXITCODE-ne0){throw 'Backup failed. Nothing installed.'}
  & "$bin\pg_restore.exe" --list $partial|Out-Null
  if($LASTEXITCODE-ne0){throw 'Backup archive check failed. Nothing installed.'}
  Move-Item -LiteralPath $partial -Destination $file
  if((Read-Host 'Type INSTALL 056')-cne'INSTALL 056'){throw 'Cancelled before installation.'}
  Test-ReviewedFiles
  & "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -f $sql
  if($LASTEXITCODE-ne0){throw 'Installation not confirmed. Inspect status before retrying.'}
  $lines=& "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -At -f $auditFile
  if($LASTEXITCODE-ne0){throw 'Post-install audit failed.'}
  $audit=($lines|Where-Object{$_-match'^\{'}|Select-Object -Last 1)|ConvertFrom-Json
  if($null-eq$audit-or@($audit.PSObject.Properties).Count-ne6){throw 'Post-install audit was incomplete.'}
  foreach($p in $audit.PSObject.Properties){if($p.Value-ne$true){throw "Post-install check failed: $($p.Name)"}}
  [ordered]@{format='ORL-056-SANITIZED-REPORT';completed_at=(Get-Date).ToUniversalTime().ToString('o');backup_file=[IO.Path]::GetFileName($file);backup_sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash;migration_sha256=(Get-FileHash -LiteralPath $sql -Algorithm SHA256).Hash;audit=$audit}|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $folder "ORL-056-report-$stamp.json") -Encoding utf8NoBOM
  Write-Host 'SUCCESS: 056 installed and audited. Maintenance is OFF. Existing access and IC protection preserved.' -ForegroundColor Green
  Write-Host 'Tell GPT SUCCESS so the maintenance website controls can be published. Keep the backup private.'
}catch{
  Write-Host ('STOP: '+$_.Exception.Message) -ForegroundColor Red
  Write-Host 'No production restore was run. Keep backups private; do not retry an uncertain installation blindly.'
  exit 1
}finally{$env:PGPASSWORD=$oldPassword;$password=$null}
