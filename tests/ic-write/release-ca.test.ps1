$ErrorActionPreference='Stop'
$orlRelease=(Resolve-Path (Join-Path $PSScriptRoot '..\..\security\release')).Path
$orlCa=(Resolve-Path (Join-Path $PSScriptRoot '..\..\..\ic-encryption-package-b\certs\supabase-prod-ca-2021.crt')).Path
$orlExpected='807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'
$orlTemp=Join-Path ([IO.Path]::GetTempPath()) ('orl-c1-ca-'+[guid]::NewGuid().ToString('N'))
$orlCrlf=Join-Path $orlTemp 'reviewed-crlf.crt'
$orlChanged=Join-Path $orlTemp 'altered.crt'
. (Join-Path $orlRelease 'Test-OrlReviewedCa.ps1')
New-Item -ItemType Directory -Path $orlTemp | Out-Null
try {
  Test-OrlReviewedCa -Path $orlCa -ExpectedDerSha256 $orlExpected
  $orlPem=[IO.File]::ReadAllText($orlCa).Replace("`r`n","`n").Replace("`r","`n")
  [IO.File]::WriteAllText($orlCrlf,$orlPem.Replace("`n","`r`n"),[Text.UTF8Encoding]::new($false))
  Test-OrlReviewedCa -Path $orlCrlf -ExpectedDerSha256 $orlExpected
  $orlLines=$orlPem.Split("`n")
  $orlBodyIndex=1
  if($orlLines[$orlBodyIndex].StartsWith('M')){$orlLines[$orlBodyIndex]='N'+$orlLines[$orlBodyIndex].Substring(1)}else{$orlLines[$orlBodyIndex]='M'+$orlLines[$orlBodyIndex].Substring(1)}
  [IO.File]::WriteAllText($orlChanged,($orlLines-join "`n"),[Text.UTF8Encoding]::new($false))
  $orlRejected=$false
  try { Test-OrlReviewedCa -Path $orlChanged -ExpectedDerSha256 $orlExpected }
  catch { $orlRejected=$true }
  if(!$orlRejected){throw 'Altered certificate was not rejected.'}
  Write-Output 'PASS: CA pin uses certificate DER, tolerates PEM line-ending changes, checks validity and rejects altered certificate data.'
} finally {
  if(Test-Path -LiteralPath $orlTemp){Remove-Item -LiteralPath $orlTemp -Recurse -Force}
}
