-- Operator confirmed guarded production installation: request assignment/review integrity and null-safe ownership.
begin;
create or replace function public.orl_confirm_request(p_session_token uuid, p_request_id uuid)
returns text
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.orl_users%rowtype; v_request public.orl_requests%rowtype; v_status text;
begin
  v_user := public.orl_require_session(p_session_token);
  select r.* into v_request from public.orl_requests r where r.id = p_request_id for update;
  if not found then raise exception 'Request not found.'; end if;
  if v_user.role = 'STAFF' and v_request.created_by is distinct from v_user.id then raise exception 'You can only confirm your own request.'; end if;
  if v_request.status <> 'DRAFT' then raise exception 'Only a draft request can be confirmed.'; end if;
  if v_user.role in ('ADMIN','WEBMASTER') then v_status := 'APPROVED'; else v_status := 'CONFIRMED'; end if;
  update public.orl_requests set status=v_status, confirmed_at=now(), reviewed_by=case when v_status='APPROVED' then v_user.id else null end, reviewed_at=case when v_status='APPROVED' then now() else null end, review_note=case when v_status='APPROVED' then 'Direct entry by Admin' else '' end, updated_at=now() where id=v_request.id;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
  values(v_user.id,v_user.display_name,v_user.role,'REQUEST_CONFIRMED','REQUEST',v_request.id::text,'Request ready for OT slot selection');
  return v_status;
end;
$$;
create or replace function public.orl_assign_slot(p_session_token uuid,p_request_id uuid,p_slot_id uuid)
returns text
language plpgsql security definer set search_path=public,extensions as $$
declare u public.orl_users%rowtype; r public.orl_requests%rowtype; sl public.orl_ot_slots%rowtype; slot_status text;
begin
  u:=public.orl_require_session(p_session_token);
  -- Acquire the slot before the request, matching slot actions.
  perform 1 from public.orl_ot_slots where id=p_slot_id for update;
  select * into r from public.orl_requests where id=p_request_id for update;
  if not found then raise exception 'Request not found.'; end if;
  if u.role='STAFF' and r.created_by is distinct from u.id then raise exception 'You can only assign your own request.'; end if;
  if r.assigned_slot_id is not null then raise exception 'This request already has an OT slot.'; end if;
  if u.role='STAFF' and r.status<>'CONFIRMED' then raise exception 'Confirm the request before reserving a slot.'; end if;
  if u.role in('ADMIN','WEBMASTER') and r.status not in('CONFIRMED','APPROVED') then raise exception 'This request cannot be assigned yet.'; end if;
  select x.* into sl
  from public.orl_ot_slots x
  join public.orl_ot_sessions s on s.id=x.session_id
  where x.id=p_slot_id and s.status='ACTIVE'
    and (s.holiday_override or not exists(
      select 1 from public.orl_holidays h where h.holiday_date=s.ot_date and h.is_active
    ))
  for update of x;
  if not found or sl.status<>'AVAILABLE' or sl.request_id is not null then raise exception 'This OT slot is unavailable or blocked by a holiday.'; end if;
  if u.role='STAFF' and sl.slot_type='SPECIAL' then raise exception 'Special slots are available to Admin and Webmaster only.'; end if;
  slot_status:=case when u.role in('ADMIN','WEBMASTER') then 'CONFIRMED' else 'RESERVED' end;
  update public.orl_ot_slots set request_id=r.id,status=slot_status,updated_by=u.id,updated_at=now() where id=sl.id;
  update public.orl_requests set assigned_slot_id=sl.id,status=case when slot_status='CONFIRMED' then 'SCHEDULED' else 'CONFIRMED' end,updated_at=now() where id=r.id;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
  values(u.id,u.display_name,u.role,case when slot_status='CONFIRMED' then 'PATIENT_ASSIGNED_CONFIRMED' else 'OT_SLOT_RESERVED' end,'REQUEST',r.id::text,'OT slot assigned');
  return slot_status;
end $$;
create or replace function public.orl_review_request(p_session_token uuid, p_request_id uuid, p_action text, p_note text default '')
returns text
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.orl_users%rowtype; v_request public.orl_requests%rowtype; original_slot uuid; sl public.orl_ot_slots%rowtype;
begin
  v_user:=public.orl_require_session(p_session_token);
  if v_user.role not in ('ADMIN','WEBMASTER') then raise exception 'Admin access required.'; end if;
  if p_action is null or p_action not in ('APPROVE','REJECT') then raise exception 'Invalid review action.'; end if;
  select assigned_slot_id into original_slot from public.orl_requests where id=p_request_id;
  if original_slot is not null then
    perform 1 from public.orl_ot_slots where id=original_slot for update;
  end if;
  select r.* into v_request from public.orl_requests r where r.id=p_request_id for update;
  if not found then raise exception 'Request not found.'; end if;
  if v_request.status is distinct from 'CONFIRMED' then raise exception 'Only pending requests can be reviewed. Refresh the list.'; end if;
  if v_request.assigned_slot_id is distinct from original_slot then
    raise exception 'The request slot has changed. Refresh the list and review again.';
  end if;
  if original_slot is not null then
    select * into sl from public.orl_ot_slots where id=original_slot;
    if not found or sl.request_id is distinct from v_request.id or sl.status is distinct from 'RESERVED' then
      raise exception 'OT slot links or status are inconsistent. No changes applied; contact Admin.';
    end if;
  end if;
  if p_action='APPROVE' then
    if v_request.status <> 'CONFIRMED' then raise exception 'Only confirmed requests can be approved.'; end if;
    if v_request.assigned_slot_id is not null then
      update public.orl_ot_slots set status='CONFIRMED',updated_by=v_user.id,updated_at=now() where id=v_request.assigned_slot_id and status='RESERVED';
      update public.orl_requests set status='SCHEDULED',reviewed_by=v_user.id,reviewed_at=now(),review_note=p_note,updated_at=now() where id=v_request.id;
    else
      update public.orl_requests set status='APPROVED',reviewed_by=v_user.id,reviewed_at=now(),review_note=p_note,updated_at=now() where id=v_request.id;
    end if;
  elsif p_action='REJECT' then
    if v_request.assigned_slot_id is not null then update public.orl_ot_slots set request_id=null,status='AVAILABLE',updated_by=v_user.id,updated_at=now() where id=v_request.assigned_slot_id; end if;
    update public.orl_requests set status='REJECTED',assigned_slot_id=null,reviewed_by=v_user.id,reviewed_at=now(),review_note=p_note,updated_at=now() where id=v_request.id;
  else raise exception 'Invalid review action.'; end if;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details) values(v_user.id,v_user.display_name,v_user.role,'REQUEST_'||p_action,'REQUEST',v_request.id::text,p_note);
  return p_action;
end;
$$;
revoke all on function public.orl_confirm_request(uuid,uuid),public.orl_assign_slot(uuid,uuid,uuid),public.orl_review_request(uuid,uuid,text,text) from public;
grant execute on function public.orl_confirm_request(uuid,uuid),public.orl_assign_slot(uuid,uuid,uuid),public.orl_review_request(uuid,uuid,text,text) to anon,authenticated;
notify pgrst,'reload schema';
commit;
