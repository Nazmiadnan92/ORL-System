$ErrorActionPreference='Stop'
$orlPsql=$env:ORL_IC_TEST_PSQL
$orlPort=$env:ORL_IC_TEST_PORT
$orlMigration=(Resolve-Path (Join-Path $PSScriptRoot '..\..\supabase\047_mask_ic_last_six.sql')).Path
if(!$orlPsql -or $orlPort-ne '55461'){throw 'Disposable C1 runner environment required.'}
$orlArgs=@('-X','-qAt','-h','127.0.0.1','-p',$orlPort,'-U','orl_test_owner','-d','postgres','-v','ON_ERROR_STOP=1')
$orlOld=@"
create or replace function orl_private.c1_mask_ic(p_raw text)
returns text language sql immutable set search_path='' as `$`$
 select case when p_raw is null then null when trim(p_raw)='' then ''
   when p_raw ~ '^([0-9]{6}-\*{2}-\*{4}|\*{6}-\*{2}-[0-9]{4}|\*{4,8}[A-Za-z0-9]{4}|\*{4})`$' then p_raw
   when trim(p_raw) ~ '^[0-9]{6}-?[0-9]{2}-?[0-9]{4}`$' then '******-**-'||right(trim(p_raw),4)
   when length(regexp_replace(p_raw,'\s','','g'))<=4 then '****'
   else '********'||right(regexp_replace(p_raw,'\s','','g'),4) end
`$`$;
revoke all on function orl_private.c1_mask_ic(text) from public,anon,authenticated,service_role;
"@
$orlOld | & $orlPsql @orlArgs
if($LASTEXITCODE-ne 0){throw 'Unable to prepare the disposable 046 masking baseline.'}
& $orlPsql @orlArgs -f $orlMigration
if($LASTEXITCODE-ne 0){throw 'Migration 047 failed on the disposable 046 baseline.'}
$orlResult=& $orlPsql @orlArgs -c "select orl_private.c1_mask_ic('010203-04-5678')||'|'||orl_private.c1_redact_text('IC 010203045678.');"
if($LASTEXITCODE-ne 0 -or ($orlResult -join '')-ne '010203-**-****|IC 010203-**-****.'){
  throw 'Migration 047 post-install mask verification failed.'
}
$orlAgain=& $orlPsql @orlArgs -f $orlMigration 2>&1
if($LASTEXITCODE-eq 0 -or ($orlAgain-join "`n")-notmatch 'already installed'){
  throw 'Migration 047 reinstall guard failed.'
}
$global:LASTEXITCODE=0
Write-Output 'PASS: migration 047 changes display only, preserves private privileges and refuses reinstall.'
