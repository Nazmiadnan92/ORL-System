$ErrorActionPreference='Stop'
$orlEndpoint='https://imrfmilqehcrvassuvuw.supabase.co/functions/v1/ic-requests'
$orlSecure=$null
$orlBstr=[IntPtr]::Zero
$orlToken=''
$orlClient=$null

function Invoke-OrlRatePost {
  $orlRequest=New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post,$orlEndpoint)
  $orlRequest.Content=New-Object System.Net.Http.StringContent('{}',[Text.Encoding]::UTF8,'application/json')
  [void]$orlRequest.Headers.TryAddWithoutValidation('x-orl-session',$script:orlToken)
  $orlResponse=$script:orlClient.SendAsync($orlRequest).GetAwaiter().GetResult()
  $orlBody=$orlResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  try {$orlJson=$orlBody|ConvertFrom-Json}catch{throw 'Rate smoke response was not JSON.'}
  if($orlBody.Length-gt 256-or$orlBody-match '(?i)service[_-]?role|ORL_IC_|SUPABASE_SECRET|encryption[_-]?key|search[_-]?key|request_identity|session_hash'){
    throw 'Potential internal identifier or secret material appeared in a rate response.'
  }
  [pscustomobject]@{
    Status=[int]$orlResponse.StatusCode
    Error=[string]$orlJson.error
    RetryAfter=if($orlResponse.Headers.RetryAfter){[int]$orlResponse.Headers.RetryAfter.Delta.TotalSeconds}else{0}
  }
}

try {
  Add-Type -AssemblyName System.Net.Http
  $orlSecure=Read-Host 'Paste a CURRENT ORL session token locally (input hidden; never paste it into chat)' -AsSecureString
  $orlBstr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($orlSecure)
  $script:orlToken=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($orlBstr)
  $orlGuid=[guid]::Empty
  if(![guid]::TryParse($script:orlToken,[ref]$orlGuid)){throw 'The locally entered session token is not a UUID.'}

  $orlSecond=(Get-Date).Second
  if($orlSecond-gt 10){
    $orlWait=61-$orlSecond
    Write-Host "Waiting $orlWait second(s) for a clean fixed-minute rate window..." -ForegroundColor Yellow
    Start-Sleep -Seconds $orlWait
  }
  $orlMinute=(Get-Date).ToString('yyyyMMddHHmm')
  $script:orlClient=New-Object System.Net.Http.HttpClient
  $script:orlClient.Timeout=[TimeSpan]::FromSeconds(20)
  for($orlIndex=1;$orlIndex-le 31;$orlIndex++){
    $orlResult=Invoke-OrlRatePost
    if((Get-Date).ToString('yyyyMMddHHmm')-ne $orlMinute){throw 'Rate smoke crossed a minute boundary. Keep the website OFF and inspect before any retry.'}
    if($orlIndex-le 30){
      if($orlResult.Status-ne 400-or$orlResult.Error-ne 'Invalid or oversized protected request.'){
        throw "Request $orlIndex did not reach the safe empty-body rejection. Keep the website OFF."
      }
    } elseif($orlResult.Status-ne 429-or$orlResult.Error-ne 'Too many protected requests. Wait before trying again.'-or$orlResult.RetryAfter-ne 60){
      throw 'The 31st request did not return the reviewed 429/Retry-After contract. Keep the website OFF.'
    }
  }
  Write-Host 'SUCCESS: valid session accepted only to empty-body validation; shared rate contract was 30 allowed then HTTP 429.' -ForegroundColor Green
} catch {Write-Host $_.Exception.Message -ForegroundColor Red;exit 1}
finally {
  if($script:orlClient){$script:orlClient.Dispose()}
  $script:orlToken=''
  if($orlBstr-ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($orlBstr)}
  if($orlSecure){$orlSecure.Dispose()}
}
