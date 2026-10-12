-- Staff may postpone any creator's patient into an available MAIN slot.
-- Cross-owner clinical/IC edits remain forbidden; ownership and all other write permissions stay unchanged.
-- Definition-only installation: no existing patient is moved or edited by this migration.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $repair$
declare fn regprocedure:=to_regprocedure('public.orl_move_postponed_checked(uuid,uuid,uuid,jsonb,text,uuid)'); source text; definition text; before_acl aclitem[];
begin
 if not coalesce((select md5(replace(prosrc,chr(13),''))='1b0ee59e8b8e3dbf12d92d0805fd33a5' and prosecdef from pg_proc where oid=to_regprocedure('public.orl_edit_scheduled_request_checked(uuid,uuid,jsonb,text,uuid)')),false) then raise exception '063: protected baseline differs: public.orl_edit_scheduled_request_checked(uuid,uuid,jsonb,text,uuid)'; end if;
 if not coalesce((select md5(replace(prosrc,chr(13),''))='9369627b09c1739c304e1c7256b3eaa7' and prosecdef from pg_proc where oid=to_regprocedure('public.orl_ic_c1_mutate(uuid,text,uuid,uuid,uuid,jsonb,text,text,text,jsonb,jsonb,uuid,timestamptz)')),false) then raise exception '063: protected baseline differs: public.orl_ic_c1_mutate(uuid,text,uuid,uuid,uuid,jsonb,text,text,text,jsonb,jsonb,uuid,timestamptz)'; end if;
 if not coalesce((select md5(replace(prosrc,chr(13),''))='ba9d29923e7269729c8025bf1e266208' and prosecdef from pg_proc where oid=to_regprocedure('public.orl_require_session(uuid)')),false) then raise exception '063: protected baseline differs: public.orl_require_session(uuid)'; end if;
 if not coalesce((select md5(replace(prosrc,chr(13),''))='0f922b237c5c2a89976c3b4c22345ae7' and prosecdef from pg_proc where oid=to_regprocedure('orl_private.c1_read_schedule(uuid,integer,integer)')),false) then raise exception '063: protected baseline differs: orl_private.c1_read_schedule(uuid,integer,integer)'; end if;
 if exists(select 1 from unnest(array['anon','authenticated','service_role']) r where has_function_privilege(r,fn,'EXECUTE')) then
  raise exception '063: raw move helper must remain private.'; end if;
 select replace(prosrc,chr(13),''),proacl into source,before_acl from pg_proc where oid=fn and prosecdef and proconfig @> array['search_path=public, extensions'];
 if source is null or md5(source)<>'be1940a8970dbf808fff9ada9ea0bd5f' then raise exception '063: postpone baseline differs or already installed. Inspect before retrying.'; end if;
 definition:=replace(replace(pg_get_functiondef(fn),chr(13),''),source,$newbody$
declare u public.orl_users%rowtype; a public.orl_ot_slots%rowtype; b public.orl_ot_slots%rowtype; r public.orl_requests%rowtype; old_date date; new_date date; new_status text; safe_data jsonb;
begin
  u:=public.orl_require_session(p_session_token);
  if p_reason is null or p_reason !~ '[^[:space:]]' or length(p_reason)>4096 then
    raise exception 'Enter a postpone reason (maximum 4096 characters).';
  end if;
  p_reason:=orl_private.c1_redact_text(btrim(p_reason));
  -- Lock both sessions' existing slots in one order before taking patient locks.
  perform 1 from public.orl_ot_slots
  where session_id in(select session_id from public.orl_ot_slots where id in(p_from_slot_id,p_to_slot_id))
  order by id for update;
  select * into a from public.orl_ot_slots where id=p_from_slot_id for update;
  select * into b from public.orl_ot_slots where id=p_to_slot_id for update;
  if p_expected_request_id is null or a.request_id is distinct from p_expected_request_id then
    raise exception 'The selected OT patient has changed. Refresh the schedule and select again.';
  end if;
  if a.id is null or a.request_id is null then raise exception 'Original patient slot not found.'; end if;
  if b.id is null or b.request_id is not null or b.status<>'AVAILABLE' then raise exception 'The selected slot is no longer available.'; end if;
  select * into r from public.orl_requests where id=a.request_id for update;
  if not found then raise exception 'Assigned request not found.'; end if;
  if r.assigned_slot_id is distinct from a.id or r.status='CANCELLED' then
    raise exception 'OT slot links are inconsistent. No changes applied; contact Admin.';
  end if;
  if u.role='STAFF' and b.slot_type='SPECIAL' then raise exception 'Special slots are available to Admin and Webmaster only.'; end if;
  safe_data:=coalesce(p_data,'{}'::jsonb);
  if u.role='STAFF' then
    if r.created_by is distinct from u.id then
      -- Shared postpone grants movement only, never cross-owner clinical edits.
      safe_data:='{}'::jsonb;
    else
      -- Preserve the existing clinical edit permission for the Staff creator.
      safe_data:=jsonb_strip_nulls(jsonb_build_object(
        'surgery',nullif(trim(p_data->>'surgery'),''),
        'diagnosis',nullif(trim(p_data->>'diagnosis'),'')
      ));
    end if;
  end if;
  select ot_date into old_date from public.orl_ot_sessions where id=a.session_id;
  select s.ot_date into new_date
  from public.orl_ot_sessions s
  where s.id=b.session_id and s.status='ACTIVE'
    and (s.holiday_override or not exists(
      select 1 from public.orl_holidays h where h.holiday_date=s.ot_date and h.is_active
    ));
  if not found then raise exception 'The selected OT date is closed or blocked by a holiday.'; end if;
  if new_date < (clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date then
    raise exception 'Past OT dates are closed to new bookings. Choose today or a future date.' using errcode='22023';
  end if;
  new_status:=case when u.role='STAFF' then 'RESERVED' else 'CONFIRMED' end;
  update public.orl_ot_slots set request_id=null,status='AVAILABLE',updated_by=u.id,updated_at=now() where id=a.id;
  update public.orl_ot_slots set request_id=r.id,status=new_status,updated_by=u.id,updated_at=now() where id=b.id;
  update public.orl_requests set
    age_months=case when safe_data ? 'age_months' then public.orl_valid_age_months(safe_data->>'age_months') else age_months end,
    age=coalesce(nullif(trim(safe_data->>'age'),'')::integer,age),
    patient_ic=coalesce(safe_data->>'patient_ic',patient_ic),mrn=coalesce(safe_data->>'mrn',mrn),
    patient_name=coalesce(safe_data->>'patient_name',patient_name),surgery=coalesce(safe_data->>'surgery',surgery),
    diagnosis=coalesce(safe_data->>'diagnosis',diagnosis),doctor=case when u.role='STAFF' then doctor else initcap(coalesce(safe_data->>'doctor',doctor)) end,
    specialist=case when u.role='STAFF' then specialist else initcap(coalesce(safe_data->>'specialist',specialist)) end,sub_specialty=coalesce(safe_data->>'sub_specialty',sub_specialty),
    phone=coalesce(safe_data->>'phone',phone),remark=coalesce(safe_data->>'remark',remark),assigned_slot_id=b.id,
    status=case when new_status='RESERVED' then 'CONFIRMED' else 'SCHEDULED' end,
    postpone_count=postpone_count+1,
    postpone_history=postpone_history||jsonb_build_array(jsonb_build_object(
      'date',now(),'by',u.display_name,
      'from',old_date||' '||a.slot_type||' Slot '||a.slot_number,
      'to',new_date||' '||b.slot_type||' Slot '||b.slot_number,
      'reason',coalesce(p_reason,''))),updated_at=now()
  where id=r.id;
  if a.slot_type='MAIN' then perform public.orl_compact_main(a.session_id,u.id); end if;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
  values(u.id,u.display_name,u.role,'PATIENT_POSTPONED','REQUEST',r.id::text,old_date||' to '||new_date||' | '||coalesce(p_reason,''));
  return new_status;
end $newbody$);
 execute definition;
 if not exists(select 1 from pg_proc where oid=fn and proacl is not distinct from before_acl and md5(replace(prosrc,chr(13),''))='8bc9b710b397d1dbb10853d82949d3ac') then
  raise exception '063: definition/permissions verification failed. Rolled back.'; end if;
end $repair$;
notify pgrst,'reload schema';
commit;
