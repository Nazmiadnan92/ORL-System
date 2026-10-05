param([switch]$PreflightOnly)
$ErrorActionPreference='Stop';$root=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path;$orlProjectRef='imrfmilqehcrvassuvuw';$version='2.119.0'
$cli=Join-Path $root ".tools\supabase-$version\supabase.exe";$cliHash='971F439CC4B774F43181593551E0E34E29F399D5E82CBE3508E87537EC13E29F'
function Hash([string]$p){
  $s=[IO.File]::OpenRead($p);$h=[Security.Cryptography.SHA256]::Create()
  try{[BitConverter]::ToString($h.ComputeHash($s)).Replace('-','')}
  finally{$h.Dispose();$s.Dispose()}
}
try{
  if(!(Test-Path $cli)-or(Hash $cli)-ne$cliHash-or((& $cli --version 2>$null)-join'').Trim()-ne$version){throw 'Pinned Supabase CLI unavailable or changed.'}
  # Windows PowerShell treats native stderr warnings as errors even when redirected.
  # An unlinked local folder can warn here while projects list still succeeds.
  $orlPreviousPreference=$ErrorActionPreference
  $ErrorActionPreference='Continue'
  try{
    $orlProjectLines=@(& $cli projects list --output json 2>$null)
    $orlProjectExit=$LASTEXITCODE
  }finally{$ErrorActionPreference=$orlPreviousPreference}
  if($orlProjectExit-ne0){throw 'Supabase project access check failed. No deployment was started.'}
  $orlProjects=@(($orlProjectLines-join[Environment]::NewLine)|ConvertFrom-Json)
  if(@($orlProjects|Where-Object{[string]$_.id-eq$orlProjectRef-or[string]$_.ref-eq$orlProjectRef}).Count-ne1){throw 'Exact production project access unavailable.'}
  Write-Host "Exact project confirmed: $orlProjectRef" -ForegroundColor Yellow
  if($PreflightOnly){Write-Host 'SUCCESS: read-only C6 Edge preflight passed. No deployment was run.' -ForegroundColor Green;exit 0}
  Write-Host 'Existing IC keys and enable flag are reused; their values are not read or changed.'
  if((Read-Host 'Type DEPLOY C6 EDGE')-cne'DEPLOY C6 EDGE'){throw 'Operator cancelled.'}
  $orlPreviousPreference=$ErrorActionPreference
  $ErrorActionPreference='Continue'
  try{
    & $cli functions deploy ic-requests --project-ref $orlProjectRef --no-verify-jwt --workdir $root
    $orlDeployExit=$LASTEXITCODE
  }finally{$ErrorActionPreference=$orlPreviousPreference}
  if($orlDeployExit-ne0){throw 'Edge deployment failed or is uncertain.'}
  Write-Host 'SUCCESS: C6-capable Edge gateway deployed.' -ForegroundColor Green
}catch{Write-Host $_.Exception.Message -ForegroundColor Red;exit 1}
