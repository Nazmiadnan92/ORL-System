#Requires -Version 7.4
param([switch]$SelfTest,[switch]$PublicOnly)
$ErrorActionPreference='Stop'
$orlSite='https://nazmiadnan92.github.io/ORL-System'
$orlBase='https://imrfmilqehcrvassuvuw.supabase.co'
$orlConfigPath=Join-Path $PSScriptRoot '..\..\docs\config.js'
$orlPrivateReports=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ORL-Private-Backups'
$orlClient=$null;$orlSession=$null;$orlPublicKey=$null;$orlPassword=$null;$orlLoginBody=$null

function Send-OrlRequest([string]$Method,[string]$Url,[hashtable]$Headers=@{},[AllowNull()][string]$Json=$null){
  $request=[Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::$Method,$Url)
  $response=$null
  try{
    foreach($entry in $Headers.GetEnumerator()){[void]$request.Headers.TryAddWithoutValidation($entry.Key,[string]$entry.Value)}
    if($PSBoundParameters.ContainsKey('Json') -and $null-ne$Json){$request.Content=[Net.Http.StringContent]::new($Json,[Text.Encoding]::UTF8,'application/json')}
    $response=$orlClient.SendAsync($request).GetAwaiter().GetResult()
    $text=$response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    [pscustomobject]@{Status=[int]$response.StatusCode;Text=$text;ContentType=[string]$response.Content.Headers.ContentType.MediaType;
      NoStore=[bool]$response.Headers.CacheControl.NoStore;Nosniff=if($response.Headers.Contains('X-Content-Type-Options')){[string](@($response.Headers.GetValues('X-Content-Type-Options'))[0])}else{''}}
  }finally{if($response){$response.Dispose()};$request.Dispose()}
}

function Invoke-OrlRpc([string]$Name,[hashtable]$Arguments){
  if($Name -notin @('orl_login','orl_logout','orl_get_dashboard','orl_get_schedule','orl_get_requests','orl_get_postponed',
      'orl_get_deletions','orl_get_audit','orl_get_settings','orl_get_account_settings','orl_list_holidays','orl_db_overview')){
    throw 'C5 RPC is not on the read-only allowlist.'
  }
  $result=Send-OrlRequest Post "$orlBase/rest/v1/rpc/$Name" @{apikey=$orlPublicKey} ($Arguments|ConvertTo-Json -Compress -Depth 8)
  if($result.Status-lt200 -or $result.Status-ge300){throw "C5 read failed at $Name (HTTP $($result.Status))."}
  if([string]::IsNullOrWhiteSpace($result.Text)){return $null}
  return $result.Text|ConvertFrom-Json -NoEnumerate
}

function Assert-OrlMaskedIdentity([AllowNull()]$Value,[string]$Path){
  if($null-eq$Value -or [string]::IsNullOrEmpty([string]$Value)){return 0}
  $text=[string]$Value
  if($text -notmatch '^(?:[0-9]{6}-\*{2}-\*{4}|\*{4,8}[A-Za-z0-9]{4}|\*{4})$'){
    throw "Unmasked or malformed patient identity at $Path."
  }
  return 1
}

function Test-OrlMaskedTree($Value,[string]$Path='$'){
  $count=0
  if($null-eq$Value){return 0}
  if($Value -is [Collections.IDictionary]){
    foreach($key in $Value.Keys){
      $child=$Value[$key];$next="$Path.$key"
      if([string]$key-ceq'patient_ic'){$count+=Assert-OrlMaskedIdentity $child $next}
      else{$count+=Test-OrlMaskedTree $child $next}
    }
  }elseif($Value -is [Management.Automation.PSCustomObject]){
    foreach($property in $Value.PSObject.Properties){
      $next="$Path.$($property.Name)"
      if($property.Name-ceq'patient_ic'){$count+=Assert-OrlMaskedIdentity $property.Value $next}
      else{$count+=Test-OrlMaskedTree $property.Value $next}
    }
  }elseif($Value -is [Collections.IEnumerable] -and $Value -isnot[string]){
    $index=0;foreach($child in $Value){$count+=Test-OrlMaskedTree $child "$Path[$index]";$index++}
  }
  return $count
}

function Test-OrlPublicSurface {
  $assets=[ordered]@{
    'index'="$orlSite/";'config'="$orlSite/config.js?v=025";'app'="$orlSite/app.js?v=075";
    'ic-client'="$orlSite/ic-client.mjs?v=075";'css'="$orlSite/styles.css?v=071";
    'clinical'="$orlSite/clinical-features.js?v=061";'excel'="$orlSite/ot-excel.js?v=066"
  }
  $content=@{}
  foreach($item in $assets.GetEnumerator()){
    $response=Send-OrlRequest Get $item.Value
    if($response.Status-ne200 -or [string]::IsNullOrWhiteSpace($response.Text)){throw "Live asset unavailable: $($item.Key)."}
    $content[$item.Key]=$response.Text
  }
  if($content.index -notmatch 'config\.js\?v=025' -or $content.index -notmatch 'app\.js\?v=075' -or
     $content.index -notmatch 'styles\.css\?v=071' -or $content.index -notmatch 'clinical-features\.js\?v=061' -or
     $content.index -notmatch 'ot-excel\.js\?v=066'){
    throw 'Live index cache versions do not match the reviewed release.'
  }
  if($content.config -notmatch 'icProtectionEnabled:\s*true' -or
     $content.config -match '(?im)^\s*(?:serviceRoleKey|supabaseServiceRole|service_role_key)\s*[:=]'){
    throw 'Live public configuration is unsafe or protection is disabled.'
  }
  if($content.app -notmatch "ic-client\.mjs\?v=075" -or $content.app -notmatch 'maskPatientIc' -or
     $content.app -notmatch "user\.role==='WEBMASTER'" -or $content.app -notmatch "\['ADMIN','WEBMASTER'\]\.includes\(user\.role\)"){
    throw 'Live application bundle is missing reviewed role/masking controls.'
  }
  $missing=Send-OrlRequest Post "$orlBase/functions/v1/ic-requests" @{} '{}'
  $random=Send-OrlRequest Post "$orlBase/functions/v1/ic-requests" @{'x-orl-session'=[guid]::NewGuid().ToString()} '{}'
  foreach($check in @(@($missing,401,'Please sign in again.'),@($random,403,'Session access denied.'))){
    $json=$check[0].Text|ConvertFrom-Json
    if($check[0].Status-ne$check[1] -or $json.error-cne$check[2] -or -not$check[0].NoStore -or $check[0].Nosniff-cne'nosniff'){
      throw 'Live Edge denial/header observation failed.'
    }
  }
}

function Test-OrlC5Self {
  $valid=[pscustomobject]@{patient_ic='010203-**-****';nested=@([pscustomobject]@{patient_ic='********CRET'},[pscustomobject]@{patient_ic=''})}
  if((Test-OrlMaskedTree $valid)-ne2){throw 'Masked-tree self-test count failed.'}
  $rejected=$false;try{Test-OrlMaskedTree ([pscustomobject]@{patient_ic='010203-04-5678'})|Out-Null}catch{$rejected=$true}
  if(-not$rejected){throw 'Full IC was accepted by C5 self-test.'}
  Write-Host 'PASS: C5 mask observer self-test.'
}

try{
  if($SelfTest){Test-OrlC5Self;exit 0}
  Add-Type -AssemblyName System.Net.Http
  $handler=[Net.Http.HttpClientHandler]::new();$handler.AllowAutoRedirect=$false
  $orlClient=[Net.Http.HttpClient]::new($handler);$orlClient.Timeout=[TimeSpan]::FromSeconds(30)
  $config=[IO.File]::ReadAllText([IO.Path]::GetFullPath($orlConfigPath))
  $match=[regex]::Match($config,"supabaseAnonKey\s*:\s*'([^']+)'")
  if(-not$match.Success -or $match.Groups[1].Value-notmatch'^sb_publishable_[A-Za-z0-9_-]+$'){throw 'Reviewed publishable key missing.'}
  $orlPublicKey=$match.Groups[1].Value
  Write-Host 'C5 STEP 1/2: observing live site assets, protection gate and safe denials.' -ForegroundColor Yellow
  Test-OrlPublicSurface
  if($PublicOnly){Write-Host 'SUCCESS: C5 public observation passed. Authenticated read-only observation remains.' -ForegroundColor Green;exit 0}

  Write-Host 'C5 STEP 2/2: temporary website login and read-only workflow observation.' -ForegroundColor Yellow
  Write-Host 'No patient is created, edited, assigned, postponed, cancelled, revealed or deleted.'
  $username=Read-Host 'ORL WEBSITE username'
  $secure=Read-Host 'ORL WEBSITE password (hidden)' -AsSecureString
  try{$orlPassword=[Net.NetworkCredential]::new('',$secure).Password}finally{$secure.Dispose()}
  if([string]::IsNullOrWhiteSpace($username)-or[string]::IsNullOrEmpty($orlPassword)){throw 'Empty website login.'}
  $orlLoginBody=@{p_username=$username.Trim();p_password=$orlPassword}|ConvertTo-Json -Compress
  $login=Invoke-OrlRpc 'orl_login' @{p_username=$username.Trim();p_password=$orlPassword}
  $orlPassword=$null;$orlLoginBody=$null
  $account=@($login)[0];$orlSession=[string]$account.session_token
  if($orlSession-notmatch'^[0-9a-fA-F-]{36}$' -or $account.must_change_password-ne$false -or
     $account.role-notin@('STAFF','ADMIN','WEBMASTER')){throw 'Login response is unavailable or requires password change.'}

  $today=[TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTimeOffset]::UtcNow,'Singapore Standard Time')
  $reads=[ordered]@{}
  $reads.dashboard=Invoke-OrlRpc 'orl_get_dashboard' @{p_session_token=$orlSession}
  $reads.schedule=Invoke-OrlRpc 'orl_get_schedule' @{p_session_token=$orlSession;p_year=$today.Year;p_month=$today.Month}
  $reads.requests=Invoke-OrlRpc 'orl_get_requests' @{p_session_token=$orlSession}
  $reads.postponed=Invoke-OrlRpc 'orl_get_postponed' @{p_session_token=$orlSession}
  $reads.deletions=Invoke-OrlRpc 'orl_get_deletions' @{p_session_token=$orlSession}
  $reads.holidays=Invoke-OrlRpc 'orl_list_holidays' @{p_session_token=$orlSession}
  $reads.account=Invoke-OrlRpc 'orl_get_account_settings' @{p_session_token=$orlSession}
  if($account.role-in@('ADMIN','WEBMASTER')){$reads.settings=Invoke-OrlRpc 'orl_get_settings' @{p_session_token=$orlSession}}
  if($account.role-ceq'WEBMASTER'){
    $reads.audit=Invoke-OrlRpc 'orl_get_audit' @{p_session_token=$orlSession;p_search=''}
    $reads.database=Invoke-OrlRpc 'orl_db_overview' @{p_session_token=$orlSession}
  }
  if($null-eq$reads.dashboard -or @($reads.schedule).Count-eq0 -or $null-eq$reads.requests){throw 'Core live read returned no usable structure.'}
  if($account.role-ceq'STAFF'){
    $special=@($reads.schedule|ForEach-Object{$_.slots}|ForEach-Object{$_}|Where-Object{$_.type-ceq'SPECIAL'})
    if($special.Count-ne0){throw 'Staff schedule exposed Special slots.'}
  }
  $masked=0;foreach($entry in $reads.GetEnumerator()){$masked+=Test-OrlMaskedTree $entry.Value "`$.$($entry.Key)"}
  if($masked-le0){throw 'No populated masked identity was observed; C5 cannot verify masking.'}
  $logout=Invoke-OrlRpc 'orl_logout' @{p_session_token=$orlSession};$orlSession=$null
  New-Item -ItemType Directory -Force -Path $orlPrivateReports|Out-Null
  $stamp=Get-Date -Format 'yyyyMMdd-HHmmss';$report=Join-Path $orlPrivateReports "ORL-C5-observation-$stamp.json"
  [ordered]@{format='ORL-C5-SANITIZED-REPORT';version=1;completed_at=(Get-Date).ToUniversalTime().ToString('o');
    role=$account.role;public_assets=$true;edge_denials=$true;core_reads=$true;masked_identity_fields=$masked;
    patient_mutations=0;reveal_operations=0;temporary_session_logged_out=$true}|ConvertTo-Json|Set-Content -LiteralPath $report -Encoding utf8NoBOM
  Write-Host "SUCCESS: C5 live observation passed; $masked masked identity fields checked." -ForegroundColor Green
  Write-Host "Sanitized private report: $report"
}catch{
  Write-Host ('STOP: '+$_.Exception.Message) -ForegroundColor Red
  Write-Host 'No patient workflow action was selected. Do not retry login repeatedly.'
  exit 1
}finally{
  if($orlSession-and$orlClient-and$orlPublicKey){
    try{$null=Invoke-OrlRpc 'orl_logout' @{p_session_token=$orlSession}}catch{Write-Host 'WARNING: temporary-session logout unconfirmed.' -ForegroundColor Yellow}
  }
  if($orlClient){$orlClient.Dispose()}
  $orlSession=$null;$orlPassword=$null;$orlLoginBody=$null;$username=$null;$reads=$null;$account=$null;$login=$null
}
