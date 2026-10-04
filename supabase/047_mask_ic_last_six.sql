-- Display-policy correction: preserve the Malaysian IC birth-date prefix and
-- mask the final six digits. Encrypted/private identity storage is unchanged.
begin;

do $$
begin
  if to_regprocedure('public.orl_ic_c1_create(uuid,uuid,jsonb,jsonb,jsonb,uuid)') is null
     or to_regprocedure('orl_private.c1_mask_ic(text)') is null
     or to_regprocedure('orl_private.c1_redact_text(text)') is null then
    raise exception 'Migration 046 must be installed first';
  end if;
  if orl_private.c1_mask_ic('010203-04-5678') <> '******-**-5678' then
    raise exception 'Unexpected IC masking baseline or migration 047 already installed';
  end if;
end $$;

create or replace function orl_private.c1_mask_ic(p_raw text)
returns text language sql immutable set search_path='' as $$
  select case
    when p_raw is null then null
    when trim(p_raw)='' then ''
    when trim(p_raw) ~ '^[0-9]{6}-\*{2}-\*{4}$' then trim(p_raw)
    when trim(p_raw) ~ '^\*{6}-\*{2}-[0-9]{4}$' then trim(p_raw)
    when trim(p_raw) ~ '^(\*{4,8}[A-Za-z0-9]{4}|\*{4})$' then trim(p_raw)
    when trim(p_raw) ~ '^[0-9]{6}-?[0-9]{2}-?[0-9]{4}$'
      then substring(regexp_replace(trim(p_raw),'[^0-9]','','g') from 1 for 6)||'-**-****'
    when length(regexp_replace(p_raw,'\s','','g'))<=4 then '****'
    else '********'||right(regexp_replace(p_raw,'\s','','g'),4)
  end
$$;
revoke all on function orl_private.c1_mask_ic(text) from public,anon,authenticated,service_role;

create or replace function orl_private.c1_redact_text(p_text text) returns text
language plpgsql stable security definer set search_path='' as $$
declare result text:=p_text; raw text;
begin
  if result is null or result='' then return result; end if;
  for raw in select distinct trim(patient_ic) from public.orl_requests
    where length(trim(coalesce(patient_ic,'')))>3 and position(trim(patient_ic) in result)>0 loop
    result:=replace(result,raw,orl_private.c1_mask_ic(raw));
  end loop;
  return regexp_replace(result,'(^|[^0-9])([0-9]{6})-?([0-9]{2})-?([0-9]{4})([^0-9]|$)',
    E'\\1\\2-**-****\\5','g');
end $$;
revoke all on function orl_private.c1_redact_text(text) from public,anon,authenticated,service_role;

do $$
begin
  if orl_private.c1_mask_ic('010203-04-5678') <> '010203-**-****'
     or orl_private.c1_mask_ic('010203045678') <> '010203-**-****'
     or orl_private.c1_mask_ic('C1-PASSPORT-SECRET') <> '********CRET'
     or orl_private.c1_redact_text('IC 010203-04-5678.') <> 'IC 010203-**-****.' then
    raise exception 'Migration 047 verification failed';
  end if;
  if has_function_privilege('anon','orl_private.c1_mask_ic(text)','EXECUTE')
     or has_function_privilege('authenticated','orl_private.c1_mask_ic(text)','EXECUTE')
     or has_function_privilege('service_role','orl_private.c1_mask_ic(text)','EXECUTE')
     or has_function_privilege('anon','orl_private.c1_redact_text(text)','EXECUTE')
     or has_function_privilege('authenticated','orl_private.c1_redact_text(text)','EXECUTE')
     or has_function_privilege('service_role','orl_private.c1_redact_text(text)','EXECUTE') then
    raise exception 'Migration 047 private-function privilege verification failed';
  end if;
end $$;

commit;
