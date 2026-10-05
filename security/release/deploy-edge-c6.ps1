$ErrorActionPreference='Stop';$root=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path;$project='imrfmilqehcrvassuvuw';$version='2.119.0'
$cli=Join-Path $root ".tools\supabase-$version\supabase.exe";$cliHash='971F439CC4B774F43181593551E0E34E29F399D5E82CBE3508E87537EC13E29F'
function Hash([string]$p){(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash}
try{
  if(!(Test-Path $cli)-or(Hash $cli)-ne$cliHash-or((& $cli --version 2>$null)-join'').Trim()-ne$version){throw 'Pinned Supabase CLI unavailable or changed.'}
  $projects=@(((& $cli projects list --output json 2>$null)-join[Environment]::NewLine)|ConvertFrom-Json)
  if(@($projects|Where-Object{[string]$_.id-eq$project-or[string]$_.ref-eq$project}).Count-ne1){throw 'Exact production project access unavailable.'}
  Write-Host "Exact project confirmed: $project" -ForegroundColor Yellow
  Write-Host 'Existing IC keys and enable flag are reused; their values are not read or changed.'
  if((Read-Host 'Type DEPLOY C6 EDGE')-cne'DEPLOY C6 EDGE'){throw 'Operator cancelled.'}
  & $cli functions deploy ic-requests --project-ref $project --no-verify-jwt --workdir $root
  if($LASTEXITCODE-ne0){throw 'Edge deployment failed or is uncertain.'}
  Write-Host 'SUCCESS: C6-capable Edge gateway deployed.' -ForegroundColor Green
}catch{Write-Host $_.Exception.Message -ForegroundColor Red;exit 1}
