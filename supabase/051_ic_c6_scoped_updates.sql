-- C6 repair: scope free-text updates for production safe-update enforcement.
-- Changes only the reviewed function definition; does not execute the cutover.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $repair$
declare fn regprocedure:=to_regprocedure('public.orl_ic_c6_cutover(uuid,text,uuid,uuid)');
  definition text; old_part text; new_part text; pair record;
begin
  if fn is null then raise exception 'Migration 050 is required'; end if;
  if exists(select 1 from orl_private.c6_cutover_receipt where singleton) then
    raise exception 'C6 is already complete; inspect before applying this repair';
  end if;
  if (select md5(replace(prosrc,E'\r','')) from pg_proc where oid=fn)
       is distinct from '5977247e4a158cf152bc77cbaf263a8e' then
    raise exception 'C6 function differs from reviewed 050 or repair already installed';
  end if;
  definition:=replace(pg_get_functiondef(fn),E'\r','');
  for pair in select * from (values
    ($old$update public.orl_audit_log set details=orl_private.c1_redact_text(details),record_id=orl_private.c1_redact_text(record_id);$old$,
     $new$update public.orl_audit_log set details=orl_private.c1_redact_text(details),record_id=orl_private.c1_redact_text(record_id)
    where details is distinct from orl_private.c1_redact_text(details)
       or record_id is distinct from orl_private.c1_redact_text(record_id);$new$),
    ($old$update public.orl_requests set remark=orl_private.c1_redact_text(remark),
    deletion_reason=orl_private.c1_redact_text(deletion_reason),review_note=orl_private.c1_redact_text(review_note),
    postpone_history=orl_private.c6_redact_json(postpone_history);$old$,
     $new$update public.orl_requests set remark=orl_private.c1_redact_text(remark),
    deletion_reason=orl_private.c1_redact_text(deletion_reason),review_note=orl_private.c1_redact_text(review_note),
    postpone_history=orl_private.c6_redact_json(postpone_history)
    where remark is distinct from orl_private.c1_redact_text(remark)
       or deletion_reason is distinct from orl_private.c1_redact_text(deletion_reason)
       or review_note is distinct from orl_private.c1_redact_text(review_note)
       or postpone_history is distinct from orl_private.c6_redact_json(postpone_history);$new$),
    ($old$update public.orl_holidays set description=orl_private.c1_redact_text(description);$old$,
     $new$update public.orl_holidays set description=orl_private.c1_redact_text(description)
    where description is distinct from orl_private.c1_redact_text(description);$new$),
    ($old$update public.orl_ot_sessions set note=orl_private.c1_redact_text(note),special_title=orl_private.c1_redact_text(special_title);$old$,
     $new$update public.orl_ot_sessions set note=orl_private.c1_redact_text(note),special_title=orl_private.c1_redact_text(special_title)
    where note is distinct from orl_private.c1_redact_text(note)
       or special_title is distinct from orl_private.c1_redact_text(special_title);$new$)
  ) as changes(old_text,new_text)
  loop
    old_part:=pair.old_text;new_part:=pair.new_text;
    if (length(definition)-length(replace(definition,old_part,'')))/length(old_part)<>1 then
      raise exception 'Reviewed update fragment missing or duplicated';
    end if;
    definition:=replace(definition,old_part,new_part);
  end loop;
  execute definition;
  if not has_function_privilege('service_role',fn,'EXECUTE')
     or has_function_privilege('anon',fn,'EXECUTE')
     or has_function_privilege('authenticated',fn,'EXECUTE') then
    raise exception 'C6 repair permission check failed';
  end if;
end $repair$;

notify pgrst,'reload schema';
commit;
