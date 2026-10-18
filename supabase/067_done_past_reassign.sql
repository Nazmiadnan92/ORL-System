-- Webmaster-only retrospective ordering, including completed operations.
-- No patient is moved on install. Completion, identity and clinical history stay
-- unchanged; this is never a new booking, postponement or reopening of a past day.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $baseline$
declare item record;
begin
 if orl_private.c1_recovery_ready() is distinct from true
  or (orl_private.c6_stats()->>'cutover_complete')::boolean is distinct from true then
  raise exception '067: completed protected recovery/cutover baseline required.';
 end if;
 for item in select * from (values
  ('public.orl_swap_slots_checked(uuid,uuid,uuid,uuid,uuid)','777efc10480acfbbfb44688322a370f5'),
  ('public.orl_ic_c1_reassign(uuid,uuid,uuid,uuid,uuid,uuid)','2b4d1a321a41bed78ff559b3ec542d19'),
  ('public.orl_require_session(uuid)','ba9d29923e7269729c8025bf1e266208'),
  ('orl_private.c1_check_generation(uuid)','5c654a99ad55c29ba66b9b74371c8239'),
  ('public.orl_assign_slot(uuid,uuid,uuid)','b924d46e7bcac41332c9470521a72080'),
  ('public.orl_ic_ot_lifecycle(uuid,uuid,uuid,text,text,uuid,timestamptz)','23f48d226ea2fa298821f8cfe06c5ffa'),
  ('public.orl_ic_past_case_view(uuid,uuid)','42e133e4521e0766919b6f8f7bcd53b2'),
  ('public.orl_ic_past_case_save(uuid,text,text,uuid,uuid,jsonb,text,text,jsonb,jsonb,uuid,text,timestamptz)','163c7e2855fe88f37f3360aec891158c'),
  ('public.orl_ic_c1_mutate(uuid,text,uuid,uuid,uuid,jsonb,text,text,text,jsonb,jsonb,uuid,timestamptz)','3b951b49b1638b8bb268e8fc972074a0')
 ) v(signature,expected_md5) loop
  if not coalesce((select prosecdef and md5(replace(prosrc,chr(13),''))=item.expected_md5
    and (proconfig @> array['search_path=""'] or proconfig @> array['search_path=public, extensions'])
   from pg_proc where oid=to_regprocedure(item.signature)),false) then
   raise exception '067: protected baseline differs or migration is already installed: %',item.signature;
  end if;
 end loop;
 if exists(select 1 from unnest(array['anon','authenticated','service_role']) client
  cross join unnest(array['public.orl_swap_slots_checked(uuid,uuid,uuid,uuid,uuid)',
   'public.orl_require_session(uuid)','orl_private.c1_check_generation(uuid)',
   'public.orl_assign_slot(uuid,uuid,uuid)']) signature
  where has_function_privilege(client,signature,'EXECUTE'))
  or exists(select 1 from unnest(array['anon','authenticated']) client
   where has_function_privilege(client,'public.orl_ic_c1_reassign(uuid,uuid,uuid,uuid,uuid,uuid)','EXECUTE'))
  or not has_function_privilege('service_role','public.orl_ic_c1_reassign(uuid,uuid,uuid,uuid,uuid,uuid)','EXECUTE') then
  raise exception '067: protected reassignment permissions differ.';
 end if;
 if (select count(*) from pg_constraint where conrelid='public.orl_requests'::regclass
   and conname in('orl_requests_completion_state','orl_requests_ot_hold_state') and convalidated)<>2 then
  raise exception '067: lifecycle constraints missing.';
 end if;
end $baseline$;

-- Exact reviewed patches retain the existing signature, owner and private ACL.
do $patches$
declare item record;fn regprocedure:='public.orl_swap_slots_checked(uuid,uuid,uuid,uuid,uuid)'::regprocedure;
 source text;definition text;before_acl aclitem[];before_security boolean;before_owner oid;before_config text[];
begin
 select proacl,prosecdef,proowner,proconfig into before_acl,before_security,before_owner,before_config from pg_proc where oid=fn;
 for item in select * from (values
  ($old$  historical_date date;$old$,
   $new$  historical_date date;
  done_past_correction boolean := false;
  from_request public.orl_requests%rowtype;
  to_request public.orl_requests%rowtype;$new$),
  ($old$  if exists(select 1 from public.orl_requests where id in(a.request_id,b.request_id) and status='COMPLETED') then
    raise exception 'Completed operations cannot be reassigned.';
  end if;$old$,
   $new$  select * into from_request from public.orl_requests where id=a.request_id;
  select * into to_request from public.orl_requests where id=b.request_id;
  done_past_correction := coalesce(from_request.status='COMPLETED',false)
    or coalesce(to_request.status='COMPLETED',false);
  if done_past_correction then
    if v_user.role <> 'WEBMASTER' then
      raise exception 'Only Webmaster may reorder completed operations on the same past OT date.';
    end if;
    -- Slots and requests are already locked; keep the parent date stable too.
    select ot_date into historical_date from public.orl_ot_sessions
    where id=a.session_id for share;
    if historical_date is null or historical_date >= (clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date then
      raise exception 'Completed-operation reassignment is restricted to a past OT date.';
    end if;
    if a.status not in ('RESERVED','CONFIRMED')
      or from_request.id is distinct from a.request_id
      or from_request.assigned_slot_id is distinct from a.id
      or from_request.status not in ('CONFIRMED','SCHEDULED','COMPLETED')
      or from_request.deletion_status is distinct from '' then
      raise exception 'The source booking changed. Reload the schedule and review again.';
    end if;
    if b.request_id is null then
      if b.status not in ('AVAILABLE','CLOSED') then
        raise exception 'Choose an empty available or closed historical slot.';
      end if;
    elsif b.status not in ('RESERVED','CONFIRMED')
      or to_request.id is distinct from b.request_id
      or to_request.assigned_slot_id is distinct from b.id
      or to_request.status not in ('CONFIRMED','SCHEDULED','COMPLETED')
      or to_request.deletion_status is distinct from '' then
      raise exception 'The target booking changed. Reload the schedule and review again.';
    end if;
  end if;$new$),
  ($old$  if closed_past_correction then
    -- Existing ordering:$old$,
   $new$  if closed_past_correction and not done_past_correction then
    -- Existing ordering:$new$),
  ($old$      status = case when closed_past_correction then 'CLOSED'$old$,
   $new$      status = case when closed_past_correction or (done_past_correction and b.request_id is null) then 'CLOSED'$new$),
  ($old$    case when closed_past_correction then jsonb_build_object($old$,
   $new$    case when done_past_correction then jsonb_build_object(
      'mode','DONE_PAST_REASSIGN','ot_date',historical_date,
      'from_request_id',a.request_id,'to_request_id',b.request_id,
      'from_request_status',from_request.status,'to_request_status',to_request.status,
      'from_slot_id',a.id,'to_slot_id',b.id,'from_slot_label',a_label,'to_slot_label',b_label,
      'source_status_before',a.status,'source_status_after',case when b.request_id is null then 'CLOSED' else b.status end,
      'target_status_before',b.status,'target_status_after',a.status)::text
      when closed_past_correction then jsonb_build_object($new$)
 ) v(old_part,new_part) loop
  select replace(prosrc,chr(13),'') into source from pg_proc where oid=fn;
  if source is null or (length(source)-length(replace(source,item.old_part,'')))/length(item.old_part)<>1 then
   raise exception '067: reviewed reassignment patch target missing or duplicated.';
  end if;
  definition:=replace(replace(pg_get_functiondef(fn),chr(13),''),source,replace(source,item.old_part,item.new_part));
  execute definition;
 end loop;
 if not exists(select 1 from pg_proc where oid=fn and proacl is not distinct from before_acl
  and prosecdef=before_security and proowner=before_owner and proconfig is not distinct from before_config) then
  raise exception '067: reassignment execution boundary changed.';
 end if;
end $patches$;

notify pgrst,'reload schema';
commit;
