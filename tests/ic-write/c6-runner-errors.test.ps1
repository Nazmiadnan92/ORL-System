$ErrorActionPreference='Stop'
$orlPath=Join-Path $PSScriptRoot '..\..\security\release\run-c6.ps1'
$orlTokens=$null;$orlErrors=$null
$orlAst=[Management.Automation.Language.Parser]::ParseFile((Resolve-Path $orlPath),[ref]$orlTokens,[ref]$orlErrors)
if($orlErrors.Count){throw 'Runner syntax failed'}
$orlCall=$orlAst.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name-eq'Call'},$true)
Invoke-Expression $orlCall.Extent.Text
$endpoint='https://example.invalid';$token='SYNTHETIC_SESSION'
function Invoke-RestMethod {
  $orlException=New-Object System.Exception 'SYNTHETIC_SECRET_MUST_NOT_APPEAR'
  if($script:orlHttp){
    $orlResponse=[pscustomobject]@{StatusCode=$script:orlHttp;Body=$script:orlBody}
    $orlResponse|Add-Member ScriptMethod GetResponseStream {New-Object IO.MemoryStream(,[Text.Encoding]::UTF8.GetBytes($this.Body))}
    $orlException|Add-Member NoteProperty Response $orlResponse
  }
  $orlRecord=New-Object Management.Automation.ErrorRecord($orlException,'Mock','NotSpecified',$null)
  if(!$script:orlStreamOnly){$orlRecord.ErrorDetails=New-Object Management.Automation.ErrorDetails($script:orlBody)}
  throw $orlRecord
}
$orlChecks=0
foreach($orlStreamOnly in @($false,$true)){
foreach($orlCase in @(
  @{Http=403;Body='{"error":"Session access denied."}';Expected='Session expired or access denied'},
  @{Http=503;Body='{"error":"C6 status unavailable."}';Expected='website password or server configuration'},
  @{Http=500;Body='{"error":"SYNTHETIC_SECRET_MUST_NOT_APPEAR"}';Expected='Unclassified protected service error'},
  @{Http=0;Body='';Expected='Network/TLS connection failed'}
)){
  $script:orlHttp=$orlCase.Http;$script:orlBody=$orlCase.Body
  $orlCaught=$null
  try{Call @{operation='C6_STATUS';password='SYNTHETIC_PASSWORD'}|Out-Null}catch{$orlCaught=$_.Exception.Message}
  if(!$orlCaught -or !$orlCaught.Contains($orlCase.Expected) -or !$orlCaught.Contains('No cutover was attempted') -or $orlCaught.Contains('SYNTHETIC_')){throw 'Sanitized status error check failed'}
  $orlChecks++
}
}
$script:orlHttp=503;$script:orlBody='{}';$orlCaught=$null
try{Call @{operation='C6_CUTOVER';password='SYNTHETIC_PASSWORD'}|Out-Null}catch{$orlCaught=$_.Exception.Message}
if(!$orlCaught.Contains('Stop and inspect status') -or $orlCaught.Contains('No cutover was attempted')){throw 'Uncertain cutover error check failed'}
Write-Output "PASS: $($orlChecks+1) offline error-handling checks; no network or production calls."
