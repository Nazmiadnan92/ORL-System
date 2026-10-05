#Requires -Version 7.4
$ErrorActionPreference='Stop'
$bin='C:\Program Files\PostgreSQL\18\bin'
$sql=Join-Path $PSScriptRoot '..\..\supabase\052_ic_c7_age_and_recovery.sql'
$ca=Join-Path $PSScriptRoot '..\..\..\ic-encryption-package-b\certs\supabase-prod-ca-2021.crt'
$folder=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ORL-Private-Backups'
$oldPassword=$env:PGPASSWORD;$password=$null
try{
  if((Get-FileHash -LiteralPath $sql -Algorithm SHA256).Hash-cne'A61CA95697334D6EDCB9B71C086FC0A2E6850FB84A97F0E983AAB37DEA2684DB'){throw 'Reviewed migration changed.'}
  . (Join-Path $PSScriptRoot 'Test-OrlReviewedCa.ps1')
  Test-OrlReviewedCa -Path $ca -ExpectedDerSha256 '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'
  $cap=$ca.Replace('\','/').Replace("'","\'")
  $conn="host=aws-0-ap-southeast-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.imrfmilqehcrvassuvuw sslmode=verify-full sslrootcert='$cap' connect_timeout=20"
  Write-Host 'C7 / 052: backup first, then repair function definitions. No production Restore or patient deletion.' -ForegroundColor Yellow
  $secure=Read-Host 'Paste DATABASE password (hidden)' -AsSecureString
  try{$password=[Net.NetworkCredential]::new('',$secure).Password}finally{$secure.Dispose()}
  if([string]::IsNullOrEmpty($password)){throw 'Database password was empty.'}
  $env:PGPASSWORD=$password
  $check=@'
begin read only;
select jsonb_build_object('complete',(orl_private.c6_stats()->>'cutover_complete')::boolean,
 'plaintext',(orl_private.c6_stats()->>'plaintext_rows')::integer,
 'mismatch',(orl_private.c6_stats()->>'identity_mismatch')::integer,
 'ready',orl_private.c1_recovery_ready());
rollback;
'@
  $lines=$check|& "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -At
  if($LASTEXITCODE-ne0){throw 'Read-only preflight failed.'}
  $status=($lines|Where-Object{$_-match'^\{'}|Select-Object -Last 1)|ConvertFrom-Json
  if($status.complete-ne$true-or$status.plaintext-ne0-or$status.mismatch-ne0-or$status.ready-ne$true){throw 'C6 completion/readiness not confirmed.'}
  New-Item -ItemType Directory -Force -Path $folder|Out-Null
  $stamp=Get-Date -Format 'yyyyMMdd-HHmmss';$file=Join-Path $folder "ORL-before-052-$stamp.dump";$partial="$file.partial"
  Write-Host 'Creating fresh full private backup...'
  & "$bin\pg_dump.exe" --dbname=$conn --format=custom --file=$partial --no-password
  if($LASTEXITCODE-ne0){throw 'Backup failed. Nothing installed.'}
  & "$bin\pg_restore.exe" --list $partial|Out-Null
  if($LASTEXITCODE-ne0){throw 'Backup archive check failed.'}
  Move-Item -LiteralPath $partial -Destination $file
  if((Read-Host 'Type INSTALL 052')-cne'INSTALL 052'){throw 'Cancelled before installation.'}
  & "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -f $sql
  if($LASTEXITCODE-ne0){throw 'Installation not confirmed. Inspect before retrying.'}
  $lines=& "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -At -f (Join-Path $PSScriptRoot 'audit-c7.sql')
  if($LASTEXITCODE-ne0){throw 'Post-install audit failed.'}
  $audit=($lines|Where-Object{$_-match'^\{'}|Select-Object -Last 1)|ConvertFrom-Json
  if($null-eq$audit -or @($audit.PSObject.Properties).Count-ne12){throw 'Post-install audit result was incomplete.'}
  foreach($p in $audit.PSObject.Properties){
    $expected=if($p.Name-in@('plaintext_rows','identity_mismatch')){0}else{$true}
    if($p.Value-ne$expected){throw "Post-install audit failed: $($p.Name)"}
  }
  [ordered]@{format='ORL-052-SANITIZED-REPORT';completed_at=(Get-Date).ToUniversalTime().ToString('o');backup_file=[IO.Path]::GetFileName($file);audit=$audit}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $folder "ORL-052-report-$stamp.json") -Encoding utf8NoBOM
  Write-Host 'SUCCESS: 052 installed and C7 database access checks passed. Recovery verification is next.' -ForegroundColor Green
}catch{
  Write-Host ('STOP: '+$_.Exception.Message) -ForegroundColor Red
  Write-Host 'Keep backups private. Do not rerun an uncertain installation.'
  exit 1
}finally{$env:PGPASSWORD=$oldPassword;$password=$null}
