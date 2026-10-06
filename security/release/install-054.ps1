#Requires -Version 7.4
$ErrorActionPreference='Stop'
$bin='C:\Program Files\PostgreSQL\18\bin'
$sql=Join-Path $PSScriptRoot '..\..\supabase\054_session_helper_private.sql'
$auditFile=Join-Path $PSScriptRoot 'audit-session-helper.sql'
$ca=Join-Path $PSScriptRoot '..\..\..\ic-encryption-package-b\certs\supabase-prod-ca-2021.crt'
$folder=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ORL-Private-Backups'
$oldPassword=$env:PGPASSWORD;$password=$null
function Test-ReviewedFiles {
  if((Get-FileHash -LiteralPath $sql -Algorithm SHA256).Hash-cne'FD073825C90032D331100EDE2ECEFA2797251465941F96A7AA29A00ED1E65433'){throw 'Reviewed migration changed.'}
  if((Get-FileHash -LiteralPath $auditFile -Algorithm SHA256).Hash-cne'216BEEF4558E9272C865321F6836FBE96ABA5FF20B1F9FE7BED12190F47C021C'){throw 'Reviewed audit changed.'}
}
try{
  Test-ReviewedFiles
  . (Join-Path $PSScriptRoot 'Test-OrlReviewedCa.ps1')
  Test-OrlReviewedCa -Path $ca -ExpectedDerSha256 '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'
  $cap=$ca.Replace('\','/').Replace("'","\'")
  $conn="host=aws-0-ap-southeast-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.imrfmilqehcrvassuvuw sslmode=verify-full sslrootcert='$cap' connect_timeout=20"
  Write-Host 'FIX 1 / 054: private full backup, then close direct API access to the internal session helper.' -ForegroundColor Yellow
  Write-Host 'No patient, password, session or encryption values will be changed. No website or Edge deployment required.'
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
 'helper',to_regprocedure('public.orl_require_session(uuid)') is not null);
rollback;
'@
  $lines=$check|& "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -At
  if($LASTEXITCODE-ne0){throw 'Read-only preflight failed. Nothing installed.'}
  $status=($lines|Where-Object{$_-match'^\{'}|Select-Object -Last 1)|ConvertFrom-Json
  if($status.ready-ne$true-or$status.complete-ne$true-or$status.plaintext-ne0-or$status.mismatch-ne0-or$status.helper-ne$true){throw 'Production baseline not confirmed. Nothing installed.'}
  New-Item -ItemType Directory -Force -Path $folder|Out-Null
  $stamp=Get-Date -Format 'yyyyMMdd-HHmmss';$file=Join-Path $folder "ORL-before-054-$stamp.dump";$partial="$file.partial"
  Write-Host 'Creating fresh full private backup...'
  & "$bin\pg_dump.exe" --dbname=$conn --format=custom --file=$partial --no-password
  if($LASTEXITCODE-ne0){throw 'Backup failed. Nothing installed.'}
  & "$bin\pg_restore.exe" --list $partial|Out-Null
  if($LASTEXITCODE-ne0){throw 'Backup archive check failed. Nothing installed.'}
  Move-Item -LiteralPath $partial -Destination $file
  if((Read-Host 'Type INSTALL 054')-cne'INSTALL 054'){throw 'Cancelled before installation.'}
  Test-ReviewedFiles
  & "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -f $sql
  if($LASTEXITCODE-ne0){throw 'Installation not confirmed. Inspect status before retrying.'}
  $lines=& "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -At -f $auditFile
  if($LASTEXITCODE-ne0){throw 'Post-install audit failed.'}
  $audit=($lines|Where-Object{$_-match'^\{'}|Select-Object -Last 1)|ConvertFrom-Json
  if($null-eq$audit-or@($audit.PSObject.Properties).Count-ne6){throw 'Post-install audit was incomplete.'}
  foreach($p in $audit.PSObject.Properties){if($p.Value-ne$true){throw "Post-install check failed: $($p.Name)"}}
  [ordered]@{format='ORL-054-SANITIZED-REPORT';completed_at=(Get-Date).ToUniversalTime().ToString('o');backup_file=[IO.Path]::GetFileName($file);backup_sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash;migration_sha256=(Get-FileHash -LiteralPath $sql -Algorithm SHA256).Hash;audit=$audit}|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $folder "ORL-054-report-$stamp.json") -Encoding utf8NoBOM
  Write-Host 'SUCCESS: 054 installed. Direct helper access closed; login API and internal callers preserved.' -ForegroundColor Green
  Write-Host 'Tell GPT SUCCESS for the final public API check. Keep the backup private.'
}catch{
  Write-Host ('STOP: '+$_.Exception.Message) -ForegroundColor Red
  Write-Host 'No production restore was run. Keep backups private; do not retry an uncertain installation blindly.'
  exit 1
}finally{$env:PGPASSWORD=$oldPassword;$password=$null}
