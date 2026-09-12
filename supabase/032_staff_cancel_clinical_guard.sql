-- Phase 3 cancellation authorization. Production installation confirmed by operator.
-- Preserve Staff cancellation requests; prevent embedded clinical edits.
begin;
create or replace function public.orl_edit_scheduled_request(p_session_token uuid,p_slot_id uuid,p_data jsonb,p_action text)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare
  v_user public.orl_users%rowtype;
  v_slot public.orl_ot_slots%rowtype;
  v_req public.orl_requests%rowtype;
  act text:=upper(p_action); reason text; v_age integer; calculated_age integer; new_ic text;
begin
  v_user:=public.orl_require_session(p_session_token);
  if act not in('CONFIRM','POSTPONE','CANCEL') then raise exception 'Invalid status action.'; end if;
  select * into v_slot from public.orl_ot_slots where id=p_slot_id for update;
  if not found or v_slot.request_id is null then raise exception 'Assigned request not found.'; end if;
  select * into v_req from public.orl_requests where id=v_slot.request_id for update;
  if not found then raise exception 'Assigned request not found.'; end if;
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
revoke all on function public.orl_edit_scheduled_request(uuid,uuid,jsonb,text) from public;
grant execute on function public.orl_edit_scheduled_request(uuid,uuid,jsonb,text) to anon,authenticated;
notify pgrst,'reload schema';
commit;
