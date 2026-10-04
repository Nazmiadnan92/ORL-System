$ErrorActionPreference='Stop'
$orlBin='C:\Program Files\PostgreSQL\18\bin'
$orlCa=Join-Path $PSScriptRoot '..\..\..\ic-encryption-package-b\certs\supabase-prod-ca-2021.crt'
$orlCaParameter=$orlCa.Replace('\','/').Replace("'","\'")
$orlConnection="host=aws-0-ap-southeast-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.imrfmilqehcrvassuvuw sslmode=verify-full sslrootcert='$orlCaParameter' connect_timeout=20"
$orlExpectedCa='807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'
. (Join-Path $PSScriptRoot 'Test-OrlReviewedCa.ps1')
try {
  Test-OrlReviewedCa -Path $orlCa -ExpectedDerSha256 $orlExpectedCa
  Write-Host 'READ-ONLY: checking migration 047. Password entry is private.' -ForegroundColor Yellow
  $orlResult=& "$orlBin\psql.exe" -X --dbname=$orlConnection --password -v ON_ERROR_STOP=1 -Atc "begin read only;select orl_private.c1_mask_ic('010203-04-5678')='010203-**-****' and orl_private.c1_redact_text('IC 010203045678.')='IC 010203-**-****.';rollback;"
  if($LASTEXITCODE-ne 0 -or ($orlResult|Where-Object{$_ -eq 't'}).Count-ne 1){throw 'Migration 047 is not confirmed.'}
  Write-Host 'SUCCESS: migration 047 is active.' -ForegroundColor Green
} catch { Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }
