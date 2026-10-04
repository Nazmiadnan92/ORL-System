$ErrorActionPreference='Stop'
$orlEndpoint='https://imrfmilqehcrvassuvuw.supabase.co/functions/v1/ic-requests'

function Invoke-OrlSmokePost([string]$SessionToken) {
  $orlRequest=New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post,$orlEndpoint)
  $orlRequest.Content=New-Object System.Net.Http.StringContent('{}',[Text.Encoding]::UTF8,'application/json')
  if($SessionToken){[void]$orlRequest.Headers.TryAddWithoutValidation('x-orl-session',$SessionToken)}
  $orlResponse=$script:orlClient.SendAsync($orlRequest).GetAwaiter().GetResult()
  $orlBody=$orlResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  try {$orlJson=$orlBody|ConvertFrom-Json}catch{throw 'Smoke response was not JSON.'}
  [pscustomobject]@{
    Status=[int]$orlResponse.StatusCode
    Error=[string]$orlJson.error
    Body=$orlBody
    ContentType=[string]$orlResponse.Content.Headers.ContentType.MediaType
    NoStore=[bool]$orlResponse.Headers.CacheControl.NoStore
    Nosniff=if($orlResponse.Headers.Contains('X-Content-Type-Options')){[string](@($orlResponse.Headers.GetValues('X-Content-Type-Options'))[0])}else{''}
  }
}

function Assert-OrlSafeResponse($Response,[int]$Status,[string]$Message) {
  if($Response.Status-ne $Status-or$Response.Error-ne $Message){throw "Unexpected Edge response: HTTP $($Response.Status). Keep the website OFF."}
  if($Response.ContentType-ne 'application/json'-or!$Response.NoStore-or$Response.Nosniff-ne 'nosniff'){throw 'Required no-store/JSON/nosniff response headers are missing.'}
  if($Response.Body.Length-gt 256-or$Response.Body-match '(?i)service[_-]?role|ORL_IC_|SUPABASE_SECRET|encryption[_-]?key|search[_-]?key|request_identity|session_hash'){
    throw 'Potential internal identifier or secret material appeared in a denial response.'
  }
}

try {
  Add-Type -AssemblyName System.Net.Http
  $script:orlClient=New-Object System.Net.Http.HttpClient
  $script:orlClient.Timeout=[TimeSpan]::FromSeconds(20)
  $orlMissing=Invoke-OrlSmokePost ''
  Assert-OrlSafeResponse $orlMissing 401 'Please sign in again.'
  $orlInvalid=Invoke-OrlSmokePost ([guid]::NewGuid().ToString())
  Assert-OrlSafeResponse $orlInvalid 403 'Session access denied.'
  Write-Host 'SUCCESS: enabled Edge denies missing/random sessions and returns sanitized no-store responses.' -ForegroundColor Green
} catch {Write-Host $_.Exception.Message -ForegroundColor Red;exit 1}
finally {if($script:orlClient){$script:orlClient.Dispose()}}
