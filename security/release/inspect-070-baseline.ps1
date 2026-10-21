#Requires -Version 7.4
# Metadata-only diagnostic. No ORL function is executed and no operational table is read.
# The export function definition stays in a private local report; never print it.
$ErrorActionPreference='Stop'
$bin='C:\Program Files\PostgreSQL\18\bin'
$ca=Join-Path $PSScriptRoot '..\..\..\ic-encryption-package-b\certs\supabase-prod-ca-2021.crt'
$reportFolder=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ORL-Release-Reports'
$oldPassword=$env:PGPASSWORD;$password=$null
function Get-DiagnosticQuery {
 return @'
begin read only;
set local statement_timeout='20s';
with expected(signature) as (values
 ('public.orl_require_session(uuid)'),
 ('orl_private.c1_check_generation(uuid)'),
 ('orl_private.c1_redact_text(text)'),
 ('public.orl_db_export(uuid,text)'),
 ('public.orl_db_import_locked(uuid,text,jsonb)')
), functions as (
 select e.signature,p.oid is not null as present,
  case when p.oid is not null then md5(replace(p.prosrc,chr(13),'')) end as normalized_body_md5,
  case when p.oid is not null then length(replace(p.prosrc,chr(13),'')) end as normalized_body_length,
  p.prosecdef as security_definer,p.proconfig as configuration,
  case when p.oid is not null then pg_get_userbyid(p.proowner) end as owner,
  jsonb_build_object(
   'public_execute',case when p.oid is not null then exists(select 1
    from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') end,
   'anon_execute',case when p.oid is not null then has_function_privilege('anon',p.oid,'EXECUTE') end,
   'authenticated_execute',case when p.oid is not null then has_function_privilege('authenticated',p.oid,'EXECUTE') end,
   'service_role_execute',case when p.oid is not null then has_function_privilege('service_role',p.oid,'EXECUTE') end
  ) as access,
  case when e.signature='public.orl_db_export(uuid,text)' and p.oid is not null
   then pg_get_functiondef(p.oid) end as source_definition
 from expected e left join pg_proc p on p.oid=to_regprocedure(e.signature)
)
select jsonb_build_object(
 'functions',(select jsonb_agg(to_jsonb(f) order by f.signature) from functions f),
 'presence',jsonb_build_object(
  'has_day_note',exists(select 1 from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relname='orl_ot_sessions' and a.attname='day_note' and not a.attisdropped),
  'has_day_note_revision',exists(select 1 from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relname='orl_ot_sessions' and a.attname='day_note_revision' and not a.attisdropped),
  'has_read_rpc',to_regprocedure('public.orl_get_ot_day_notes(uuid,integer)') is not null,
  'has_write_rpc',to_regprocedure('public.orl_set_ot_day_note(uuid,uuid,text,bigint,uuid)') is not null
 )
);
rollback;
'@
}
function Get-QueryDigest([string]$Query) {
 return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Query.Replace("`r",''))))
}
function Test-DiagnosticMetadata($Metadata) {
 $signatures=@('public.orl_require_session(uuid)','orl_private.c1_check_generation(uuid)','orl_private.c1_redact_text(text)',
  'public.orl_db_export(uuid,text)','public.orl_db_import_locked(uuid,text,jsonb)')
 $presenceNames=@('has_day_note','has_day_note_revision','has_read_rpc','has_write_rpc')
 $fields=@('signature','present','normalized_body_md5','normalized_body_length','security_definer','configuration','owner','access','source_definition')
 $accessNames=@('public_execute','anon_execute','authenticated_execute','service_role_execute')
 if($null-eq$Metadata-or@(Compare-Object @('functions','presence') (@($Metadata.PSObject.Properties.Name)|Sort-Object)).Count-ne0 -or
  $Metadata.functions-isnot[Array]-or$Metadata.functions.Count-ne$signatures.Count -or
  @(Compare-Object ($signatures|Sort-Object) (@($Metadata.functions.signature)|Sort-Object)).Count-ne0 -or
  @(Compare-Object ($presenceNames|Sort-Object) (@($Metadata.presence.PSObject.Properties.Name)|Sort-Object)).Count-ne0){throw 'Diagnostic metadata was incomplete.'}
 foreach($name in $presenceNames){if($Metadata.presence.$name-isnot[bool]){throw 'Diagnostic presence metadata was incomplete.'}}
 foreach($item in $Metadata.functions){
  if(@(Compare-Object ($fields|Sort-Object) (@($item.PSObject.Properties.Name)|Sort-Object)).Count-ne0 -or
   $item.present-isnot[bool] -or
   @(Compare-Object ($accessNames|Sort-Object) (@($item.access.PSObject.Properties.Name)|Sort-Object)).Count-ne0){throw 'Diagnostic function metadata was incomplete.'}
  if($item.present){
   if($item.normalized_body_md5-isnot[string]-or$item.normalized_body_md5-cnotmatch'^[0-9a-f]{32}$' -or
    ($item.normalized_body_length-isnot[long]-and$item.normalized_body_length-isnot[int]) -or
    $item.normalized_body_length-lt0-or$item.security_definer-isnot[bool]-or$item.owner-isnot[string] -or
    ($null-ne$item.configuration-and$item.configuration-isnot[Array])){throw 'Diagnostic function metadata was invalid.'}
   foreach($name in $accessNames){if($item.access.$name-isnot[bool]){throw 'Diagnostic access metadata was incomplete.'}}
   if($item.signature-ceq'public.orl_db_export(uuid,text)'){
    if($item.source_definition-isnot[string]-or[long]$item.source_definition.Length-gt1048576-or$item.source_definition-notmatch'^CREATE OR REPLACE FUNCTION '){throw 'Diagnostic export definition was missing or oversized.'}
   }elseif($null-ne$item.source_definition){throw 'Unexpected definition in diagnostic report.'}
  }else{
   foreach($name in @('normalized_body_md5','normalized_body_length','security_definer','configuration','owner','source_definition')){
    if($null-ne$item.$name){throw 'Missing function metadata was inconsistent.'}
   }
   foreach($name in $accessNames){if($null-ne$item.access.$name){throw 'Missing function access metadata was inconsistent.'}}
  }
 }
}
try {
 $query=Get-DiagnosticQuery
 $queryHash=Get-QueryDigest $query
 if($queryHash-cne'40F85530E5839DEF98027F949D433B0FA5191C726BD2A443807F928765D370DE'){throw 'Reviewed diagnostic query changed. Nothing queried.'}
 . (Join-Path $PSScriptRoot 'Test-OrlReviewedCa.ps1')
 Test-OrlReviewedCa -Path $ca -ExpectedDerSha256 '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'
 $cap=$ca.Replace('\','/').Replace("'","\'")
 $conn="host=aws-0-ap-southeast-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.imrfmilqehcrvassuvuw sslmode=verify-full sslrootcert='$cap' connect_timeout=20"
 Write-Host '070 BASELINE CHECK: read-only function metadata only.' -ForegroundColor Yellow
 Write-Host 'No installation, backup, patient query, Restore, or website change will run.'
 Write-Host 'The export function definition is saved privately, never printed. Keep the diagnostic report private.'
 $secure=Read-Host 'Paste DATABASE password (hidden; NOT website password)' -AsSecureString
 try{$password=[Net.NetworkCredential]::new('',$secure).Password}finally{$secure.Dispose()}
 if([string]::IsNullOrEmpty($password)){throw 'Database password was empty.'}
 $env:PGPASSWORD=$password
 $diagnosticLines=$query|& "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -Atq
 if($LASTEXITCODE-ne0){throw 'Read-only diagnostic failed. No automatic retry was made.'}
 $jsonLines=@($diagnosticLines|Where-Object{$_-match'^\{'})
 if($jsonLines.Count-ne1){throw 'Read-only diagnostic returned an unexpected result.'}
 $metadata=$jsonLines[0]|ConvertFrom-Json -Depth 20
 Test-DiagnosticMetadata $metadata
 New-Item -ItemType Directory -Force -Path $reportFolder|Out-Null
 $stamp=Get-Date -Format 'yyyyMMdd-HHmmss-fff'
 $reportPath=Join-Path $reportFolder "ORL-070-baseline-diagnostic-$stamp.json"
 if(Test-Path -LiteralPath $reportPath){throw 'Diagnostic report filename already exists.'}
 [ordered]@{format='ORL-070-BASELINE-DIAGNOSTIC';project_ref='imrfmilqehcrvassuvuw';checked_at=(Get-Date).ToUniversalTime().ToString('o');
  query_sha256=$queryHash;metadata=$metadata
 }|ConvertTo-Json -Depth 20|Set-Content -LiteralPath $reportPath -Encoding utf8NoBOM
 foreach($item in $metadata.functions){
  if($item.present){Write-Host ($item.signature+' | body MD5: '+$item.normalized_body_md5+' | security definer: '+$item.security_definer)}
  else{Write-Host ($item.signature+' | missing')}
 }
 Write-Host 'SUCCESS: Read-only metadata check completed. No installation was performed.' -ForegroundColor Green
 Write-Host ('Private diagnostic report: '+$reportPath)
 Write-Host 'Tell GPT the result. Do not post passwords or the report contents.'
}catch {
 Write-Host 'STOP: The read-only metadata check did not complete. No installation was performed.' -ForegroundColor Red
 Write-Host 'No installation or production Restore was run. Do not repeat blindly.'
 exit 1
}finally{$env:PGPASSWORD=$oldPassword;$password=$null}
