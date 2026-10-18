#Requires -Version 7.4
param([switch]$PreflightOnly)
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$orlProjectRef='imrfmilqehcrvassuvuw';$version='2.119.0'
$cli=Join-Path $root ".tools\supabase-$version\supabase.exe"
$cliHash='971F439CC4B774F43181593551E0E34E29F399D5E82CBE3508E87537EC13E29F'
$manifestFile=Join-Path $PSScriptRoot 'edge-068-inputs.json'
$manifestHash='756B3C5F617386783993636631EEFF6BD8E05C916FC9C596DC117F9DA3232294'
$migrationHash='EB23ED3EF22B338334D8C889B602BA4BAEE5F32E174A788E22165052A112C285'
$auditHash='98815CEC343DDFEFD51F38C5583CC5CE9EE725ECE032D1FA36B08F59E3B3BD2B'
$reportFolder=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ORL-Release-Reports'
function Get-FileDigest([string]$Path,[switch]$Normalize) {
 if($Normalize){
  $value=[IO.File]::ReadAllText($Path).Replace("`r`n","`n").Replace("`r","`n")
  return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($value)))
 }
 $stream=[IO.File]::OpenRead($Path);$sha=[Security.Cryptography.SHA256]::Create()
 try{return [Convert]::ToHexString($sha.ComputeHash($stream))}finally{$stream.Dispose();$sha.Dispose()}
}
function Test-ReviewedEdgeInputs {
 if((Get-FileDigest $manifestFile -Normalize)-cne$manifestHash){throw 'Reviewed Edge input manifest changed.'}
 $manifest=[IO.File]::ReadAllText($manifestFile)|ConvertFrom-Json
 if($manifest.format-cne'ORL-068-EDGE-INPUTS'-or$manifest.normalization-cne'UTF8-NO-BOM-LF' -or
  $manifest.project_ref-cne$orlProjectRef-or$manifest.function-cne'ic-requests'-or@($manifest.files).Count-ne14){throw 'Edge input manifest is invalid.'}
 $known=@($manifest.files|ForEach-Object{[string]$_.path})
 if(@($known|Sort-Object -Unique).Count-ne14){throw 'Edge input manifest contains duplicate paths.'}
 foreach($inputFile in $manifest.files){
  if($inputFile.path-notmatch'^supabase/(config\.toml|functions/(_shared/([a-z0-9-]+/)?[a-z0-9-]+\.mjs|ic-requests/index\.ts))$'){
   throw 'Unexpected Edge input path.'
  }
  if((Get-FileDigest (Join-Path $root $inputFile.path) -Normalize)-cne$inputFile.sha256){throw "Reviewed Edge input changed: $($inputFile.path)."}
 }
 $actual=@(Get-ChildItem -LiteralPath (Join-Path $root 'supabase/functions/_shared'),(Join-Path $root 'supabase/functions/ic-requests') -Recurse -File|
  ForEach-Object{[IO.Path]::GetRelativePath($root,$_.FullName).Replace('\','/')})+'supabase/config.toml'
 if(@(Compare-Object ($known|Sort-Object) ($actual|Sort-Object)).Count-ne0){throw 'Unreviewed Edge source or configuration file found.'}
 foreach($configDir in @($root,(Join-Path $root 'supabase'),(Join-Path $root 'supabase/functions'))){
  foreach($configName in @('deno.json','deno.jsonc','import_map.json','deno.lock')){
   if(Test-Path -LiteralPath (Join-Path $configDir $configName)){throw 'Unreviewed Deno configuration found.'}
  }
 }
 if((Get-FileDigest (Join-Path $root 'supabase/068_undo_done.sql'))-cne$migrationHash -or
  (Get-FileDigest (Join-Path $root 'security/release/audit-undo-done.sql'))-cne$auditHash){throw 'Reviewed 068 migration or audit changed.'}
}
function Get-VerifiedInstallReport {
 # Read only the known sanitized report folder; never inspect backups or secrets.
 if(!(Test-Path -LiteralPath $reportFolder -PathType Container)){throw 'A successful 068 installation audit report is required.'}
 $reportFile=Get-ChildItem -LiteralPath $reportFolder -File -Filter 'ORL-068-report-*.json'|Sort-Object LastWriteTimeUtc -Descending|Select-Object -First 1
 if($null-eq$reportFile-or$reportFile.Length-gt16384){throw 'A successful 068 installation audit report is required.'}
 $reportText=[IO.File]::ReadAllText($reportFile.FullName)
 $report=$reportText|ConvertFrom-Json
 if($report.format-cne'ORL-068-SANITIZED-REPORT'-or$report.project_ref-cne$orlProjectRef -or
  $report.migration068_sha256-cne$migrationHash-or$report.audit_sha256-cne$auditHash-or$report.already_installed-isnot[bool]){
  throw 'The installation report does not match this reviewed 068 release.'
 }
 if($report.already_installed){
  if($null-ne$report.backup_file-or$null-ne$report.backup_sha256){throw 'Already-installed audit contains unexpected backup metadata.'}
 }elseif($report.backup_file-isnot[string]-or$report.backup_sha256-isnot[string]-or
  $report.backup_file-cnotmatch'^ORL-before-068-\d{8}-\d{6}-\d{3}\.dump$'-or$report.backup_sha256-cnotmatch'^[A-F0-9]{64}$'){
  throw 'The fresh installation report is missing its private backup evidence.'
 }
 # ConvertFrom-Json may turn ISO timestamps into DateTime objects. Preserve the
 # original ISO string so locale-dependent DateTime formatting cannot break a fresh report.
 $reportJson=[Text.Json.JsonDocument]::Parse($reportText)
 try{$checkedText=$reportJson.RootElement.GetProperty('checked_at').GetString()}finally{$reportJson.Dispose()}
 $checked=[DateTimeOffset]::MinValue
 if($checkedText-notmatch'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?Z$' -or
  -not[DateTimeOffset]::TryParse($checkedText,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::None,[ref]$checked) -or
  $checked-lt[DateTimeOffset]::UtcNow.AddHours(-24)-or$checked-gt[DateTimeOffset]::UtcNow.AddMinutes(5)){
  throw 'A current installation audit is required. Run the 068 installer again to audit its installed state without repeating the migration.'
 }
 $checks=@('reviewed_definitions','undo_done_service_only','service_only_gateway','private_core','historical_correction_preserved','ordinary_past_booking_guard','ordinary_move_preserved','lifecycle_preserved','restore_preserved','browser_tables_closed','identity_tables_closed','recovery_ready','masked_read_preserved','ic_storage_preserved')
 if($null-eq$report.audit-or@(Compare-Object ($checks|Sort-Object) (@($report.audit.PSObject.Properties.Name)|Sort-Object)).Count-ne0){
  throw 'The installation audit report is incomplete.'
 }
 foreach($name in $checks){if($report.audit.$name-isnot[bool]-or$report.audit.$name-ne$true){throw 'The installation audit did not pass every required check.'}}
 return [pscustomobject]@{name=$reportFile.Name;sha256=(Get-FileDigest $reportFile.FullName)}
}
try {
 Test-ReviewedEdgeInputs
 $installationReport=Get-VerifiedInstallReport
 if(!(Test-Path -LiteralPath $cli)-or(Get-FileDigest $cli)-cne$cliHash){throw 'Pinned Supabase CLI unavailable or changed.'}
 $actualVersion=((& $cli --version 2>$null)-join'').Trim()
 if($LASTEXITCODE-ne0-or$actualVersion-cne$version){throw 'Pinned Supabase CLI version differs.'}
 $orlPreviousPreference=$ErrorActionPreference;$ErrorActionPreference='Continue'
 try{$orlProjectLines=@(& $cli projects list --output json 2>$null);$orlProjectExit=$LASTEXITCODE}
 finally{$ErrorActionPreference=$orlPreviousPreference}
 if($orlProjectExit-ne0){throw 'Supabase project access check failed. No deployment started.'}
 $orlProjects=@(($orlProjectLines-join[Environment]::NewLine)|ConvertFrom-Json)
 if(@($orlProjects|Where-Object{[string]$_.id-eq$orlProjectRef-or[string]$_.ref-eq$orlProjectRef}).Count-ne1){throw 'Exact production project access unavailable.'}
 if($PreflightOnly){Write-Host 'SUCCESS: reviewed 068 Edge preflight passed. No deployment was run.' -ForegroundColor Green;exit 0}
 Write-Host "068 database audit and exact project confirmed: $orlProjectRef" -ForegroundColor Yellow
 Write-Host 'Existing IC keys and enable flag are reused; their values are not read or changed.'
 if((Read-Host 'Type DEPLOY 068 EDGE')-cne'DEPLOY 068 EDGE'){throw 'Operator cancelled.'}
 Test-ReviewedEdgeInputs
 $installationReport=Get-VerifiedInstallReport
 $orlPreviousPreference=$ErrorActionPreference;$ErrorActionPreference='Continue'
 try{& $cli functions deploy ic-requests --project-ref $orlProjectRef --no-verify-jwt --workdir $root;$orlDeployExit=$LASTEXITCODE}
 finally{$ErrorActionPreference=$orlPreviousPreference}
 if($orlDeployExit-ne0){throw 'Edge deployment failed or its result is uncertain. Inspect deployed status before retrying.'}
 $stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
 [ordered]@{format='ORL-068-EDGE-SANITIZED-REPORT';project_ref=$orlProjectRef;function='ic-requests';
  completed_at=(Get-Date).ToUniversalTime().ToString('o');manifest_sha256=$manifestHash;installation_report=$installationReport.name;
  installation_report_sha256=$installationReport.sha256;cli_version=$version
 }|ConvertTo-Json -Depth 3|Set-Content -LiteralPath (Join-Path $reportFolder "ORL-068-edge-report-$stamp.json") -Encoding utf8NoBOM
 Write-Host 'SUCCESS: reviewed 068 protected gateway deployed. Verify it before website publication.' -ForegroundColor Green
}catch{Write-Host ('STOP: '+$_.Exception.Message) -ForegroundColor Red;exit 1}
