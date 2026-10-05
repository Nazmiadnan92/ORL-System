-- C7: preserve age calculation from the visible DOB prefix and safe-update recovery.
-- Definition-only migration: no patient rows or production sessions are changed.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $repair$
declare item record; fn regprocedure; definition text; source text;
begin
  if not exists(select 1 from orl_private.c6_cutover_receipt where singleton) then
    raise exception 'Completed C6 required';
  end if;
  for item in select * from (values
    ('public.orl_age_parts(text,date)','d8f6312f2784c532b18a78f766133011',
     'if raw !~ ''^[0-9]{6}-?[0-9]{2}-?[0-9]{4}$'' or p_at is null',
     'if (raw !~ ''^[0-9]{6}-?[0-9]{2}-?[0-9]{4}$'' and raw !~ ''^[0-9]{6}-\*{2}-\*{4}$'') or p_at is null'),
    ('public.orl_ic_c1_import(uuid,text,jsonb)','b95ebbd30ac8e6e656c7f5b62a7180a7',
     'delete from orl_private.request_identity;',
     'lock table orl_private.c3_reveal_lease in access exclusive mode nowait;
  delete from orl_private.c3_reveal_lease where lease_id is not null;
  delete from orl_private.request_identity where request_id is not null;'),
    ('public.orl_ic_c1_finalize_full_dump_recovery(uuid,text,boolean)','678447367485f9123c9c66dd8f787305',
     'delete from public.orl_sessions;',
     'delete from public.orl_sessions where id is not null;'),
    ('public.orl_ic_c1_remove(uuid,text,text,text,uuid,uuid[])','f771357966f6f49b5f5a8e6dcae8d157',
     'delete from orl_private.request_identity where request_id=any(ids);',
     'lock table orl_private.c3_reveal_lease in share row exclusive mode nowait;
  delete from orl_private.c3_reveal_lease where request_id=any(ids);
  delete from orl_private.request_identity where request_id=any(ids);')
  ) as patches(signature,expected_md5,old_part,new_part) loop
    fn:=to_regprocedure(item.signature);
    if fn is null then raise exception 'C7 prerequisite function missing'; end if;
    select replace(prosrc,chr(13),'') into source from pg_proc where oid=fn;
    if md5(source) is distinct from item.expected_md5 then
      raise exception 'C7 reviewed baseline differs or 052 already installed: %',item.signature;
    end if;
    if (length(source)-length(replace(source,item.old_part,'')))/length(item.old_part)<>1 then
      raise exception 'C7 repair target is not unique';
    end if;
    definition:=replace(pg_get_functiondef(fn),item.old_part,item.new_part);
    execute definition;
  end loop;
end $repair$;
notify pgrst,'reload schema';
commit;
