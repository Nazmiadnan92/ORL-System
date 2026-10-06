-- Restore the exact request revision omitted by the later 046 redaction body.
-- Definition-only repair. Retain masking, permissions and stale-write checks.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $repair$
declare fn regprocedure; source text; definition text;
  old_part text:=E'   return result;\n end if;\n return p_value;';
  new_part text:=$body$   -- Attach the authoritative revision; do not round through a JS Date.
   if p_value ? 'request_id' and coalesce(p_value->>'request_id','')<>''
      and (p_value->>'request_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
     result:=result||coalesce((select jsonb_build_object('_ic_edit_version',r.updated_at)
       from public.orl_requests r where r.id=(p_value->>'request_id')::uuid),'{}'::jsonb);
   end if;
   return result;
 end if;
 return p_value;$body$;
begin
  fn:=to_regprocedure('orl_private.c1_mask_json(jsonb,date)');
  if fn is null or not orl_private.c1_recovery_ready() then
    raise exception 'STOP: protected read/recovery baseline missing.';
  end if;
  select replace(prosrc,chr(13),'') into source from pg_proc where oid=fn;
  if md5(source) is distinct from '29dbcc17a7b810c7e553b3c414a3873b' then
    raise exception 'STOP: reviewed masker baseline differs or 055 already installed. Inspect before retrying.';
  end if;
  if (length(source)-length(replace(source,old_part,'')))/length(old_part)<>1 then
    raise exception 'STOP: repair target is not unique.';
  end if;
  definition:=replace(replace(pg_get_functiondef(fn),chr(13),''),old_part,new_part);
  execute definition;
  if exists(select 1 from unnest(array['anon','authenticated','service_role']) r
    where has_function_privilege(r,fn,'EXECUTE')
       or has_function_privilege(r,'public.orl_require_session(uuid)','EXECUTE')) then
    raise exception 'STOP: private helper access is not closed. Repair rolled back.';
  end if;
end $repair$;
notify pgrst,'reload schema';
commit;
