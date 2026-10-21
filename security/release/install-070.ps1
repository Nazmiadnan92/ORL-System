#Requires -Version 7.4
# Prepared locally only. Opening this installer requires separate user approval.
# Additive Day Note installation; never moves patients, restores production, deploys Edge or publishes the website.
$ErrorActionPreference='Stop'
$bin='C:\Program Files\PostgreSQL\18\bin'
$migration=Join-Path $PSScriptRoot '..\..\supabase\070_ot_day_notes.sql'
$auditFile=Join-Path $PSScriptRoot 'audit-day-notes.sql'
$ca=Join-Path $PSScriptRoot '..\..\..\ic-encryption-package-b\certs\supabase-prod-ca-2021.crt'
$backupFolder=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ORL-Private-Backups'
$reportFolder=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ORL-Release-Reports'
$oldPassword=$env:PGPASSWORD;$password=$null
function Get-ReviewedHash([string]$Path) {
 $stream=[IO.File]::OpenRead($Path);$sha=[Security.Cryptography.SHA256]::Create()
 try{return [Convert]::ToHexString($sha.ComputeHash($stream))}finally{$stream.Dispose();$sha.Dispose()}
}
function Test-ReviewedFiles {
 if((Get-ReviewedHash $migration)-cne'16C39E80A2D91743C3507CC796E7F2901BF21FA9913C799B2F95BC3103055827'){throw 'Reviewed migration 070 changed.'}
 if((Get-ReviewedHash $auditFile)-cne'22089F0DD1DCF14DF5A5C426150E8EBE13E4068CFEC624CF34D720877FCFE5A9'){throw 'Reviewed Day Note audit changed.'}
}
function Get-ValidatedAudit {
 Test-ReviewedFiles
 $auditLines=& "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -At -f $auditFile
 if($LASTEXITCODE-ne0){throw 'Day Note audit failed. Inspect status before continuing.'}
 $result=($auditLines|Where-Object{$_-match'^\{'}|Select-Object -Last 1)|ConvertFrom-Json
 $checks=@('reviewed_definitions','day_note_columns','day_note_constraints','day_note_rpc_grants','private_guards_closed','browser_tables_closed','identity_tables_closed','restore_preserved','recovery_ready','ic_storage_preserved')
 if($null-eq$result-or@(Compare-Object ($checks|Sort-Object) (@($result.PSObject.Properties.Name)|Sort-Object)).Count-ne0){throw 'Day Note audit was incomplete.'}
 foreach($name in $checks){if($result.$name-isnot[bool]-or$result.$name-ne$true){throw "Day Note audit failed: $name. Inspect status; do not repeat blindly."}}
 return $result
}
function Get-InstallationState($State) {
 $names=@('has_day_note','has_day_note_revision','has_read_rpc','has_write_rpc')
 if($null-eq$State-or@(Compare-Object ($names|Sort-Object) (@($State.PSObject.Properties.Name)|Sort-Object)).Count-ne0){throw 'Installation check was incomplete.'}
 foreach($name in $names){if($State.$name-isnot[bool]){throw 'Installation check was incomplete.'}}
 $present=@($names|Where-Object{$State.$_-eq$true}).Count
 if($present-eq$names.Count){return 'INSTALLED'}
 if($present-eq0){return 'BASELINE'}
 throw 'Day Note installation is partial or differs from the reviewed baseline. Nothing installed.'
}
try {
 Test-ReviewedFiles
 . (Join-Path $PSScriptRoot 'Test-OrlReviewedCa.ps1')
 Test-OrlReviewedCa -Path $ca -ExpectedDerSha256 '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'
 $cap=$ca.Replace('\','/').Replace("'","\'")
 $conn="host=aws-0-ap-southeast-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.imrfmilqehcrvassuvuw sslmode=verify-full sslrootcert='$cap' connect_timeout=20"
 Write-Host 'DAY NOTE / 070: private full backup, then reviewed atomic database installation.' -ForegroundColor Yellow
 Write-Host 'Admin and Webmaster can manage a date-specific notice. Staff can read it; this does not block bookings.'
 Write-Host 'Existing patients, slots, cancellation notes and audit history are unchanged by installation.'
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
 'has_day_note',exists(select 1 from pg_attribute where attrelid='public.orl_ot_sessions'::regclass and attname='day_note' and not attisdropped),
 'has_day_note_revision',exists(select 1 from pg_attribute where attrelid='public.orl_ot_sessions'::regclass and attname='day_note_revision' and not attisdropped),
 'has_read_rpc',to_regprocedure('public.orl_get_ot_day_notes(uuid,integer)') is not null,
 'has_write_rpc',to_regprocedure('public.orl_set_ot_day_note(uuid,uuid,text,bigint,uuid)') is not null
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
  $resultMessage='SUCCESS: 070 is already installed and its reviewed audit passed. No migration or backup was repeated.'
 }else{
  # Extract only the exact pinned metadata-only baseline for a read-only preflight.
  $migrationText=[IO.File]::ReadAllText($migration)
  $baselineMatches=[regex]::Matches($migrationText,'(?s)do \$baseline\$.*?end \$baseline\$;')
  if($baselineMatches.Count-ne1){throw 'Reviewed baseline block is missing or ambiguous.'}
  $preflight="begin read only;`nset local statement_timeout='30s';`n"+$baselineMatches[0].Value+"`nselect 'BASELINE_070_OK';`nrollback;"
  $lines=$preflight|& "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -At
  if($LASTEXITCODE-ne0-or-not($lines-contains'BASELINE_070_OK')){throw 'Read-only baseline check failed. Nothing installed.'}
  New-Item -ItemType Directory -Force -Path $backupFolder|Out-Null
  $stamp=Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $backupFile=Join-Path $backupFolder "ORL-before-070-$stamp.dump";$partial="$backupFile.partial"
  if((Test-Path -LiteralPath $backupFile)-or(Test-Path -LiteralPath $partial)){throw 'Backup filename already exists. Nothing installed.'}
  Write-Host 'Creating fresh full private backup...'
  & "$bin\pg_dump.exe" --dbname=$conn --format=custom --file=$partial --no-password
  if($LASTEXITCODE-ne0){throw 'Backup failed. Nothing installed.'}
  & "$bin\pg_restore.exe" --list $partial|Out-Null
  if($LASTEXITCODE-ne0){throw 'Backup archive check failed. Nothing installed.'}
  Move-Item -LiteralPath $partial -Destination $backupFile
  $backupName=[IO.Path]::GetFileName($backupFile);$backupHash=Get-ReviewedHash $backupFile
  if((Read-Host 'Type INSTALL 070')-cne'INSTALL 070'){throw 'Cancelled before installation.'}
  Test-ReviewedFiles
  & "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -f $migration
  if($LASTEXITCODE-ne0){throw 'Installation failed or result is uncertain. Inspect read-only status before deciding whether to retry.'}
  $audit=Get-ValidatedAudit
  $resultMessage='SUCCESS: 070 installed. Day Note permissions, protected writes and backup compatibility verified.'
 }
 New-Item -ItemType Directory -Force -Path $reportFolder|Out-Null
 $stamp=Get-Date -Format 'yyyyMMdd-HHmmss-fff'
 [ordered]@{format='ORL-070-SANITIZED-REPORT';project_ref='imrfmilqehcrvassuvuw';checked_at=(Get-Date).ToUniversalTime().ToString('o');
  already_installed=$alreadyInstalled;backup_file=$backupName;backup_sha256=$backupHash;
  migration070_sha256=(Get-ReviewedHash $migration);audit_sha256=(Get-ReviewedHash $auditFile);audit=$audit
 }|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $reportFolder "ORL-070-report-$stamp.json") -Encoding utf8NoBOM
 Write-Host $resultMessage -ForegroundColor Green
 Write-Host 'Tell GPT the result so the matching website update can be released after verification. Keep backups private.'
}catch {
 Write-Host ('STOP: '+$_.Exception.Message) -ForegroundColor Red
 Write-Host 'No production Restore was run. Keep backups private; do not repeat an uncertain installation blindly.'
 exit 1
}finally{$env:PGPASSWORD=$oldPassword;$password=$null}
