$ErrorActionPreference='Stop'
$orlEndpoint='https://imrfmilqehcrvassuvuw.supabase.co/functions/v1/ic-requests'
$orlTokenPtr=[IntPtr]::Zero;$orlPasswordPtr=[IntPtr]::Zero;$orlToken=$null;$orlPassword=$null
function Invoke-OrlC2([hashtable]$Body){
  try{return Invoke-RestMethod -Method Post -Uri $orlEndpoint -Headers @{'x-orl-session'=$orlToken} -ContentType 'application/json' -Body ($Body|ConvertTo-Json -Compress -Depth 8) -TimeoutSec 90}
  catch{throw 'Protected C2 call failed or is uncertain. Stop; do not repeat blindly. Reload status only after review.'}
}
try{
  Write-Host 'PACKAGE C2: encrypt legacy IC shadows and verify every record. Plaintext is retained for Package C6.' -ForegroundColor Yellow
  $tokenSecure=Read-Host 'Paste current Webmaster session token privately' -AsSecureString
  $orlTokenPtr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($tokenSecure);$orlToken=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($orlTokenPtr)
  if($orlToken -notmatch '^[0-9a-fA-F-]{36}$'){throw 'Invalid session token format.'}
  $passwordSecure=Read-Host 'Enter Webmaster login password privately' -AsSecureString
  $orlPasswordPtr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($passwordSecure);$orlPassword=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($orlPasswordPtr)
  if([string]::IsNullOrEmpty($orlPassword)){throw 'Password is required.'}
  $state=(Invoke-OrlC2 @{operation='C2_STATUS';password=$orlPassword}).result
  Write-Host ("Inventory: {0} requests; {1} with IC; {2} already protected; {3} awaiting C2." -f $state.total_requests,$state.nonblank_requests,$state.protected_nonblank,$state.missing_supported)
  if([int]$state.missing_unsupported -ne 0){throw "STOP: $($state.missing_unsupported) unsupported IC value(s) require review without printing patient data."}
  if([int]$state.blank_with_identity -ne 0){throw "STOP: $($state.blank_with_identity) blank/identity mismatch(es) require review."}
  if($state.complete -and $state.last_completed_at){Write-Host 'C2 was already completed. No backfill was repeated.' -ForegroundColor Green;exit 0}
  if((Read-Host 'Type START C2')-cne'START C2'){throw 'Operator cancelled before backfill.'}
  $batch=0
  while([int]$state.missing_supported -gt 0){
    $response=(Invoke-OrlC2 @{operation='C2_BACKFILL';password=$orlPassword;generation=$state.generation;revision=$state.revision}).result
    if([int]$response.committed -lt 1){throw 'No C2 progress was confirmed.'}
    $batch++;$state=$response
    Write-Host ("Backfill batch {0}: {1} encrypted; {2} remaining." -f $batch,$response.committed,$response.missing_supported)
  }
  if([int]$state.missing_unsupported -ne 0 -or [int]$state.blank_with_identity -ne 0 -or -not [bool]$state.complete){throw 'C2 structural reconciliation is incomplete.'}
  $run=(Invoke-OrlC2 @{operation='C2_VERIFY_START';password=$orlPassword;generation=$state.generation;revision=$state.revision}).result
  Write-Host ("Cryptographic verification started: {0} identity rows." -f $run.total)
  $verifyBatch=0
  while([int]$run.remaining -gt 0){
    $run=(Invoke-OrlC2 @{operation='C2_VERIFY';password=$orlPassword;generation=$run.generation;run_id=$run.run_id}).result
    $verifyBatch++;Write-Host ("Verification batch {0}: {1} verified; {2} remaining." -f $verifyBatch,$run.verified,$run.remaining)
  }
  $done=(Invoke-OrlC2 @{operation='C2_FINALIZE';password=$orlPassword;generation=$run.generation;run_id=$run.run_id}).result
  if($done.status -ne 'COMPLETED'){throw 'C2 completion is not confirmed.'}
  Write-Host ("SUCCESS: C2 complete. {0} identities encrypted and cryptographically reconciled. Plaintext remains pending C6." -f $done.verified) -ForegroundColor Green
}catch{Write-Host $_.Exception.Message -ForegroundColor Red;exit 1}
finally{
  $orlToken=$null;$orlPassword=$null
  if($orlTokenPtr -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($orlTokenPtr)}
  if($orlPasswordPtr -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($orlPasswordPtr)}
}
