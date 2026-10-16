#Requires -Version 7.4
# Reviewed installer only. No backup, dump, Restore, tag, Edge deployment or website publication is performed.
$ErrorActionPreference='Stop'
$bin='C:\Program Files\PostgreSQL\18\bin'
$migration=Join-Path $PSScriptRoot '..\..\supabase\064_ot_hold_completion.sql'
$auditFile=Join-Path $PSScriptRoot 'audit-ot-lifecycle.sql'
$ca=Join-Path $PSScriptRoot '..\..\..\ic-encryption-package-b\certs\supabase-prod-ca-2021.crt'
$reportFolder=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ORL-Release-Reports'
$oldPassword=$env:PGPASSWORD;$password=$null
function Get-ReviewedHash([string]$Path) {
 $stream=[IO.File]::OpenRead($Path);$sha=[Security.Cryptography.SHA256]::Create()
 try{return [Convert]::ToHexString($sha.ComputeHash($stream))}finally{$stream.Dispose();$sha.Dispose()}
}
function Test-ReviewedFiles {
 if((Get-ReviewedHash $migration)-cne'C5FFACD1E20285929CCCD9520D871FF6B12361070472E0B569872F3FC78CA106'){throw 'Reviewed migration 064 changed.'}
 if((Get-ReviewedHash $auditFile)-cne'9C1544ECB808D9A9B66E8A2E650FB2513C7DE28CA7E0D1E81B2A804387F1AAAA'){throw 'Reviewed lifecycle audit changed.'}
}
function Get-ValidatedAudit {
 $auditLines=& "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -At -f $auditFile
 if($LASTEXITCODE-ne0){throw 'Lifecycle audit failed. Inspect status before continuing.'}
 $result=($auditLines|Where-Object{$_-match'^\{'}|Select-Object -Last 1)|ConvertFrom-Json
 if($null-eq$result-or@($result.PSObject.Properties).Count-ne12){throw 'Lifecycle audit was incomplete.'}
 foreach($property in $result.PSObject.Properties){if($property.Value-ne$true){throw "Lifecycle audit failed: $($property.Name). Inspect status; do not repeat blindly."}}
 return $result
}
try {
 Test-ReviewedFiles
 . (Join-Path $PSScriptRoot 'Test-OrlReviewedCa.ps1')
 Test-OrlReviewedCa -Path $ca -ExpectedDerSha256 '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'
 $cap=$ca.Replace('\','/').Replace("'","\'")
 $conn="host=aws-0-ap-southeast-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.imrfmilqehcrvassuvuw sslmode=verify-full sslrootcert='$cap' connect_timeout=20"
 Write-Host 'OT HOLD + MARK AS DONE / 064: reviewed database migration.' -ForegroundColor Yellow
 Write-Host 'Installation adds the new actions. Existing patients are not placed on hold or marked done.'
 Write-Host 'No new backup or restore point will be created, as requested. Edge and website release are separate steps.'
 $secure=Read-Host 'Paste DATABASE password (hidden; NOT website password)' -AsSecureString
 try{$password=[Net.NetworkCredential]::new('',$secure).Password}finally{$secure.Dispose()}
 if([string]::IsNullOrEmpty($password)){throw 'Database password was empty.'}
 $env:PGPASSWORD=$password
 $inspection=@'
begin read only;
set local statement_timeout='30s';
select jsonb_build_object(
 'has_column',exists(select 1 from information_schema.columns where table_schema='public' and table_name='orl_requests' and column_name='ot_hold'),
 'has_action',to_regprocedure('public.orl_ic_ot_lifecycle(uuid,uuid,uuid,text,text,uuid,timestamptz)') is not null,
 'has_read',to_regprocedure('public.orl_get_ot_hold_requests(uuid)') is not null
);
rollback;
'@
 $lines=$inspection|& "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -At
 if($LASTEXITCODE-ne0){throw 'Read-only installation check failed. Nothing installed.'}
 $state=($lines|Where-Object{$_-match'^\{'}|Select-Object -Last 1)|ConvertFrom-Json
 if($null-eq$state-or@($state.PSObject.Properties).Count-ne3){throw 'Installation check was incomplete.'}
 $alreadyInstalled=$state.has_column-eq$true-and$state.has_action-eq$true-and$state.has_read-eq$true
 if($alreadyInstalled){
  $audit=Get-ValidatedAudit
  $resultMessage='064 is already installed and its reviewed audit passed. No migration was repeated.'
 }else{
  if($state.has_column-ne$false-or$state.has_action-ne$false-or$state.has_read-ne$false){throw 'Partial or unexpected lifecycle state found. Nothing installed; inspect safely.'}
  # Reuse the exact reviewed metadata-only baseline block; no clinical SQL runs here.
  $migrationText=[IO.File]::ReadAllText($migration)
  $baselineMatches=[regex]::Matches($migrationText,'(?s)do \$baseline\$.*?end \$baseline\$;')
  if($baselineMatches.Count-ne1){throw 'Reviewed baseline block is missing or ambiguous.'}
  $preflight="begin read only;`nset local statement_timeout='30s';`n"+$baselineMatches[0].Value+"`nselect 'BASELINE_064_OK';`nrollback;"
  $lines=$preflight|& "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -At
  if($LASTEXITCODE-ne0-or-not($lines-contains'BASELINE_064_OK')){throw 'Read-only baseline check failed. Nothing installed.'}
  if((Read-Host 'Type INSTALL 064')-cne'INSTALL 064'){throw 'Cancelled before installation.'}
  Test-ReviewedFiles
  & "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -f $migration
  if($LASTEXITCODE-ne0){throw 'Installation failed or result is uncertain. Run the read-only status check before deciding whether to retry.'}
  $audit=Get-ValidatedAudit
  $resultMessage='SUCCESS: 064 installed and its reviewed audit passed.'
 }
 New-Item -ItemType Directory -Force -Path $reportFolder|Out-Null
 $stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
 [ordered]@{format='ORL-064-SANITIZED-REPORT';project_ref='imrfmilqehcrvassuvuw';checked_at=(Get-Date).ToUniversalTime().ToString('o');
  already_installed=$alreadyInstalled;migration064_sha256=(Get-ReviewedHash $migration);audit_sha256=(Get-ReviewedHash $auditFile);audit=$audit
 }|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $reportFolder "ORL-064-report-$stamp.json") -Encoding utf8NoBOM
 Write-Host $resultMessage -ForegroundColor Green
 Write-Host 'Tell GPT the result so the matching protected gateway and website can be released after verification.'
}catch {
 Write-Host ('STOP: '+$_.Exception.Message) -ForegroundColor Red
 Write-Host 'No backup or Restore was run. Do not repeat an uncertain installation blindly.'
 exit 1
}finally{$env:PGPASSWORD=$oldPassword;$password=$null}
