#Requires -Version 7.4
# Prepared locally only. Opening this installer requires separate user approval.
# Two-function update only; installation does not assign patients or change existing records.
$ErrorActionPreference='Stop'
$bin='C:\Program Files\PostgreSQL\18\bin'
$migration=Join-Path $PSScriptRoot '..\..\supabase\071_pending_request_assignment.sql'
$auditFile=Join-Path $PSScriptRoot 'audit-pending-assignment.sql'
$ca=Join-Path $PSScriptRoot '..\..\..\ic-encryption-package-b\certs\supabase-prod-ca-2021.crt'
$backupFolder=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ORL-Private-Backups'
$reportFolder=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ORL-Release-Reports'
$oldPassword=$env:PGPASSWORD;$password=$null
function Get-ReviewedHash([string]$Path) {
 $stream=[IO.File]::OpenRead($Path);$sha=[Security.Cryptography.SHA256]::Create()
 try{return [Convert]::ToHexString($sha.ComputeHash($stream))}finally{$stream.Dispose();$sha.Dispose()}
}
function Test-ReviewedFiles {
 if((Get-ReviewedHash $migration)-cne'AFADD99C21E1996C1D840A30D1603A7E48C5CE4F9D0D2BE87F59596D972FE319'){throw 'Reviewed migration 071 changed.'}
 if((Get-ReviewedHash $auditFile)-cne'411AA37798BF24063EEBFE29D31FBBC38202599D83D96D572666732347A6CA53'){throw 'Reviewed pending-assignment audit changed.'}
}
function Get-ValidatedAudit {
 Test-ReviewedFiles
 $auditLines=& "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -At -f $auditFile
 if($LASTEXITCODE-ne0){throw 'Pending-assignment audit failed. Inspect status before continuing.'}
 $result=($auditLines|Where-Object{$_-match'^\{'}|Select-Object -Last 1)|ConvertFrom-Json
 $checks=@('reviewed_assignment_definitions','reviewed_core_dependencies','assignment_rpc_grants','private_functions_closed','browser_tables_closed','private_tables_closed','protected_rls','same_date_guard_enabled')
 if($null-eq$result-or@(Compare-Object ($checks|Sort-Object) (@($result.PSObject.Properties.Name)|Sort-Object)).Count-ne0){throw 'Pending-assignment audit was incomplete.'}
 foreach($name in $checks){if($result.$name-isnot[bool]-or$result.$name-ne$true){throw "Pending-assignment audit failed: $name. Inspect status; do not repeat blindly."}}
 return $result
}
function Get-InstallationState($State) {
 $names=@('view_md5','assign_md5')
 if($null-eq$State-or@(Compare-Object ($names|Sort-Object) (@($State.PSObject.Properties.Name)|Sort-Object)).Count-ne0){throw 'Installation check was incomplete.'}
 foreach($name in $names){if($State.$name-isnot[string]-or$State.$name-cnotmatch'^[0-9a-f]{32}$'){throw 'Installation check was incomplete.'}}
 if($State.view_md5-ceq'22512869668d90879f91082d9899ace9'-and$State.assign_md5-ceq'db0893a9df012b4bd359b30b6bce1526'){return 'INSTALLED'}
 if($State.view_md5-ceq'060a6404455ba9f9ddbc78a2a19bfac4'-and$State.assign_md5-ceq'e54fa0d43ffd4b4e4d4178b2a814609a'){return 'BASELINE'}
 throw 'Assignment functions differ from the reviewed baseline or installation is partial. Nothing installed.'
}
try {
 Test-ReviewedFiles
 . (Join-Path $PSScriptRoot 'Test-OrlReviewedCa.ps1')
 Test-OrlReviewedCa -Path $ca -ExpectedDerSha256 '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'
 $cap=$ca.Replace('\','/').Replace("'","\'")
 $conn="host=aws-0-ap-southeast-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.imrfmilqehcrvassuvuw sslmode=verify-full sslrootcert='$cap' connect_timeout=20"
 Write-Host 'PENDING ASSIGNMENT / 071: private full backup, then reviewed atomic database installation.' -ForegroundColor Yellow
 Write-Host 'Admin and Webmaster can approve and assign an unassigned pending request in one action.'
 Write-Host 'Installation does not assign, move or delete patients. Existing audit history and settings are unchanged.'
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
 'view_md5',(select md5(replace(prosrc,chr(13),'')) from pg_proc where oid=to_regprocedure('public.orl_booking_assign_view(uuid,uuid)')),
 'assign_md5',(select md5(replace(prosrc,chr(13),'')) from pg_proc where oid=to_regprocedure('public.orl_booking_assign_existing(uuid,uuid,uuid,timestamptz,uuid)'))
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
  $resultMessage='SUCCESS: 071 is already installed and its reviewed audit passed. No migration or backup was repeated.'
 }else{
  # Only the exact hash-pinned metadata-only baseline is used in the read-only preflight.
  $migrationText=[IO.File]::ReadAllText($migration)
  $baselineMatches=[regex]::Matches($migrationText,'(?s)do \$baseline\$.*?end \$baseline\$;')
  if($baselineMatches.Count-ne1){throw 'Reviewed baseline block is missing or ambiguous.'}
  $preflight="begin read only;`nset local statement_timeout='30s';`n"+$baselineMatches[0].Value+"`nselect 'BASELINE_071_OK';`nrollback;"
  $lines=$preflight|& "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -At
  if($LASTEXITCODE-ne0-or-not($lines-contains'BASELINE_071_OK')){throw 'Read-only baseline check failed. Nothing installed.'}
  New-Item -ItemType Directory -Force -Path $backupFolder|Out-Null
  $stamp=Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $backupFile=Join-Path $backupFolder "ORL-before-071-$stamp.dump";$partial="$backupFile.partial"
  if((Test-Path -LiteralPath $backupFile)-or(Test-Path -LiteralPath $partial)){throw 'Backup filename already exists. Nothing installed.'}
  Write-Host 'Creating fresh full private backup...'
  & "$bin\pg_dump.exe" --dbname=$conn --format=custom --file=$partial --no-password
  if($LASTEXITCODE-ne0){throw 'Backup failed. Nothing installed.'}
  & "$bin\pg_restore.exe" --list $partial|Out-Null
  if($LASTEXITCODE-ne0){throw 'Backup archive check failed. Nothing installed.'}
  Move-Item -LiteralPath $partial -Destination $backupFile
  $backupName=[IO.Path]::GetFileName($backupFile);$backupHash=Get-ReviewedHash $backupFile
  if((Read-Host 'Type INSTALL 071')-cne'INSTALL 071'){throw 'Cancelled before installation.'}
  Test-ReviewedFiles
  & "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -f $migration
  if($LASTEXITCODE-ne0){throw 'Installation failed or result is uncertain. Inspect read-only status before deciding whether to retry.'}
  $audit=Get-ValidatedAudit
  $resultMessage='SUCCESS: 071 installed. Pending assignment permissions and protected workflow definitions verified.'
 }
 New-Item -ItemType Directory -Force -Path $reportFolder|Out-Null
 $stamp=Get-Date -Format 'yyyyMMdd-HHmmss-fff'
 [ordered]@{format='ORL-071-SANITIZED-REPORT';project_ref='imrfmilqehcrvassuvuw';checked_at=(Get-Date).ToUniversalTime().ToString('o');
  already_installed=$alreadyInstalled;backup_file=$backupName;backup_sha256=$backupHash;
  migration071_sha256=(Get-ReviewedHash $migration);audit_sha256=(Get-ReviewedHash $auditFile);audit=$audit
 }|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $reportFolder "ORL-071-report-$stamp.json") -Encoding utf8NoBOM
 Write-Host $resultMessage -ForegroundColor Green
 Write-Host 'Tell GPT the result so the matching website update can be released after verification. Keep backups private.'
}catch {
 Write-Host ('STOP: '+$_.Exception.Message) -ForegroundColor Red
 Write-Host 'No production Restore was run. Keep backups private; do not repeat an uncertain installation blindly.'
 exit 1
}finally{$env:PGPASSWORD=$oldPassword;$password=$null}
