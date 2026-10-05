#Requires -Version 7.4
$ErrorActionPreference='Stop'
$bin='C:\Program Files\PostgreSQL\18\bin'
$sql=Join-Path $PSScriptRoot '..\..\supabase\053_ot_list_full_ic_export.sql'
$ca=Join-Path $PSScriptRoot '..\..\..\ic-encryption-package-b\certs\supabase-prod-ca-2021.crt'
$folder=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ORL-Private-Backups'
$oldPassword=$env:PGPASSWORD;$password=$null
try{
  if((Get-FileHash -LiteralPath $sql -Algorithm SHA256).Hash-cne'186E3923C3E03F80704CC4B08A5481A9C070D4BEE2611064E371543407929C19'){throw 'Reviewed migration changed.'}
  if((Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'audit-ot-export.sql') -Algorithm SHA256).Hash-cne'D5E2B32F07D648DB071A8FE99DAD2CB14CDAD2AC26807E536CB2E76EB7467A53'){throw 'Reviewed audit changed.'}
  . (Join-Path $PSScriptRoot 'Test-OrlReviewedCa.ps1')
  Test-OrlReviewedCa -Path $ca -ExpectedDerSha256 '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'
  $cap=$ca.Replace('\','/').Replace("'","\'")
  $conn="host=aws-0-ap-southeast-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.imrfmilqehcrvassuvuw sslmode=verify-full sslrootcert='$cap' connect_timeout=20"
  Write-Host 'OT EXPORT / 053: backup first, then add Admin/Webmaster-only audited export. No patient values are changed.' -ForegroundColor Yellow
  $secure=Read-Host 'Paste DATABASE password (hidden)' -AsSecureString
  try{$password=[Net.NetworkCredential]::new('',$secure).Password}finally{$secure.Dispose()}
  if([string]::IsNullOrEmpty($password)){throw 'Database password was empty.'}
  $env:PGPASSWORD=$password
  $check=@'
begin read only;
select jsonb_build_object('complete',(orl_private.c6_stats()->>'cutover_complete')::boolean,
 'plaintext',(orl_private.c6_stats()->>'plaintext_rows')::integer,
 'mismatch',(orl_private.c6_stats()->>'identity_mismatch')::integer,
 'ready',orl_private.c1_recovery_ready(),'installed',to_regclass('orl_private.ot_export_lease') is not null);
rollback;
'@
  $lines=$check|& "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -At
  if($LASTEXITCODE-ne0){throw 'Read-only preflight failed.'}
  $status=($lines|Where-Object{$_-match'^\{'}|Select-Object -Last 1)|ConvertFrom-Json
  if($status.complete-ne$true-or$status.plaintext-ne0-or$status.mismatch-ne0-or$status.ready-ne$true){throw 'C6 completion/readiness not confirmed.'}
  if($status.installed-ne$false){throw '053 is already installed. Inspect its report before any repeat.'}
  New-Item -ItemType Directory -Force -Path $folder|Out-Null
  $stamp=Get-Date -Format 'yyyyMMdd-HHmmss';$file=Join-Path $folder "ORL-before-053-$stamp.dump";$partial="$file.partial"
  Write-Host 'Creating fresh full private backup...'
  & "$bin\pg_dump.exe" --dbname=$conn --format=custom --file=$partial --no-password
  if($LASTEXITCODE-ne0){throw 'Backup failed. Nothing installed.'}
  & "$bin\pg_restore.exe" --list $partial|Out-Null
  if($LASTEXITCODE-ne0){throw 'Backup archive check failed.'}
  Move-Item -LiteralPath $partial -Destination $file
  if((Read-Host 'Type INSTALL 053')-cne'INSTALL 053'){throw 'Cancelled before installation.'}
  & "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -f $sql
  if($LASTEXITCODE-ne0){throw 'Installation not confirmed. Inspect before retrying.'}
  $lines=& "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -At -f (Join-Path $PSScriptRoot 'audit-ot-export.sql')
  if($LASTEXITCODE-ne0){throw 'Post-install audit failed.'}
  $audit=($lines|Where-Object{$_-match'^\{'}|Select-Object -Last 1)|ConvertFrom-Json
  if($null-eq$audit -or @($audit.PSObject.Properties).Count-ne9){throw 'Post-install audit result was incomplete.'}
  foreach($p in $audit.PSObject.Properties){
    $expected=if($p.Name-in@('plaintext_rows','identity_mismatch')){0}else{$true}
    if($p.Value-ne$expected){throw "Post-install audit failed: $($p.Name)"}
  }
  [ordered]@{format='ORL-053-SANITIZED-REPORT';completed_at=(Get-Date).ToUniversalTime().ToString('o');backup_file=[IO.Path]::GetFileName($file);backup_sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash;migration_sha256=(Get-FileHash -LiteralPath $sql -Algorithm SHA256).Hash;audit=$audit}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $folder "ORL-053-report-$stamp.json") -Encoding utf8NoBOM
  Write-Host 'SUCCESS: 053 installed. Private access checks passed; Edge and website publication are next.' -ForegroundColor Green
}catch{
  Write-Host ('STOP: '+$_.Exception.Message) -ForegroundColor Red
  Write-Host 'Keep backups private. Do not rerun an uncertain installation.'
  exit 1
}finally{$env:PGPASSWORD=$oldPassword;$password=$null}
