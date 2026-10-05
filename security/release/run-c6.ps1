$ErrorActionPreference='Stop';$endpoint='https://imrfmilqehcrvassuvuw.supabase.co/functions/v1/ic-requests'
$tokenPtr=[IntPtr]::Zero;$passwordPtr=[IntPtr]::Zero;$token=$null;$password=$null
function Call([hashtable]$body){try{return Invoke-RestMethod -Method Post -Uri $endpoint -Headers @{'x-orl-session'=$token} -ContentType 'application/json' -Body ($body|ConvertTo-Json -Compress -Depth 8) -TimeoutSec 90}catch{throw 'Protected C6 result failed or is uncertain. Stop and inspect status; do not repeat blindly.'}}
try{
  Write-Host 'C6 STEP 3/4: fresh crypto verification followed by one atomic plaintext cutover.' -ForegroundColor Yellow
  $s=Read-Host 'Paste current Webmaster session token privately' -AsSecureString;$tokenPtr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);$token=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPtr)
  if($token-notmatch'^[0-9a-fA-F-]{36}$'){throw 'Invalid session token.'}
  $p=Read-Host 'Enter Webmaster WEBSITE password privately' -AsSecureString;$passwordPtr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($p);$password=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPtr)
  if([string]::IsNullOrEmpty($password)){throw 'Password required.'}
  $state=(Call @{operation='C6_STATUS';password=$password}).result
  Write-Host ("Inventory: {0} requests; {1} protected; {2} plaintext rows; {3} blank." -f $state.total_requests,$state.protected_rows,$state.plaintext_rows,$state.blank_rows)
  if($state.cutover_complete){Write-Host 'C6 was already completed; no cutover repeated.' -ForegroundColor Green;exit 0}
  if([int]$state.identity_mismatch-ne0-or[int]$state.protected_rows+[int]$state.blank_rows-ne[int]$state.total_requests){throw 'Identity coverage mismatch. Stop.'}
  $run=(Call @{operation='C2_VERIFY_START';password=$password;generation=$state.generation;revision=$state.revision}).result
  while([int]$run.remaining-gt0){$run=(Call @{operation='C2_VERIFY';password=$password;generation=$run.generation;run_id=$run.run_id}).result;Write-Host ("Verified: {0}; remaining: {1}" -f $run.verified,$run.remaining)}
  $done=(Call @{operation='C2_FINALIZE';password=$password;generation=$run.generation;run_id=$run.run_id}).result
  if($done.status-ne'COMPLETED'){throw 'Fresh crypto reconciliation not confirmed.'}
  Write-Host 'Fresh cryptographic reconciliation complete. No plaintext has been removed yet.' -ForegroundColor Green
  if((Read-Host 'Type REMOVE PLAINTEXT')-cne'REMOVE PLAINTEXT'){throw 'Operator cancelled before cutover.'}
  $cut=(Call @{operation='C6_CUTOVER';password=$password;generation=$run.generation;run_id=$run.run_id}).result
  if($cut.status-ne'COMPLETED'-or[int]$cut.plaintext_rows-ne0-or[int]$cut.identity_mismatch-ne0){throw 'C6 completion is uncertain.'}
  Write-Host ("SUCCESS: C6 cutover complete. {0} identities remain encrypted; operational IC values are masked." -f $cut.protected_rows) -ForegroundColor Green
}catch{Write-Host $_.Exception.Message -ForegroundColor Red;exit 1}finally{$token=$null;$password=$null;if($tokenPtr-ne[IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPtr)};if($passwordPtr-ne[IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPtr)}}
