function Get-OrlC1RecoveryGuardSql {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][bool]$Expected046)
  $orlExpected=if($Expected046){'true'}else{'false'}
  @'
do $c1_recovery_check$
declare has_046 boolean; recovery_ready boolean;
begin
  has_046:=to_regprocedure('public.orl_ic_c1_create(uuid,uuid,jsonb,jsonb,jsonb,uuid)') is not null;
  if has_046 is distinct from __EXPECTED_046__ then raise exception 'STOP: unexpected migration 046 state'; end if;
  if has_046 then
    begin
      execute 'select orl_private.c1_recovery_ready()' into recovery_ready;
    exception when undefined_function or invalid_schema_name then
      raise exception 'STOP: migration 046 recovery function is missing';
    end;
    if recovery_ready is distinct from true then raise exception 'STOP: full-dump recovery fence is closed'; end if;
  end if;
end $c1_recovery_check$;
'@.Replace('__EXPECTED_046__',$orlExpected)
}
