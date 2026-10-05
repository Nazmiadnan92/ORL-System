#Requires -Version 7.4
param([switch]$SelfTest,[switch]$LocalStructureOnly)
$ErrorActionPreference='Stop'

$orlProject='imrfmilqehcrvassuvuw'
$orlContext=$orlProject
$orlIterations=600000
$orlBin='C:\Program Files\PostgreSQL\18\bin'
$orlRepo=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$orlCa=Join-Path $orlRepo '..\ic-encryption-package-b\certs\supabase-prod-ca-2021.crt'
$orlKeyFile=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) "ORL-Private-Keys\$orlProject\ORL-IC-Keys-v1.recovery.json"
$orlBackupDir=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ORL-Private-Backups'
$orlLocalRoot=Join-Path $orlRepo '.local-postgres'
$orlRun=Join-Path $orlLocalRoot ('c4-'+[guid]::NewGuid().ToString('N'))
$orlData=Join-Path $orlRun 'data'
$orlStarted=$false
$orlOldPassword=$env:PGPASSWORD
$orlOldOptions=$env:PGOPTIONS

function Read-PrivatePassword([string]$Prompt) {
  $secure=Read-Host $Prompt -AsSecureString
  try { return [Net.NetworkCredential]::new('',$secure).Password }
  finally { $secure.Dispose() }
}

function Stop-OrlC4LocalRestore {
  if(Test-Path -LiteralPath (Join-Path $orlData 'postmaster.pid')){
    & (Join-Path $orlBin 'pg_ctl.exe') -D $orlData -m fast -w stop|Out-Null
    if($LASTEXITCODE-ne0){throw 'Temporary local database shutdown failed; private files retained.'}
  }
  $script:orlStarted=$false
  if(Test-Path -LiteralPath $orlRun){
    $candidate=[IO.Path]::GetFullPath($orlRun)
    if(-not $candidate.StartsWith($orlResolvedRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or
       [IO.Path]::GetFileName($candidate) -notmatch '^c4-[0-9a-f]{32}$'){
      throw 'Temporary restore cleanup path validation failed.'
    }
    Remove-Item -LiteralPath $candidate -Recurse -Force
    if(Test-Path -LiteralPath $candidate){throw 'Temporary restore cleanup incomplete.'}
  }
}

function ConvertFrom-OrlRecovery([string]$Envelope,[string]$Password) {
  if($Envelope.Length -gt 16384){throw 'Invalid recovery archive size.'}
  $e=$Envelope|ConvertFrom-Json
  if($e.format -cne 'ORL-KEY-RECOVERY' -or $e.version -ne 1 -or $e.context -cne $orlContext -or
     $e.cipher -cne 'AES-256-GCM' -or $e.kdf -cne 'PBKDF2-SHA256' -or $e.iterations -ne $orlIterations){
    throw 'Unsupported recovery archive metadata.'
  }
  $salt=[Convert]::FromBase64String($e.salt);$nonce=[Convert]::FromBase64String($e.nonce)
  $tag=[Convert]::FromBase64String($e.tag);$cipher=[Convert]::FromBase64String($e.ciphertext)
  if($salt.Length-ne16 -or $nonce.Length-ne12 -or $tag.Length-ne16 -or $cipher.Length-eq0){throw 'Invalid recovery archive data.'}
  $key=[Security.Cryptography.Rfc2898DeriveBytes]::Pbkdf2($Password,$salt,$orlIterations,[Security.Cryptography.HashAlgorithmName]::SHA256,32)
  $plain=[byte[]]::new($cipher.Length);$aad=[Text.Encoding]::UTF8.GetBytes("ORL-KEY-RECOVERY|1|$orlContext")
  $aes=[Security.Cryptography.AesGcm]::new($key,16)
  try{$aes.Decrypt($nonce,$cipher,$tag,$plain,$aad);return [Text.Encoding]::UTF8.GetString($plain)}
  finally{$aes.Dispose();[Security.Cryptography.CryptographicOperations]::ZeroMemory($key);[Security.Cryptography.CryptographicOperations]::ZeroMemory($plain)}
}

function Test-OrlIdentityRows([string[]]$Rows,[string]$PayloadJson) {
  $payload=$PayloadJson|ConvertFrom-Json
  if($payload.context-cne$orlContext -or $payload.encryptionKeyId-cne'enc-v1' -or $payload.searchKeyId-cne'search-v1'){
    throw 'Recovery key metadata mismatch.'
  }
  $enc=[Convert]::FromBase64String($payload.encryptionKey);$search=[Convert]::FromBase64String($payload.searchKey)
  if($enc.Length-ne32 -or $search.Length-ne32 -or
     [Security.Cryptography.CryptographicOperations]::FixedTimeEquals($enc,$search)){throw 'Recovery key material is invalid.'}
  $verified=0
  try{
    foreach($line in $Rows){
      if([string]::IsNullOrWhiteSpace($line)){continue}
      $row=$line|ConvertFrom-Json
      if($row.request_id -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or
         $row.encryption_key_id-cne$payload.encryptionKeyId -or $row.search_key_id-cne$payload.searchKeyId){throw 'Restored identity metadata mismatch.'}
      $rawBytes=[Convert]::FromBase64String(($row.patient_ic_b64-replace "`r|`n",''))
      $nonce=[Convert]::FromBase64String(($row.nonce-replace "`r|`n",''))
      $combined=[Convert]::FromBase64String(($row.ciphertext-replace "`r|`n",''))
      $expectedHash=[Convert]::FromBase64String(($row.search_hash-replace "`r|`n",''))
      if($nonce.Length-ne12 -or $combined.Length-lt17 -or $expectedHash.Length-ne32){throw 'Restored identity envelope is invalid.'}
      $cipher=[byte[]]::new($combined.Length-16);$tag=[byte[]]::new(16)
      [Array]::Copy($combined,0,$cipher,0,$cipher.Length);[Array]::Copy($combined,$cipher.Length,$tag,0,16)
      $plain=[byte[]]::new($cipher.Length)
      $aadJson=@('ORL_IC',1,$orlContext,$row.request_id.ToLowerInvariant(),$row.encryption_key_id)|ConvertTo-Json -Compress
      $aad=[Text.Encoding]::UTF8.GetBytes($aadJson);$aes=[Security.Cryptography.AesGcm]::new($enc,16)
      try{$aes.Decrypt($nonce,$cipher,$tag,$plain,$aad)}finally{$aes.Dispose()}
      try{
        if(-not [Security.Cryptography.CryptographicOperations]::FixedTimeEquals($plain,$rawBytes)){throw 'Restored encrypted identity does not match its retained source.'}
        $raw=[Text.Encoding]::UTF8.GetString($rawBytes)
        if($raw.Length-lt1 -or $raw.Length-gt128 -or $raw -notmatch '^[\x20-\x7E]+$'){throw 'Restored identity format is unsupported.'}
        $normalized=($raw.ToLowerInvariant()-replace'[^a-z0-9]','')
        if(-not $normalized){throw 'Restored normalized identity is empty.'}
        $messageJson=@('ORL_IC_SEARCH',1,$orlContext,$normalized)|ConvertTo-Json -Compress
        $hmac=[Security.Cryptography.HMACSHA256]::new($search)
        try{$actualHash=$hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($messageJson))}finally{$hmac.Dispose()}
        if(-not [Security.Cryptography.CryptographicOperations]::FixedTimeEquals($actualHash,$expectedHash)){throw 'Restored identity search hash mismatch.'}
        $verified++
      }finally{
        [Security.Cryptography.CryptographicOperations]::ZeroMemory($rawBytes)
        [Security.Cryptography.CryptographicOperations]::ZeroMemory($plain)
        [Security.Cryptography.CryptographicOperations]::ZeroMemory($cipher)
        [Security.Cryptography.CryptographicOperations]::ZeroMemory($combined)
      }
    }
    return $verified
  }finally{
    [Security.Cryptography.CryptographicOperations]::ZeroMemory($enc)
    [Security.Cryptography.CryptographicOperations]::ZeroMemory($search)
  }
}

function Test-C4SyntheticCrypto {
  $enc=[Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
  $search=[Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
  $raw='000101-00-0000';$request='11111111-1111-4111-8111-111111111111'
  $nonce=[Security.Cryptography.RandomNumberGenerator]::GetBytes(12)
  $plain=[Text.Encoding]::UTF8.GetBytes($raw);$cipher=[byte[]]::new($plain.Length);$tag=[byte[]]::new(16)
  $aad=[Text.Encoding]::UTF8.GetBytes((@('ORL_IC',1,$orlContext,$request,'enc-v1')|ConvertTo-Json -Compress))
  $aes=[Security.Cryptography.AesGcm]::new($enc,16)
  try{$aes.Encrypt($nonce,$plain,$cipher,$tag,$aad)}finally{$aes.Dispose()}
  $combined=$cipher+$tag
  $normalized=$raw.ToLowerInvariant()-replace'[^a-z0-9]',''
  $hmac=[Security.Cryptography.HMACSHA256]::new($search)
  try{$hash=$hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes((@('ORL_IC_SEARCH',1,$orlContext,$normalized)|ConvertTo-Json -Compress)))}finally{$hmac.Dispose()}
  $row=[ordered]@{request_id=$request;patient_ic_b64=[Convert]::ToBase64String($plain);encryption_key_id='enc-v1';nonce=[Convert]::ToBase64String($nonce);ciphertext=[Convert]::ToBase64String($combined);search_key_id='search-v1';search_hash=[Convert]::ToBase64String($hash)}|ConvertTo-Json -Compress
  $payload=[ordered]@{context=$orlContext;encryptionKeyId='enc-v1';searchKeyId='search-v1';encryptionKey=[Convert]::ToBase64String($enc);searchKey=[Convert]::ToBase64String($search)}|ConvertTo-Json -Compress
  if((Test-OrlIdentityRows @($row) $payload)-ne1){throw 'Synthetic C4 crypto verification failed.'}
  [Security.Cryptography.CryptographicOperations]::ZeroMemory($enc);[Security.Cryptography.CryptographicOperations]::ZeroMemory($search)
  Write-Output 'PASS: C4 synthetic restore/key algorithm verified without production data or keys.'
}

if($SelfTest){Test-C4SyntheticCrypto;exit 0}
if(-not $IsWindows){throw 'Run C4 verification on the authorized Windows PC.'}
foreach($exe in @('initdb.exe','pg_ctl.exe','psql.exe','pg_dump.exe','pg_restore.exe')){
  if(-not(Test-Path -LiteralPath (Join-Path $orlBin $exe) -PathType Leaf)){throw "PostgreSQL tool missing: $exe"}
}
if(-not(Test-Path -LiteralPath $orlKeyFile -PathType Leaf)){throw 'Encrypted recovery-key archive is missing.'}
if(-not(Test-Path -LiteralPath $orlCa -PathType Leaf)){throw 'Reviewed Supabase CA file is missing.'}

$orlResolvedRoot=[IO.Path]::GetFullPath($orlLocalRoot)
$orlResolvedRun=[IO.Path]::GetFullPath($orlRun)
if(-not $orlResolvedRun.StartsWith($orlResolvedRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){
  throw 'Unsafe temporary restore path.'
}

$stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
$orlBackup=Join-Path $orlBackupDir "ORL-C4-verified-$stamp.dump"
$orlPartial="$orlBackup.partial"
$orlReport=Join-Path $orlBackupDir "ORL-C4-report-$stamp.json"
$orlConnection=$null;$orlRows=$null;$orlPayload=$null;$orlRecoveryPassword=$null;$orlDatabasePassword=$null
try{
  if($LocalStructureOnly){
    $orlPartial=(Get-ChildItem -LiteralPath $orlBackupDir -Filter 'ORL-C4-verified-*.dump.partial' | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
    if(-not $orlPartial){throw 'No existing C4 archive available for local diagnosis.'}
    Write-Host 'LOCAL STRUCTURE DIAGNOSIS ONLY: existing archive; no production connection or keys.'
  }else{
  . (Join-Path $PSScriptRoot 'Test-OrlReviewedCa.ps1')
  Test-OrlReviewedCa -Path $orlCa -ExpectedDerSha256 '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'
  $caParameter=$orlCa.Replace('\','/').Replace("'","\'")
  $orlConnection="host=aws-0-ap-southeast-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.$orlProject sslmode=verify-full sslrootcert='$caParameter' connect_timeout=20"
  Write-Host 'PACKAGE C4: read-only production preflight, private full backup and isolated local restore.' -ForegroundColor Yellow
  Write-Host 'No production Restore is run. No IC or key value is printed.'
  $orlDatabasePassword=Read-PrivatePassword 'Enter DATABASE password privately (hidden)'
  if([string]::IsNullOrEmpty($orlDatabasePassword)){throw 'Database password was empty.'}
  $env:PGPASSWORD=$orlDatabasePassword
  $statusSql=@"
begin read only;
select jsonb_build_object(
 'requests',(select count(*) from public.orl_requests),
 'nonblank',(select count(*) from public.orl_requests where trim(coalesce(patient_ic,''))<>''),
 'identities',(select count(*) from orl_private.request_identity),
 'blank',(select count(*) from public.orl_requests where trim(coalesce(patient_ic,''))=''),
 'audit',(select count(*) from public.orl_audit_log),
 'recovery_ready',orl_private.c1_recovery_ready(),
 'c2_complete',(orl_private.c2_stats()->>'complete')::boolean,
 'c2_finalized',exists(select 1 from orl_private.c2_verification_runs where completed_at is not null),
 'c3_ready',to_regprocedure('public.orl_ic_c3_reveal_view(uuid,text,uuid,text,uuid)') is not null
   and to_regprocedure('public.orl_ic_c3_reveal_commit(uuid,text,uuid,uuid,uuid,timestamptz)') is not null
);
rollback;
"@
  $statusText=(& (Join-Path $orlBin 'psql.exe') -X --dbname=$orlConnection --no-password -v ON_ERROR_STOP=1 -Atc $statusSql)
  if($LASTEXITCODE-ne0 -or -not$statusText){throw 'Production read-only C4 preflight failed.'}
  $status=($statusText|Where-Object{$_ -match '^\{' }|Select-Object -Last 1)|ConvertFrom-Json
  if(-not$status.recovery_ready -or -not$status.c2_complete -or -not$status.c2_finalized -or -not$status.c3_ready -or
     [int]$status.identities-le0 -or [int]$status.identities-ne[int]$status.nonblank -or
     [int]$status.requests-ne([int]$status.identities+[int]$status.blank)){
    throw 'Production protected-workflow inventory is inconsistent. Backup was not started.'
  }
  New-Item -ItemType Directory -Force -Path $orlBackupDir|Out-Null
  Write-Host 'Creating a fresh full private production backup (read-only)...'
  & (Join-Path $orlBin 'pg_dump.exe') --dbname=$orlConnection --format=custom --file=$orlPartial --no-password
  if($LASTEXITCODE-ne0){throw 'Private C4 backup failed.'}
  & (Join-Path $orlBin 'pg_restore.exe') --list $orlPartial|Out-Null
  if($LASTEXITCODE-ne0){throw 'Private C4 archive structure check failed.'}
  $env:PGPASSWORD=$null;$orlDatabasePassword=$null

  Write-Host 'Verifying the separately held encrypted recovery key...'
  $orlRecoveryPassword=Read-PrivatePassword 'Enter KEY RECOVERY passphrase privately (hidden; not database password)'
  if([string]::IsNullOrEmpty($orlRecoveryPassword)){throw 'Recovery passphrase was empty.'}
  $orlPayload=ConvertFrom-OrlRecovery ([IO.File]::ReadAllText($orlKeyFile)) $orlRecoveryPassword
  $orlRecoveryPassword=$null
  }

  New-Item -ItemType Directory -Path $orlRun -Force|Out-Null
  & (Join-Path $orlBin 'initdb.exe') -D $orlData -U orl_c4_owner --auth=trust --encoding=UTF8 --locale=C|Out-Null
  if($LASTEXITCODE-ne0){throw 'Isolated local restore database initialization failed.'}
  $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);$listener.Start();$port=$listener.LocalEndpoint.Port;$listener.Stop()
  $launchArgs=@('-D',('"'+$orlData+'"'),'-l',('"'+(Join-Path $orlRun 'server.log')+'"'),'-o',('"-h 127.0.0.1 -p '+$port+' -c autovacuum=off"'),'-w','start')
  $launcher=Start-Process -FilePath (Join-Path $orlBin 'pg_ctl.exe') -ArgumentList $launchArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $orlRun 'launch.out') -RedirectStandardError (Join-Path $orlRun 'launch.err')
  if(-not$launcher.WaitForExit(30000)){throw 'Isolated local database start timed out.'}
  $launcher.Refresh()
  if($launcher.ExitCode-ne0){&(Join-Path $orlBin 'pg_ctl.exe') -D $orlData status|Out-Null;if($LASTEXITCODE-ne0){throw 'Isolated local database start failed.'}}
  $orlStarted=$true
  $local=@('-X','-h','127.0.0.1','-p',[string]$port,'-U','orl_c4_owner','-d','postgres','-v','ON_ERROR_STOP=1')
  & (Join-Path $orlBin 'psql.exe') @local -c 'CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE ROLE postgres NOLOGIN;CREATE ROLE supabase_admin NOLOGIN;CREATE SCHEMA extensions;CREATE SCHEMA orl_private;CREATE EXTENSION pgcrypto WITH SCHEMA extensions;'|Out-Null
  if($LASTEXITCODE-ne0){throw 'Isolated local restore prerequisites failed.'}
  $env:PGOPTIONS='-c check_function_bodies=off'
  # Retain archive GRANT/REVOKE entries: skipping ACLs restores the default
  # PUBLIC EXECUTE privilege and invalidates the private-finalizer test.
  & (Join-Path $orlBin 'pg_restore.exe') -h 127.0.0.1 -p $port -U orl_c4_owner -d postgres --no-owner --exit-on-error --schema=public --schema=orl_private $orlPartial|Out-Null
  if($LASTEXITCODE-ne0){throw 'Isolated local restore failed.'}
  $env:PGOPTIONS=''
  # pg_dump owns a consistent snapshot taken after the preliminary live inventory.
  # Login/audit or normal booking activity may legitimately occur between those two
  # instants, so validate the restored snapshot internally rather than comparing it
  # byte-for-byte with the earlier live counts.
  $localStatusSql="select jsonb_build_object('requests',(select count(*) from public.orl_requests),'nonblank',(select count(*) from public.orl_requests where trim(coalesce(patient_ic,''))<>''),'blank',(select count(*) from public.orl_requests where trim(coalesce(patient_ic,''))=''),'identities',(select count(*) from orl_private.request_identity),'audit',(select count(*) from public.orl_audit_log),'sessions',(select count(*) from public.orl_sessions),'generation',(select generation from orl_private.c1_restore_generation where singleton),'recovery_ready',orl_private.c1_recovery_ready(),'c2_complete',(orl_private.c2_stats()->>'complete')::boolean,'c2_finalized',exists(select 1 from orl_private.c2_verification_runs where completed_at is not null),'c3_ready',to_regclass('orl_private.c3_reveal_lease') is not null);"
  $restoredStatus=((&(Join-Path $orlBin 'psql.exe') @local -Atc $localStatusSql)|Select-Object -Last 1)|ConvertFrom-Json
  # A full dump carries the source database identity. On a different local
  # cluster it MUST restore closed until the offline owner finalizer rotates
  # generation and invalidates all restored sessions.
  if($LASTEXITCODE-ne0 -or [int]$restoredStatus.identities-le0 -or
     [int]$restoredStatus.identities-ne[int]$restoredStatus.nonblank -or
     [int]$restoredStatus.requests-ne([int]$restoredStatus.identities+[int]$restoredStatus.blank) -or
     [int]$restoredStatus.audit-le0 -or $restoredStatus.recovery_ready -or -not$restoredStatus.c2_complete -or
     -not$restoredStatus.c2_finalized -or -not$restoredStatus.c3_ready -or
     $restoredStatus.generation -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'){
    throw 'Restored database structure/count verification failed.'
  }
  $privilegeSql="select bool_and(not has_function_privilege(r,'public.orl_ic_c1_finalize_full_dump_recovery(uuid,text,boolean)','EXECUTE')) from unnest(array['public','anon','authenticated','service_role']) r;"
  $privateFinalizer=((&(Join-Path $orlBin 'psql.exe') @local -Atc $privilegeSql)|Select-Object -Last 1)
  if($LASTEXITCODE-ne0 -or $privateFinalizer-cne't'){throw 'Offline recovery finalizer privilege check failed.'}
  $generation=$restoredStatus.generation.ToLowerInvariant()
  $finalizeSql="select public.orl_ic_c1_finalize_full_dump_recovery('$generation'::uuid,'ROTATE C1 GENERATION AND INVALIDATE SESSIONS',false);"
  $finalized=((&(Join-Path $orlBin 'psql.exe') @local -Atc $finalizeSql)|Select-Object -Last 1)|ConvertFrom-Json
  if($LASTEXITCODE-ne0 -or $finalized.status-cne'READY' -or -not$finalized.generation_rotated -or
     [int]$finalized.identities-ne[int]$restoredStatus.identities){throw 'Isolated full-dump recovery finalization failed.'}
  $localStatus=((&(Join-Path $orlBin 'psql.exe') @local -Atc $localStatusSql)|Select-Object -Last 1)|ConvertFrom-Json
  if($LASTEXITCODE-ne0 -or -not$localStatus.recovery_ready -or [int]$localStatus.sessions-ne0 -or
     $localStatus.generation-ceq$generation -or [int]$localStatus.requests-ne[int]$restoredStatus.requests -or
     [int]$localStatus.identities-ne[int]$restoredStatus.identities -or [int]$localStatus.audit-ne[int]$restoredStatus.audit){
    throw 'Recovered local target did not reopen safely.'
  }
  if($LocalStructureOnly){
    Stop-OrlC4LocalRestore
    Write-Host 'PASS: local archive structure, private finalizer, generation rotation and session invalidation. Cryptographic verification is still pending.'
    return
  }
  $rowSql="select jsonb_build_object('request_id',r.id::text,'patient_ic_b64',replace(replace(encode(convert_to(r.patient_ic,'UTF8'),'base64'),chr(10),''),chr(13),''),'encryption_key_id',i.encryption_key_id,'nonce',replace(encode(i.nonce,'base64'),chr(10),''),'ciphertext',replace(encode(i.ciphertext,'base64'),chr(10),''),'search_key_id',i.search_key_id,'search_hash',replace(encode(i.search_hash,'base64'),chr(10),'')) from public.orl_requests r join orl_private.request_identity i on i.request_id=r.id order by r.id;"
  $orlRows=@(&(Join-Path $orlBin 'psql.exe') @local -Atc $rowSql)
  if($LASTEXITCODE-ne0){throw 'Restored encrypted-identity read failed.'}
  $verified=Test-OrlIdentityRows $orlRows $orlPayload
  if($verified-ne[int]$localStatus.identities){throw 'Not every restored encrypted identity was verified.'}
  $orlRows=$null;$orlPayload=$null
  Stop-OrlC4LocalRestore
  Move-Item -LiteralPath $orlPartial -Destination $orlBackup
  $report=[ordered]@{
    format='ORL-C4-SANITIZED-REPORT';version=1;project=$orlProject;completed_at=(Get-Date).ToUniversalTime().ToString('o')
    backup_file=[IO.Path]::GetFileName($orlBackup);backup_sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $orlBackup).Hash
    recovery_archive_sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $orlKeyFile).Hash
    request_count=[int]$localStatus.requests;identity_count=[int]$localStatus.identities;audit_count=[int]$localStatus.audit
    verified_identity_count=$verified;recovery_ready=$true;c2_complete=$true;c3_ready=$true
    restored_target_started_closed=$true;isolated_recovery_finalized=$true;restored_sessions_invalidated=$true
    production_restore_performed=$false;temporary_local_restore_removed=$true
  }
  $report|ConvertTo-Json|Set-Content -LiteralPath $orlReport -Encoding utf8NoBOM
  Write-Host "SUCCESS: C4 verified $verified encrypted identities after isolated local restore." -ForegroundColor Green
  Write-Host "Verified private backup: $orlBackup"
  Write-Host "Sanitized report: $orlReport"
  Write-Host 'No production Restore was run. No patient IC or encryption key was printed.'
}catch{
  Write-Host ('STOP: '+$_.Exception.Message) -ForegroundColor Red
  Write-Host 'Production was not restored or modified. Keep any .partial backup private; do not treat it as C4-verified.'
  exit 1
}finally{
  $env:PGPASSWORD=$orlOldPassword;$env:PGOPTIONS=$orlOldOptions
  $orlDatabasePassword=$null;$orlRecoveryPassword=$null;$orlPayload=$null;$orlRows=$null
  Stop-OrlC4LocalRestore
}
