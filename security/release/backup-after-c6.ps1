$ErrorActionPreference='Stop';$bin='C:\Program Files\PostgreSQL\18\bin';$ca=Join-Path $PSScriptRoot '..\..\..\ic-encryption-package-b\certs\supabase-prod-ca-2021.crt';$cap=$ca.Replace('\','/').Replace("'","\'")
$conn="host=aws-0-ap-southeast-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.imrfmilqehcrvassuvuw sslmode=verify-full sslrootcert='$cap' connect_timeout=20"
$folder=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ORL-Private-Backups';$stamp=Get-Date -Format 'yyyyMMdd-HHmmss';$file=Join-Path $folder "ORL-after-C6-$stamp.dump";$partial="$file.partial"
. (Join-Path $PSScriptRoot 'Test-OrlReviewedCa.ps1')
try{
  Test-OrlReviewedCa -Path $ca -ExpectedDerSha256 '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'
  $check="begin read only;select exists(select 1 from orl_private.c6_cutover_receipt) and (orl_private.c6_stats()->>'plaintext_rows')::integer=0 and (orl_private.c6_stats()->>'identity_mismatch')::integer=0;rollback;"
  Write-Host 'C6 STEP 4/4: read-only completion check and fresh private backup.' -ForegroundColor Yellow
  $result=$check|& "$bin\psql.exe" -X --dbname=$conn --password -v ON_ERROR_STOP=1 -At
  if($LASTEXITCODE-ne0-or($result|Where-Object{$_-eq't'}).Count-ne1){throw 'C6 completion check failed. Backup not started.'}
  New-Item -ItemType Directory -Force -Path $folder|Out-Null;& "$bin\pg_dump.exe" --dbname=$conn --format=custom --file=$partial --password
  if($LASTEXITCODE-ne0){throw 'Post-C6 backup failed.'};& "$bin\pg_restore.exe" --list $partial|Out-Null;if($LASTEXITCODE-ne0){throw 'Archive check failed.'}
  Move-Item -LiteralPath $partial -Destination $file;Write-Host "SUCCESS: verified post-C6 private backup saved: $file" -ForegroundColor Green
}catch{Write-Host $_.Exception.Message -ForegroundColor Red;Write-Host 'Keep any .partial file private.';exit 1}
