#Requires -Version 7.4
# Installs reviewed definitions only. It never moves a patient, restores production, deploys Edge or publishes the website.
$ErrorActionPreference='Stop'
$bin='C:\Program Files\PostgreSQL\18\bin'
$migration=Join-Path $PSScriptRoot '..\..\supabase\068_undo_done.sql'
$auditFile=Join-Path $PSScriptRoot 'audit-undo-done.sql'
$ca=Join-Path $PSScriptRoot '..\..\..\ic-encryption-package-b\certs\supabase-prod-ca-2021.crt'
$backupFolder=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ORL-Private-Backups'
$reportFolder=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ORL-Release-Reports'
$oldPassword=$env:PGPASSWORD;$password=$null
function Get-ReviewedHash([string]$Path) {
 $stream=[IO.File]::OpenRead($Path);$sha=[Security.Cryptography.SHA256]::Create()
 try{return [Convert]::ToHexString($sha.ComputeHash($stream))}finally{$stream.Dispose();$sha.Dispose()}
}
function Test-ReviewedFiles {
 if((Get-ReviewedHash $migration)-cne'EB23ED3EF22B338334D8C889B602BA4BAEE5F32E174A788E22165052A112C285'){throw 'Reviewed migration 068 changed.'}
 if((Get-ReviewedHash $auditFile)-cne'98815CEC343DDFEFD51F38C5583CC5CE9EE725ECE032D1FA36B08F59E3B3BD2B'){throw 'Reviewed Undo Done audit changed.'}
}
function Get-ValidatedAudit {
 Test-ReviewedFiles
 $auditLines=& "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -At -f $auditFile
 if($LASTEXITCODE-ne0){throw 'Undo Done audit failed. Inspect status before continuing.'}
 $result=($auditLines|Where-Object{$_-match'^\{'}|Select-Object -Last 1)|ConvertFrom-Json
 $checks=@('reviewed_definitions','undo_done_service_only','service_only_gateway','private_core','historical_correction_preserved','ordinary_past_booking_guard','ordinary_move_preserved','lifecycle_preserved','restore_preserved','browser_tables_closed','identity_tables_closed','recovery_ready','masked_read_preserved','ic_storage_preserved')
 if($null-eq$result-or@(Compare-Object ($checks|Sort-Object) (@($result.PSObject.Properties.Name)|Sort-Object)).Count-ne0){throw 'Undo Done audit was incomplete.'}
 foreach($name in $checks){if($result.$name-isnot[bool]-or$result.$name-ne$true){throw "Undo Done audit failed: $name. Inspect status; do not repeat blindly."}}
 return $result
}
function Get-InstallationState($State) {
 if($null-eq$State-or@($State.PSObject.Properties).Count-ne1-or$State.has_undo_done-isnot[bool]){throw 'Installation check was incomplete.'}
 if($State.has_undo_done-eq$true){return 'INSTALLED'}
 return 'BASELINE'
}
try {
 Test-ReviewedFiles
 . (Join-Path $PSScriptRoot 'Test-OrlReviewedCa.ps1')
 Test-OrlReviewedCa -Path $ca -ExpectedDerSha256 '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'
 $cap=$ca.Replace('\','/').Replace("'","\'")
 $conn="host=aws-0-ap-southeast-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.imrfmilqehcrvassuvuw sslmode=verify-full sslrootcert='$cap' connect_timeout=20"
 Write-Host 'UNDO DONE / 068: private full backup, then reviewed atomic database installation.' -ForegroundColor Yellow
 Write-Host 'Webmaster only: undo an incorrect Done status with a mandatory reason and current website password.'
 Write-Host 'No patient is changed by installation. The patient stays in the same slot; ordinary past requests stay closed.'
 Write-Host 'No production Restore or Edge deployment is run. Website release is a separate step.'
 $secure=Read-Host 'Paste DATABASE password (hidden; NOT website password)' -AsSecureString
 try{$password=[Net.NetworkCredential]::new('',$secure).Password}finally{$secure.Dispose()}
 if([string]::IsNullOrEmpty($password)){throw 'Database password was empty.'}
 $env:PGPASSWORD=$password
 Test-ReviewedFiles
 $inspection=@'
begin read only;
set local statement_timeout='30s';
select jsonb_build_object(
 'has_undo_done',to_regprocedure('public.orl_ic_undo_done(uuid,text,uuid,uuid,text,uuid,timestamptz)') is not null
);
rollback;
'@
 $lines=$inspection|& "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -At
 if($LASTEXITCODE-ne0){throw 'Read-only installation check failed. Nothing installed.'}
 $state=($lines|Where-Object{$_-match'^\{'}|Select-Object -Last 1)|ConvertFrom-Json
 $alreadyInstalled=(Get-InstallationState $state)-ceq'INSTALLED'
 $backupName=$null;$backupHash=$null
 if($alreadyInstalled){
  $audit=Get-ValidatedAudit
  $resultMessage='SUCCESS: 068 is already installed and its reviewed audit passed. No migration or backup was repeated.'
 }else{
  # Extract only the pinned metadata-only baseline. It must not perform clinical writes.
  $migrationText=[IO.File]::ReadAllText($migration)
  $baselineMatches=[regex]::Matches($migrationText,'(?s)do \$baseline\$.*?end \$baseline\$;')
  if($baselineMatches.Count-ne1){throw 'Reviewed baseline block is missing or ambiguous.'}
  $preflight="begin read only;`nset local statement_timeout='30s';`n"+$baselineMatches[0].Value+"`nselect 'BASELINE_068_OK';`nrollback;"
  $lines=$preflight|& "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -At
  if($LASTEXITCODE-ne0-or-not($lines-contains'BASELINE_068_OK')){throw 'Read-only baseline check failed. Nothing installed.'}
  New-Item -ItemType Directory -Force -Path $backupFolder|Out-Null
  $stamp=Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $backupFile=Join-Path $backupFolder "ORL-before-068-$stamp.dump";$partial="$backupFile.partial"
  if((Test-Path -LiteralPath $backupFile)-or(Test-Path -LiteralPath $partial)){throw 'Backup filename already exists. Nothing installed.'}
  Write-Host 'Creating fresh full private backup...'
  & "$bin\pg_dump.exe" --dbname=$conn --format=custom --file=$partial --no-password
  if($LASTEXITCODE-ne0){throw 'Backup failed. Nothing installed.'}
  & "$bin\pg_restore.exe" --list $partial|Out-Null
  if($LASTEXITCODE-ne0){throw 'Backup archive check failed. Nothing installed.'}
  Move-Item -LiteralPath $partial -Destination $backupFile
  $backupName=[IO.Path]::GetFileName($backupFile);$backupHash=Get-ReviewedHash $backupFile
  if((Read-Host 'Type INSTALL 068')-cne'INSTALL 068'){throw 'Cancelled before installation.'}
  Test-ReviewedFiles
  & "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -f $migration
  if($LASTEXITCODE-ne0){throw 'Installation failed or result is uncertain. Inspect read-only status before deciding whether to retry.'}
  $audit=Get-ValidatedAudit
  $resultMessage='SUCCESS: 068 installed and its reviewed audit passed.'
 }
 New-Item -ItemType Directory -Force -Path $reportFolder|Out-Null
 $stamp=Get-Date -Format 'yyyyMMdd-HHmmss-fff'
 [ordered]@{format='ORL-068-SANITIZED-REPORT';project_ref='imrfmilqehcrvassuvuw';checked_at=(Get-Date).ToUniversalTime().ToString('o');
  already_installed=$alreadyInstalled;backup_file=$backupName;backup_sha256=$backupHash;
  migration068_sha256=(Get-ReviewedHash $migration);audit_sha256=(Get-ReviewedHash $auditFile);audit=$audit
 }|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $reportFolder "ORL-068-report-$stamp.json") -Encoding utf8NoBOM
 Write-Host $resultMessage -ForegroundColor Green
 Write-Host 'Tell GPT the result so the matching protected gateway and website can be released after verification. Keep backups private.'
}catch {
 Write-Host ('STOP: '+$_.Exception.Message) -ForegroundColor Red
 Write-Host 'No production Restore was run. Keep backups private; do not repeat an uncertain installation blindly.'
 exit 1
}finally{$env:PGPASSWORD=$oldPassword;$password=$null}
