$ErrorActionPreference='Stop'
$orlRoot=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path;$orlProject='imrfmilqehcrvassuvuw';$orlCliVersion='2.119.0'
$orlCliHash='971F439CC4B774F43181593551E0E34E29F399D5E82CBE3508E87537EC13E29F';$orlCli=Join-Path $orlRoot ".tools\supabase-$orlCliVersion\supabase.exe"
function Get-OrlFileSha256([string]$Path){$s=[IO.File]::OpenRead($Path);$h=[Security.Cryptography.SHA256]::Create();try{[BitConverter]::ToString($h.ComputeHash($s)).Replace('-','')}finally{$h.Dispose();$s.Dispose()}}
function Test-OrlProjectAccess{$old=$ErrorActionPreference;$ErrorActionPreference='Continue';try{$lines=@(& $orlCli projects list --output json 2>$null);$code=$LASTEXITCODE}finally{$ErrorActionPreference=$old};if($code-ne 0){return $false};try{$projects=@(($lines-join[Environment]::NewLine)|ConvertFrom-Json)}catch{throw 'Unreadable Supabase project list.'};return @($projects|Where-Object{[string]$_.id-eq$orlProject-or[string]$_.ref-eq$orlProject}).Count-gt 0}
try{
  if(!(Test-Path -LiteralPath $orlCli)){throw "Pinned Supabase CLI $orlCliVersion is missing."}
  if((Get-OrlFileSha256 $orlCli)-ne$orlCliHash){throw 'Pinned Supabase CLI hash mismatch.'}
  if(((& $orlCli --version 2>$null)-join'').Trim()-ne$orlCliVersion){throw 'Pinned Supabase CLI version mismatch.'}
  if(!(Test-OrlProjectAccess)){throw 'No authenticated CLI access to the exact production project.'}
  Write-Host "Exact production project confirmed: $orlProject" -ForegroundColor Yellow
  Write-Host 'Existing private IC secrets and C1 enable flag are reused; neither is read or changed.'
  if((Read-Host 'Type DEPLOY C3 EDGE')-cne'DEPLOY C3 EDGE'){throw 'Operator cancelled before Edge deployment.'}
  & $orlCli functions deploy ic-requests --project-ref $orlProject --no-verify-jwt --workdir $orlRoot
  if($LASTEXITCODE-ne 0){throw 'Edge deployment failed or is uncertain. Inspect Dashboard before retrying.'}
  Write-Host 'SUCCESS: C3-capable ic-requests Edge Function deployed.' -ForegroundColor Green
}catch{Write-Host $_.Exception.Message -ForegroundColor Red;exit 1}
