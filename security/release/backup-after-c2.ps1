$ErrorActionPreference='Stop';$orlBin='C:\Program Files\PostgreSQL\18\bin'
$orlCa=Join-Path $PSScriptRoot '..\..\..\ic-encryption-package-b\certs\supabase-prod-ca-2021.crt';$orlCaParameter=$orlCa.Replace('\','/').Replace("'","\'")
$orlConnection="host=aws-0-ap-southeast-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.imrfmilqehcrvassuvuw sslmode=verify-full sslrootcert='$orlCaParameter' connect_timeout=20"
$orlFolder=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ORL-Private-Backups';$stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
$file=Join-Path $orlFolder "ORL-after-C2-$stamp.dump";$partial="$file.partial"
. (Join-Path $PSScriptRoot 'Test-OrlReviewedCa.ps1')
try{
  Test-OrlReviewedCa -Path $orlCa -ExpectedDerSha256 '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'
  New-Item -ItemType Directory -Force -Path $orlFolder|Out-Null
  Write-Host 'Read-only C2 completion check. Database password entry is private.' -ForegroundColor Yellow
  $check="begin read only; select count(*)=1 and max(completed_at) is not null from orl_private.c2_verification_runs where completed_at is not null; rollback;"
  $result=$check|& "$orlBin\psql.exe" -X --dbname=$orlConnection --password -v ON_ERROR_STOP=1 -At
  if($LASTEXITCODE-ne 0 -or ($result|Where-Object{$_-eq't'}).Count-ne 1){throw 'C2 completion is not uniquely confirmed. Backup was not started.'}
  Write-Host 'Creating full private post-C2 archive. Restore is not run.' -ForegroundColor Yellow
  & "$orlBin\pg_dump.exe" --dbname=$orlConnection --format=custom --file=$partial --password
  if($LASTEXITCODE-ne 0){throw 'Post-C2 backup failed.'}
  & "$orlBin\pg_restore.exe" --list $partial|Out-Null
  if($LASTEXITCODE-ne 0){throw 'Post-C2 archive structure check failed.'}
  Move-Item -LiteralPath $partial -Destination $file
  Write-Host "SUCCESS: verified post-C2 private backup saved: $file" -ForegroundColor Green
}catch{Write-Host $_.Exception.Message -ForegroundColor Red;Write-Host 'Keep any .partial file private and do not treat it as a verified backup.';exit 1}
