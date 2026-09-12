-- Phase 6: checked cancellation and locked compaction.
-- Operator confirmed guarded production installation. Requires frontend cache 050.
begin;
create or replace function public.orl_compact_main(p_session_id uuid,p_user_id uuid)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare
  packed jsonb;
  locked_ids uuid[];
  item jsonb;
  target_id uuid;
  n integer:=0;
begin
  -- Lock before reading the packing snapshot. Freeze IDs to exclude later inserts.
  select coalesce(array_agg(id),'{}'::uuid[]) into locked_ids
  from (select id from public.orl_ot_slots
        where session_id=p_session_id and slot_type='MAIN'
        order by id for update) locked;
  perform 1 from public.orl_requests
  where id in(select request_id from public.orl_ot_slots where id=any(locked_ids))
  order by id for update;
  if exists(
    select 1 from public.orl_ot_slots sl
    left join public.orl_requests r on r.id=sl.request_id
    where sl.id=any(locked_ids) and sl.request_id is not null
      and (sl.status='CLOSED' or r.id is null or r.assigned_slot_id is distinct from sl.id or r.status='CANCELLED')
  ) or exists(
    select 1 from public.orl_requests r join public.orl_ot_slots sl on sl.id=r.assigned_slot_id
    where sl.id=any(locked_ids) and sl.request_id is distinct from r.id
  ) then raise exception 'OT slot links are inconsistent. No changes applied; contact Admin.'; end if;
  select coalesce(
    jsonb_agg(jsonb_build_object('request_id',request_id,'status',status) order by slot_number),
    '[]'::jsonb
  ) into packed
  from public.orl_ot_slots
  where id=any(locked_ids) and request_id is not null;

  update public.orl_requests r
  set assigned_slot_id=null,updated_at=now()
  where r.assigned_slot_id in (
    select id from public.orl_ot_slots
    where id=any(locked_ids)
  );

  update public.orl_ot_slots
  set request_id=null,status='AVAILABLE'
  where id=any(locked_ids) and status<>'CLOSED';

  for item in select * from jsonb_array_elements(packed) loop
    select id into target_id
    from public.orl_ot_slots
    where id=any(locked_ids) and status<>'CLOSED'
    order by slot_number offset n limit 1;

    if target_id is null then
      raise exception 'Not enough open Main slots to compact this OT list.';
    end if;

    update public.orl_ot_slots
    set request_id=(item->>'request_id')::uuid,status=item->>'status',
        updated_by=p_user_id,updated_at=now()
    where id=target_id;

    update public.orl_requests
    set assigned_slot_id=target_id,updated_at=now()
    where id=(item->>'request_id')::uuid;

    n:=n+1;
  end loop;
end $$;

revoke all on function public.orl_compact_main(uuid,uuid) from public,anon,authenticated;

create or replace function public.orl_resolve_deletion(
  p_session_token uuid,
  p_request_id uuid,
  p_action text
)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare
  u public.orl_users%rowtype;
  r public.orl_requests%rowtype;
  sl public.orl_ot_slots%rowtype;
  original_slot uuid;
  locked_session uuid;
begin
  u:=public.orl_require_session(p_session_token);
  if u.role not in('ADMIN','WEBMASTER') then raise exception 'Admin access required.'; end if;

  if upper(p_action) is null or upper(p_action) not in ('APPROVE','REJECT') then raise exception 'Invalid action.'; end if;
  select assigned_slot_id into original_slot from public.orl_requests where id=p_request_id;
  -- Take the session slot locks before the request lock, matching checked Cancel.
  if original_slot is not null then
    select * into sl from public.orl_ot_slots where id=original_slot;
    locked_session:=sl.session_id;
    perform 1 from public.orl_ot_slots where session_id=sl.session_id order by id for update;
  end if;
  select * into r from public.orl_requests where id=p_request_id for update;
  if not found or r.deletion_status is distinct from 'PENDING' then raise exception 'No pending deletion request.'; end if;

  if r.assigned_slot_id is distinct from original_slot then
    -- Another cancellation may have compacted this same patient within the
    -- session we already locked. Follow the request, never the old occupant.
    select * into sl from public.orl_ot_slots where id=r.assigned_slot_id;
    if not found or locked_session is null or sl.session_id is distinct from locked_session then
      raise exception 'The selected OT patient has changed. Refresh the schedule and select again.';
    end if;
    original_slot:=r.assigned_slot_id;
  end if;
  if original_slot is not null then
    select * into sl from public.orl_ot_slots where id=original_slot;
    if not found or sl.request_id is distinct from r.id then
      raise exception 'OT slot links are inconsistent. No changes applied; contact Admin.';
    end if;
  end if;

  if upper(p_action)='REJECT' then
    update public.orl_requests
    set deletion_status='',deletion_reason='',deletion_requested_by=null,
        deletion_requested_at=null,updated_at=now()
    where id=p_request_id;
  elsif upper(p_action)='APPROVE' then
    if r.assigned_slot_id is not null then
      select * into sl from public.orl_ot_slots where id=r.assigned_slot_id for update;

      -- Release the request-side unique key before another case is compacted
      -- into this slot.
      update public.orl_requests
      set assigned_slot_id=null,updated_at=now()
      where id=p_request_id;

      update public.orl_ot_slots
      set request_id=null,status='AVAILABLE',updated_by=u.id,updated_at=now()
      where id=sl.id;

      if sl.slot_type='MAIN' then
        perform public.orl_compact_main(sl.session_id,u.id);
      end if;
    end if;

    update public.orl_requests
    set status='CANCELLED',assigned_slot_id=null,deletion_status='APPROVED',updated_at=now()
    where id=p_request_id;
  else
    raise exception 'Invalid action.';
  end if;

  insert into public.orl_audit_log(
    user_id,user_name,user_role,action,record_type,record_id,details
  ) values(
    u.id,u.display_name,u.role,'DELETION_'||upper(p_action),'REQUEST',p_request_id::text,r.deletion_reason
  );
end $$;

revoke all on function public.orl_resolve_deletion(uuid,uuid,text) from public;
grant execute on function public.orl_resolve_deletion(uuid,uuid,text) to anon,authenticated;

create or replace function public.orl_edit_scheduled_request_checked(p_session_token uuid,p_slot_id uuid,p_data jsonb,p_action text,p_expected_request_id uuid)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare
  v_user public.orl_users%rowtype;
  v_slot public.orl_ot_slots%rowtype;
  v_req public.orl_requests%rowtype;
  act text:=upper(p_action); reason text; v_age integer; calculated_age integer; new_ic text;
begin
  v_user:=public.orl_require_session(p_session_token);
  if act is null or act not in('CONFIRM','POSTPONE','CANCEL') then raise exception 'Invalid status action.'; end if;
  perform 1 from public.orl_ot_slots
  where session_id=(select session_id from public.orl_ot_slots where id=p_slot_id)
  order by id for update;
  select * into v_slot from public.orl_ot_slots where id=p_slot_id for update;
  if p_expected_request_id is null or v_slot.request_id is distinct from p_expected_request_id then
    raise exception 'The selected OT patient has changed. Refresh the schedule and select again.';
  end if;
  if not found or v_slot.request_id is null then raise exception 'Assigned request not found.'; end if;
  select * into v_req from public.orl_requests where id=v_slot.request_id for update;
  if not found then raise exception 'Assigned request not found.'; end if;
  if v_req.assigned_slot_id is distinct from v_slot.id or v_req.status='CANCELLED' then
    raise exception 'OT slot links are inconsistent. No changes applied; contact Admin.';
  end if;
  if v_user.role='STAFF' and v_req.created_by is distinct from v_user.id and act<>'CANCEL' then raise exception 'You do not have access.'; end if;

  if v_user.role='STAFF' then
    -- Cancellation requests must not double as edits to clinical details.
    if act<>'CANCEL' then
    update public.orl_requests set
      surgery=coalesce(nullif(trim(p_data->>'surgery'),''),surgery),
      diagnosis=coalesce(nullif(trim(p_data->>'diagnosis'),''),diagnosis),updated_at=now()
    where id=v_req.id;
    end if;
  else
    new_ic:=coalesce(p_data->>'patient_ic',v_req.patient_ic);
    begin v_age:=coalesce(nullif(trim(p_data->>'age'),'')::integer,v_req.age);
    exception when invalid_text_representation then raise exception 'Age must be a whole number.';
    end;
    calculated_age:=public.orl_age_from_ic(new_ic,current_date);
    if calculated_age is not null then v_age:=calculated_age; end if;
    if v_age is null or v_age not between 0 and 130 then raise exception 'Enter an age between 0 and 130.'; end if;
    update public.orl_requests set
      patient_ic=new_ic,age=v_age,mrn=coalesce(p_data->>'mrn',mrn),
      patient_name=coalesce(p_data->>'patient_name',patient_name),
      surgery=coalesce(p_data->>'surgery',surgery),diagnosis=coalesce(p_data->>'diagnosis',diagnosis),
      doctor=coalesce(p_data->>'doctor',doctor),specialist=coalesce(p_data->>'specialist',specialist),
      sub_specialty=coalesce(p_data->>'sub_specialty',sub_specialty),phone=coalesce(p_data->>'phone',phone),
      remark=coalesce(p_data->>'remark',remark),updated_at=now()
    where id=v_req.id;
  end if;

  if act='CANCEL' and v_user.role='STAFF' then
    if v_req.deletion_status='PENDING' then raise exception 'A cancellation request is already pending review.'; end if;
    reason:=coalesce(nullif(trim(p_data->>'cancel_reason'),''),'Cancellation requested by Staff');
    update public.orl_requests set deletion_status='PENDING',deletion_reason=reason,
      deletion_requested_by=v_user.id,deletion_requested_at=now(),updated_at=now()
    where id=v_req.id;
    insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
    values(v_user.id,v_user.display_name,v_user.role,'STAFF_CANCELLATION_REQUESTED','REQUEST',v_req.id::text,reason);
    return;
  end if;
  if act='CONFIRM' and v_user.role in('ADMIN','WEBMASTER') then
    update public.orl_requests set status='SCHEDULED',updated_at=now() where id=v_req.id;
    update public.orl_ot_slots set status='CONFIRMED',updated_by=v_user.id,updated_at=now() where id=p_slot_id;
  elsif act='CANCEL' then
    reason:=coalesce(nullif(trim(p_data->>'cancel_reason'),''),nullif(trim(p_data->>'remark'),''),'Cancelled by '||v_user.display_name);
    update public.orl_requests set status='CANCELLED',assigned_slot_id=null,
      deletion_status='APPROVED',deletion_reason=reason,deletion_requested_by=v_user.id,
      deletion_requested_at=now(),updated_at=now() where id=v_req.id;
    update public.orl_ot_slots set request_id=null,status='AVAILABLE',updated_by=v_user.id,updated_at=now() where id=p_slot_id;
    if v_slot.slot_type='MAIN' then perform public.orl_compact_main(v_slot.session_id,v_user.id); end if;
  end if;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
  values(v_user.id,v_user.display_name,v_user.role,'SLOT_EDIT_'||act,'REQUEST',v_req.id::text,
    case when act='CANCEL' then 'Patient cancelled by Admin/Webmaster; OT slot released; cancellation record retained'
         when v_user.role='STAFF' then 'Staff updated Surgery / Procedure and Diagnosis'
         else 'Patient details updated' end);
end $$;
revoke all on function public.orl_edit_scheduled_request_checked(uuid,uuid,jsonb,text,uuid) from public;
grant execute on function public.orl_edit_scheduled_request_checked(uuid,uuid,jsonb,text,uuid) to anon,authenticated;
create or replace function public.orl_edit_scheduled_request(p_session_token uuid,p_slot_id uuid,p_data jsonb,p_action text)
returns void language plpgsql security definer set search_path=public,extensions as $legacy$
begin
 perform public.orl_require_session(p_session_token);
 raise exception 'Please refresh the page to use the updated Edit/Cancel action.';
end $legacy$;
revoke all on function public.orl_edit_scheduled_request(uuid,uuid,jsonb,text) from public;
grant execute on function public.orl_edit_scheduled_request(uuid,uuid,jsonb,text) to anon,authenticated;

notify pgrst,'reload schema';
commit;
