#Requires -Version 7.4
# Installs reviewed definitions only. It never moves a patient, restores production, deploys Edge or publishes the website.
$ErrorActionPreference='Stop'
$bin='C:\Program Files\PostgreSQL\18\bin'
$migration=Join-Path $PSScriptRoot '..\..\supabase\066_closed_past_reassign.sql'
$auditFile=Join-Path $PSScriptRoot 'audit-closed-past-reassign.sql'
$ca=Join-Path $PSScriptRoot '..\..\..\ic-encryption-package-b\certs\supabase-prod-ca-2021.crt'
$backupFolder=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ORL-Private-Backups'
$reportFolder=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ORL-Release-Reports'
$oldPassword=$env:PGPASSWORD;$password=$null
function Get-ReviewedHash([string]$Path) {
 $stream=[IO.File]::OpenRead($Path);$sha=[Security.Cryptography.SHA256]::Create()
 try{return [Convert]::ToHexString($sha.ComputeHash($stream))}finally{$stream.Dispose();$sha.Dispose()}
}
function Test-ReviewedFiles {
 if((Get-ReviewedHash $migration)-cne'E9BB89B03A977A40A98FE067A0A848B31338DE2F303DE5965D6896FA3BCA3C09'){throw 'Reviewed migration 066 changed.'}
 if((Get-ReviewedHash $auditFile)-cne'434D996CAC2D890CDFA1547C694FF293FAFD8A540B1288CDF98A3A866DCDD35E'){throw 'Reviewed closed-past reassignment audit changed.'}
}
function Get-ValidatedAudit {
 Test-ReviewedFiles
 $auditLines=& "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -At -f $auditFile
 if($LASTEXITCODE-ne0){throw 'Closed-past reassignment audit failed. Inspect status before continuing.'}
 $result=($auditLines|Where-Object{$_-match'^\{'}|Select-Object -Last 1)|ConvertFrom-Json
 $checks=@('reviewed_definitions','service_only_gateway','private_core','historical_correction_preserved','ordinary_past_booking_guard','ordinary_move_preserved','lifecycle_preserved','restore_preserved','browser_tables_closed','identity_tables_closed','recovery_ready','masked_read_preserved','ic_storage_preserved')
 if($null-eq$result-or@(Compare-Object ($checks|Sort-Object) (@($result.PSObject.Properties.Name)|Sort-Object)).Count-ne0){throw 'Closed-past reassignment audit was incomplete.'}
 foreach($name in $checks){if($result.$name-isnot[bool]-or$result.$name-ne$true){throw "Closed-past reassignment audit failed: $name. Inspect status; do not repeat blindly."}}
 return $result
}
function Get-InstallationState($State) {
 if($null-eq$State-or@($State.PSObject.Properties).Count-ne2-or$State.baseline-isnot[bool]-or$State.installed-isnot[bool]){throw 'Installation check was incomplete.'}
 if($State.installed-eq$true-and$State.baseline-eq$false){return 'INSTALLED'}
 if($State.baseline-eq$true-and$State.installed-eq$false){return 'BASELINE'}
 throw 'Unexpected reassignment definitions found. Nothing installed; inspect safely.'
}
try {
 Test-ReviewedFiles
 . (Join-Path $PSScriptRoot 'Test-OrlReviewedCa.ps1')
 Test-OrlReviewedCa -Path $ca -ExpectedDerSha256 '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'
 $cap=$ca.Replace('\','/').Replace("'","\'")
 $conn="host=aws-0-ap-southeast-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.imrfmilqehcrvassuvuw sslmode=verify-full sslrootcert='$cap' connect_timeout=20"
 Write-Host 'CLOSED PAST REASSIGN / 066: private full backup, then reviewed atomic database installation.' -ForegroundColor Yellow
 Write-Host 'Webmaster only: move an unfinished case into an empty Closed slot on the same past OT date.'
 Write-Host 'No patient is changed by installation. Ordinary past requests stay closed; Done cases stay locked.'
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
 'baseline',coalesce((select md5(replace(prosrc,chr(13),''))='f3d2b7af8df7434acaf2d53985a5e589' from pg_proc where oid=to_regprocedure('public.orl_swap_slots_checked(uuid,uuid,uuid,uuid,uuid)')),false),
 'installed',coalesce((select md5(replace(prosrc,chr(13),''))='777efc10480acfbbfb44688322a370f5' from pg_proc where oid=to_regprocedure('public.orl_swap_slots_checked(uuid,uuid,uuid,uuid,uuid)')),false)
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
  $resultMessage='SUCCESS: 066 is already installed and its reviewed audit passed. No migration or backup was repeated.'
 }else{
  # Extract only the pinned metadata-only baseline. It must not perform clinical writes.
  $migrationText=[IO.File]::ReadAllText($migration)
  $baselineMatches=[regex]::Matches($migrationText,'(?s)do \$baseline\$.*?end \$baseline\$;')
  if($baselineMatches.Count-ne1){throw 'Reviewed baseline block is missing or ambiguous.'}
  $preflight="begin read only;`nset local statement_timeout='30s';`n"+$baselineMatches[0].Value+"`nselect 'BASELINE_066_OK';`nrollback;"
  $lines=$preflight|& "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -At
  if($LASTEXITCODE-ne0-or-not($lines-contains'BASELINE_066_OK')){throw 'Read-only baseline check failed. Nothing installed.'}
  New-Item -ItemType Directory -Force -Path $backupFolder|Out-Null
  $stamp=Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $backupFile=Join-Path $backupFolder "ORL-before-066-$stamp.dump";$partial="$backupFile.partial"
  if((Test-Path -LiteralPath $backupFile)-or(Test-Path -LiteralPath $partial)){throw 'Backup filename already exists. Nothing installed.'}
  Write-Host 'Creating fresh full private backup...'
  & "$bin\pg_dump.exe" --dbname=$conn --format=custom --file=$partial --no-password
  if($LASTEXITCODE-ne0){throw 'Backup failed. Nothing installed.'}
  & "$bin\pg_restore.exe" --list $partial|Out-Null
  if($LASTEXITCODE-ne0){throw 'Backup archive check failed. Nothing installed.'}
  Move-Item -LiteralPath $partial -Destination $backupFile
  $backupName=[IO.Path]::GetFileName($backupFile);$backupHash=Get-ReviewedHash $backupFile
  if((Read-Host 'Type INSTALL 066')-cne'INSTALL 066'){throw 'Cancelled before installation.'}
  Test-ReviewedFiles
  & "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -f $migration
  if($LASTEXITCODE-ne0){throw 'Installation failed or result is uncertain. Inspect read-only status before deciding whether to retry.'}
  $audit=Get-ValidatedAudit
  $resultMessage='SUCCESS: 066 installed and its reviewed audit passed.'
 }
 New-Item -ItemType Directory -Force -Path $reportFolder|Out-Null
 $stamp=Get-Date -Format 'yyyyMMdd-HHmmss-fff'
 [ordered]@{format='ORL-066-SANITIZED-REPORT';project_ref='imrfmilqehcrvassuvuw';checked_at=(Get-Date).ToUniversalTime().ToString('o');
  already_installed=$alreadyInstalled;backup_file=$backupName;backup_sha256=$backupHash;
  migration066_sha256=(Get-ReviewedHash $migration);audit_sha256=(Get-ReviewedHash $auditFile);audit=$audit
 }|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $reportFolder "ORL-066-report-$stamp.json") -Encoding utf8NoBOM
 Write-Host $resultMessage -ForegroundColor Green
 Write-Host 'Tell GPT the result so the matching website can be released after verification. No Edge deployment is required. Keep backups private.'
}catch {
 Write-Host ('STOP: '+$_.Exception.Message) -ForegroundColor Red
 Write-Host 'No production Restore was run. Keep backups private; do not repeat an uncertain installation blindly.'
 exit 1
}finally{$env:PGPASSWORD=$oldPassword;$password=$null}
