#Requires -Version 7.4
# Installs reviewed definitions only. It does not correct/add cases, restore production, deploy Edge or publish the website.
$ErrorActionPreference='Stop'
$bin='C:\Program Files\PostgreSQL\18\bin'
$migration=Join-Path $PSScriptRoot '..\..\supabase\065_past_case_correction.sql'
$auditFile=Join-Path $PSScriptRoot 'audit-past-case.sql'
$ca=Join-Path $PSScriptRoot '..\..\..\ic-encryption-package-b\certs\supabase-prod-ca-2021.crt'
$backupFolder=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ORL-Private-Backups'
$reportFolder=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ORL-Release-Reports'
$oldPassword=$env:PGPASSWORD;$password=$null
function Get-ReviewedHash([string]$Path) {
 $stream=[IO.File]::OpenRead($Path);$sha=[Security.Cryptography.SHA256]::Create()
 try{return [Convert]::ToHexString($sha.ComputeHash($stream))}finally{$stream.Dispose();$sha.Dispose()}
}
function Test-ReviewedFiles {
 if((Get-ReviewedHash $migration)-cne'C24722FA7E2455F1A7F3F7F076B683A0B6EAE0D02ADD920D9CB91E271DC9145C'){throw 'Reviewed migration 065 changed.'}
 if((Get-ReviewedHash $auditFile)-cne'58B0EC312C8C1E8BF51E8E787BAE7DC58F7383451EFF666CA822F40B856FC51A'){throw 'Reviewed past-case audit changed.'}
}
function Get-ValidatedAudit {
 Test-ReviewedFiles
 $auditLines=& "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -At -f $auditFile
 if($LASTEXITCODE-ne0){throw 'Past-case audit failed. Inspect status before continuing.'}
 $result=($auditLines|Where-Object{$_-match'^\{'}|Select-Object -Last 1)|ConvertFrom-Json
 $checks=@('reviewed_definitions','service_only_endpoints','private_helpers','ordinary_past_booking_guard','ordinary_move_preserved','lifecycle_preserved','restore_preserved','browser_tables_closed','identity_tables_closed','recovery_ready','masked_read_preserved','ic_storage_preserved')
 if($null-eq$result-or@(Compare-Object ($checks|Sort-Object) (@($result.PSObject.Properties.Name)|Sort-Object)).Count-ne0){throw 'Past-case audit was incomplete.'}
 foreach($name in $checks){if($result.$name-isnot[bool]-or$result.$name-ne$true){throw "Past-case audit failed: $name. Inspect status; do not repeat blindly."}}
 return $result
}
try {
 Test-ReviewedFiles
 . (Join-Path $PSScriptRoot 'Test-OrlReviewedCa.ps1')
 Test-OrlReviewedCa -Path $ca -ExpectedDerSha256 '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'
 $cap=$ca.Replace('\','/').Replace("'","\'")
 $conn="host=aws-0-ap-southeast-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.imrfmilqehcrvassuvuw sslmode=verify-full sslrootcert='$cap' connect_timeout=20"
 Write-Host 'WEBMASTER PAST CASES / 065: private full backup, then reviewed atomic database installation.' -ForegroundColor Yellow
 Write-Host 'Adds protected historical correction and missed-case entry for Webmaster only. No patient is changed by installation.'
 Write-Host 'Past slots stay closed to ordinary requests. No production Restore is run. Edge and website release are separate steps.'
 $secure=Read-Host 'Paste DATABASE password (hidden; NOT website password)' -AsSecureString
 try{$password=[Net.NetworkCredential]::new('',$secure).Password}finally{$secure.Dispose()}
 if([string]::IsNullOrEmpty($password)){throw 'Database password was empty.'}
 $env:PGPASSWORD=$password
 Test-ReviewedFiles
 $inspection=@'
begin read only;
set local statement_timeout='30s';
select jsonb_build_object(
 'has_view',to_regprocedure('public.orl_ic_past_case_view(uuid,uuid)') is not null,
 'has_save',to_regprocedure('public.orl_ic_past_case_save(uuid,text,text,uuid,uuid,jsonb,text,text,jsonb,jsonb,uuid,text,timestamptz)') is not null
);
rollback;
'@
 $lines=$inspection|& "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -At
 if($LASTEXITCODE-ne0){throw 'Read-only installation check failed. Nothing installed.'}
 $state=($lines|Where-Object{$_-match'^\{'}|Select-Object -Last 1)|ConvertFrom-Json
 if($null-eq$state-or@($state.PSObject.Properties).Count-ne2-or$state.has_view-isnot[bool]-or$state.has_save-isnot[bool]){throw 'Installation check was incomplete.'}
 $alreadyInstalled=$state.has_view-eq$true-and$state.has_save-eq$true
 $backupName=$null;$backupHash=$null
 if($alreadyInstalled){
  $audit=Get-ValidatedAudit
  $resultMessage='SUCCESS: 065 is already installed and its reviewed audit passed. No migration or backup was repeated.'
 }else{
  if($state.has_view-ne$false-or$state.has_save-ne$false){throw 'Partial or unexpected past-case state found. Nothing installed; inspect safely.'}
  # Reuse exactly the pinned metadata-only baseline. It must not perform clinical writes.
  $migrationText=[IO.File]::ReadAllText($migration)
  $baselineMatches=[regex]::Matches($migrationText,'(?s)do \$baseline\$.*?end \$baseline\$;')
  if($baselineMatches.Count-ne1){throw 'Reviewed baseline block is missing or ambiguous.'}
  $preflight="begin read only;`nset local statement_timeout='30s';`n"+$baselineMatches[0].Value+"`nselect 'BASELINE_065_OK';`nrollback;"
  $lines=$preflight|& "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -At
  if($LASTEXITCODE-ne0-or-not($lines-contains'BASELINE_065_OK')){throw 'Read-only baseline check failed. Nothing installed.'}
  New-Item -ItemType Directory -Force -Path $backupFolder|Out-Null
  $stamp=Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $backupFile=Join-Path $backupFolder "ORL-before-065-$stamp.dump";$partial="$backupFile.partial"
  if((Test-Path -LiteralPath $backupFile)-or(Test-Path -LiteralPath $partial)){throw 'Backup filename already exists. Nothing installed.'}
  Write-Host 'Creating fresh full private backup...'
  & "$bin\pg_dump.exe" --dbname=$conn --format=custom --file=$partial --no-password
  if($LASTEXITCODE-ne0){throw 'Backup failed. Nothing installed.'}
  & "$bin\pg_restore.exe" --list $partial|Out-Null
  if($LASTEXITCODE-ne0){throw 'Backup archive check failed. Nothing installed.'}
  Move-Item -LiteralPath $partial -Destination $backupFile
  $backupName=[IO.Path]::GetFileName($backupFile);$backupHash=Get-ReviewedHash $backupFile
  if((Read-Host 'Type INSTALL 065')-cne'INSTALL 065'){throw 'Cancelled before installation.'}
  Test-ReviewedFiles
  & "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -f $migration
  if($LASTEXITCODE-ne0){throw 'Installation failed or result is uncertain. Run the read-only status check before deciding whether to retry.'}
  $audit=Get-ValidatedAudit
  $resultMessage='SUCCESS: 065 installed and its reviewed audit passed.'
 }
 New-Item -ItemType Directory -Force -Path $reportFolder|Out-Null
 $stamp=Get-Date -Format 'yyyyMMdd-HHmmss-fff'
 [ordered]@{format='ORL-065-SANITIZED-REPORT';project_ref='imrfmilqehcrvassuvuw';checked_at=(Get-Date).ToUniversalTime().ToString('o');
  already_installed=$alreadyInstalled;backup_file=$backupName;backup_sha256=$backupHash;
  migration065_sha256=(Get-ReviewedHash $migration);audit_sha256=(Get-ReviewedHash $auditFile);audit=$audit
 }|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $reportFolder "ORL-065-report-$stamp.json") -Encoding utf8NoBOM
 Write-Host $resultMessage -ForegroundColor Green
 Write-Host 'Tell GPT the result so the matching protected gateway and website can be released after verification. Keep backups private.'
}catch {
 Write-Host ('STOP: '+$_.Exception.Message) -ForegroundColor Red
 Write-Host 'No production Restore was run. Keep backups private; do not repeat an uncertain installation blindly.'
 exit 1
}finally{$env:PGPASSWORD=$oldPassword;$password=$null}
