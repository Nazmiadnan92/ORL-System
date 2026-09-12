-- Phase 2 Postpone authorization. Production installation confirmed by operator.
-- Preserve migration 019 workflow; restrict Staff edits to surgery/diagnosis.
begin;
create or replace function public.orl_move_postponed(p_session_token uuid,p_from_slot_id uuid,p_to_slot_id uuid,p_data jsonb,p_reason text)
returns text language plpgsql security definer set search_path=public,extensions as $$
declare u public.orl_users%rowtype; a public.orl_ot_slots%rowtype; b public.orl_ot_slots%rowtype; r public.orl_requests%rowtype; old_date date; new_date date; new_status text; safe_data jsonb;
begin
  u:=public.orl_require_session(p_session_token);
  select * into a from public.orl_ot_slots where id=p_from_slot_id for update;
  select * into b from public.orl_ot_slots where id=p_to_slot_id for update;
  if a.id is null or a.request_id is null then raise exception 'Original patient slot not found.'; end if;
  if b.id is null or b.request_id is not null or b.status<>'AVAILABLE' then raise exception 'The selected slot is no longer available.'; end if;
  select * into r from public.orl_requests where id=a.request_id for update;
  if not found then raise exception 'Assigned request not found.'; end if;
  if u.role='STAFF' and r.created_by is distinct from u.id then raise exception 'You do not have access.'; end if;
  if u.role='STAFF' and b.slot_type='SPECIAL' then raise exception 'Special slots are available to Admin and Webmaster only.'; end if;
  safe_data:=coalesce(p_data,'{}'::jsonb);
  if u.role='STAFF' then
    safe_data:=jsonb_strip_nulls(jsonb_build_object(
      'surgery',nullif(trim(p_data->>'surgery'),''),
      'diagnosis',nullif(trim(p_data->>'diagnosis'),'')
    ));
  end if;
  select ot_date into old_date from public.orl_ot_sessions where id=a.session_id;
  select s.ot_date into new_date
  from public.orl_ot_sessions s
  where s.id=b.session_id and s.status='ACTIVE'
    and (s.holiday_override or not exists(
      select 1 from public.orl_holidays h where h.holiday_date=s.ot_date and h.is_active
    ));
  if not found then raise exception 'The selected OT date is closed or blocked by a holiday.'; end if;
  new_status:=case when u.role='STAFF' then 'RESERVED' else 'CONFIRMED' end;
  update public.orl_ot_slots set request_id=null,status='AVAILABLE',updated_by=u.id,updated_at=now() where id=a.id;
  update public.orl_ot_slots set request_id=r.id,status=new_status,updated_by=u.id,updated_at=now() where id=b.id;
  update public.orl_requests set
    patient_ic=coalesce(safe_data->>'patient_ic',patient_ic),mrn=coalesce(safe_data->>'mrn',mrn),
    patient_name=coalesce(safe_data->>'patient_name',patient_name),surgery=coalesce(safe_data->>'surgery',surgery),
    diagnosis=coalesce(safe_data->>'diagnosis',diagnosis),doctor=coalesce(safe_data->>'doctor',doctor),
    specialist=coalesce(safe_data->>'specialist',specialist),sub_specialty=coalesce(safe_data->>'sub_specialty',sub_specialty),
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
end $$;
revoke all on function public.orl_move_postponed(uuid,uuid,uuid,jsonb,text) from public;
grant execute on function public.orl_move_postponed(uuid,uuid,uuid,jsonb,text) to anon,authenticated;
notify pgrst,'reload schema';
commit;
