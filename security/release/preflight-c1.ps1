param([switch]$PostInstall)
$ErrorActionPreference='Stop'
$orlBin='C:\Program Files\PostgreSQL\18\bin'
$orlCa=Join-Path $PSScriptRoot '..\..\..\ic-encryption-package-b\certs\supabase-prod-ca-2021.crt'
$orlCaParameter=$orlCa.Replace('\','/').Replace("'","\'")
$orlConnection="host=aws-0-ap-southeast-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.imrfmilqehcrvassuvuw sslmode=verify-full sslrootcert='$orlCaParameter' connect_timeout=20"
$orlExpectedCa='807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'
. (Join-Path $PSScriptRoot 'Test-OrlReviewedCa.ps1')
. (Join-Path $PSScriptRoot 'Get-OrlC1RecoveryGuardSql.ps1')
try {
  if (!(Test-Path -LiteralPath "$orlBin\psql.exe")) { throw 'PostgreSQL 18 client tools were not found.' }
  Test-OrlReviewedCa -Path $orlCa -ExpectedDerSha256 $orlExpectedCa
  $orlRecoveryExpr=if($PostInstall){'orl_private.c1_recovery_ready()'}else{'null'}
  $orlRecoveryGuard=Get-OrlC1RecoveryGuardSql -Expected046 $PostInstall.IsPresent
  $orlSql=@"
begin read only;
select jsonb_build_object(
  'database',current_database(),
  'foundation_045',to_regprocedure('public.orl_ic_foundation_probe(uuid)') is not null,
  'cutover_046',to_regprocedure('public.orl_ic_c1_create(uuid,uuid,jsonb,jsonb,jsonb,uuid)') is not null,
  'create_040_md5',(select md5(replace(prosrc,chr(13),'')) from pg_proc where oid=to_regprocedure('public.orl_create_request(uuid,jsonb)')),
  'requests',(select count(*) from public.orl_requests),
  'identities',(select count(*) from orl_private.request_identity),
  'sessions',(select count(*) from public.orl_sessions),
  'database_bytes',pg_database_size(current_database()),
  'service_role',exists(select 1 from pg_roles where rolname='service_role'),
  'holiday_018',to_regprocedure('public.orl_generate_public_holidays(uuid,integer)') is not null,
  'recovery_ready',$orlRecoveryExpr
);
do `$`$
declare request_count bigint; identity_count bigint;
begin
  if to_regprocedure('public.orl_ic_foundation_probe(uuid)') is null then raise exception 'STOP: migration 045 missing'; end if;
  if (select md5(replace(prosrc,chr(13),'')) from pg_proc where oid=to_regprocedure('public.orl_create_request(uuid,jsonb)'))
     is distinct from '510bb2377c27c11629428fe90244aba7' then raise exception 'STOP: creation baseline differs'; end if;
  select count(*) into request_count from public.orl_requests;
  select count(*) into identity_count from orl_private.request_identity;
  if request_count>2000 then raise exception 'STOP: request count exceeds reviewed C1 runtime policy'; end if;
  if to_regprocedure('public.orl_ic_c1_create(uuid,uuid,jsonb,jsonb,jsonb,uuid)') is null and identity_count<>0 then
    raise exception 'STOP: pre-C1 identity table is not empty';
  end if;
end `$`$;
$orlRecoveryGuard
rollback;
"@
  Write-Host 'READ-ONLY C1 PREFLIGHT. Enter the database password privately; no patient rows are returned.' -ForegroundColor Yellow
  $orlSql | & "$orlBin\psql.exe" -X --dbname=$orlConnection --password -v ON_ERROR_STOP=1 -At
  if ($LASTEXITCODE -ne 0) { throw 'Preflight failed. Do not install or activate C1.' }
  Write-Host 'PASS: read-only C1 preflight.' -ForegroundColor Green
} catch { Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }
