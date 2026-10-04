param(
  [ValidateSet('disabled','enabled')]$State='disabled',
  [switch]$LoginIfNeeded
)
$ErrorActionPreference='Stop'
$orlRoot=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$orlProject='imrfmilqehcrvassuvuw'
$orlCliVersion='2.119.0'
$orlCliHash='971F439CC4B774F43181593551E0E34E29F399D5E82CBE3508E87537EC13E29F'
$orlCli=Join-Path $orlRoot ".tools\supabase-$orlCliVersion\supabase.exe"

function Test-OrlProjectAccess {
  $orlPreviousPreference=$ErrorActionPreference
  $ErrorActionPreference='Continue'
  try {
    $orlLines=@(& $orlCli projects list --output json 2>$null)
    $orlProjectListExit=$LASTEXITCODE
  } finally {$ErrorActionPreference=$orlPreviousPreference}
  if($orlProjectListExit-ne 0){return $false}
  try {$orlProjects=@(($orlLines -join [Environment]::NewLine)|ConvertFrom-Json)}
  catch {throw 'Supabase CLI returned an unreadable project list. Stop before mutation.'}
  foreach($orlItem in $orlProjects){
    if(([string]$orlItem.id -eq $orlProject)-or([string]$orlItem.ref -eq $orlProject)){return $true}
  }
  return $false
}

try {
  if(!(Test-Path -LiteralPath $orlCli)){throw "Pinned Supabase CLI $orlCliVersion is missing. Run Install-SupabaseCli-C1.ps1 first."}
  if((Get-FileHash -Algorithm SHA256 -LiteralPath $orlCli).Hash -ne $orlCliHash){throw 'Pinned Supabase CLI executable hash mismatch. Do not use it.'}
  $orlVersion=((& $orlCli --version 2>$null)-join '').Trim()
  if(($LASTEXITCODE-ne 0)-or($orlVersion-ne $orlCliVersion)){throw "Expected Supabase CLI $orlCliVersion; found '$orlVersion'."}
  if(!(Test-OrlProjectAccess)){
    if(!$LoginIfNeeded){throw 'No authenticated Supabase CLI access to the exact production project. Run this script with -LoginIfNeeded.'}
    Write-Host 'Supabase authentication is required. Complete it locally; never paste the token into chat.' -ForegroundColor Yellow
    & $orlCli login
    if($LASTEXITCODE-ne 0){throw 'Supabase login did not complete. No production mutation was attempted.'}
    if(!(Test-OrlProjectAccess)){throw 'Authenticated account cannot list the exact production project. No production mutation was attempted.'}
  }
  $orlValue=if($State-eq 'enabled'){'true'}else{'false'}
  Write-Host "C1 Edge requested state: $State" -ForegroundColor Yellow
  Write-Host "Authenticated access to exact project $orlProject confirmed."
  Write-Host 'This uses the existing private ORL_IC encryption/search secrets; it never reads or prints their values.'
  if((Read-Host "Type SET EDGE $($State.ToUpperInvariant())") -cne "SET EDGE $($State.ToUpperInvariant())"){throw 'Operator cancelled before Edge mutation.'}
  & $orlCli secrets set "ORL_IC_C1_ENABLED=$orlValue" --project-ref $orlProject --workdir $orlRoot
  if($LASTEXITCODE-ne 0){throw 'Secret-state update failed or is uncertain. Inspect Dashboard before retrying.'}
  & $orlCli functions deploy ic-requests --project-ref $orlProject --no-verify-jwt --workdir $orlRoot
  if($LASTEXITCODE-ne 0){throw 'Edge deployment failed or is uncertain. Inspect Dashboard before retrying.'}
  Write-Host "SUCCESS: ic-requests deployed with requested state $State." -ForegroundColor Green
} catch { Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }
