$ErrorActionPreference='Stop'
$orlRoot=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$orlVersion='2.119.0'
$orlArchiveHash='DB4A6EC26D182408CA605EFC0D0D938720BD2D8D39541E79C7D69043897AFFB9'
$orlExeHash='971F439CC4B774F43181593551E0E34E29F399D5E82CBE3508E87537EC13E29F'
$orlDir=Join-Path $orlRoot ".tools\supabase-$orlVersion"
$orlArchive=Join-Path $orlDir "supabase_${orlVersion}_windows_amd64.zip"
$orlExe=Join-Path $orlDir 'supabase.exe'
$orlUri="https://github.com/supabase/cli/releases/download/v$orlVersion/supabase_${orlVersion}_windows_amd64.zip"

try {
  if(![Environment]::Is64BitOperatingSystem){throw 'This reviewed CLI package requires 64-bit Windows.'}
  New-Item -ItemType Directory -Force -Path $orlDir|Out-Null
  if(!(Test-Path -LiteralPath $orlArchive)-or((Get-FileHash -Algorithm SHA256 -LiteralPath $orlArchive).Hash-ne $orlArchiveHash)){
    Write-Host "Downloading official Supabase CLI $orlVersion..." -ForegroundColor Yellow
    Invoke-WebRequest -UseBasicParsing -Uri $orlUri -OutFile "$orlArchive.partial"
    if((Get-FileHash -Algorithm SHA256 -LiteralPath "$orlArchive.partial").Hash-ne $orlArchiveHash){
      throw 'Downloaded Supabase CLI archive hash mismatch. The partial file was retained for inspection.'
    }
    Move-Item -Force -LiteralPath "$orlArchive.partial" -Destination $orlArchive
  }
  Expand-Archive -LiteralPath $orlArchive -DestinationPath $orlDir -Force
  if((Get-FileHash -Algorithm SHA256 -LiteralPath $orlExe).Hash-ne $orlExeHash){throw 'Extracted Supabase CLI executable hash mismatch.'}
  $orlActual=((& $orlExe --version 2>$null)-join '').Trim()
  if(($LASTEXITCODE-ne 0)-or($orlActual-ne $orlVersion)){throw "Expected CLI $orlVersion; found '$orlActual'."}
  Write-Host "SUCCESS: pinned Supabase CLI $orlActual is ready." -ForegroundColor Green
} catch {Write-Host $_.Exception.Message -ForegroundColor Red;exit 1}
