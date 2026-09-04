-- ORL OT Management System: Staff cancellation requires Admin/Webmaster review
begin;

create or replace function public.orl_edit_scheduled_request(p_session_token uuid,p_slot_id uuid,p_data jsonb,p_action text)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype; v_slot public.orl_ot_slots%rowtype; v_req public.orl_requests%rowtype; act text:=upper(p_action); reason text;
begin
  v_user:=public.orl_require_session(p_session_token);
  select * into v_slot from public.orl_ot_slots where id=p_slot_id for update;
  select * into v_req from public.orl_requests where id=v_slot.request_id for update;
  if not found then raise exception 'Assigned request not found.'; end if;
  if v_user.role='STAFF' and v_req.created_by<>v_user.id then raise exception 'You do not have access.'; end if;
  if act not in('CONFIRM','POSTPONE','CANCEL') then raise exception 'Invalid status action.'; end if;

  update public.orl_requests set patient_ic=coalesce(p_data->>'patient_ic',patient_ic),mrn=coalesce(p_data->>'mrn',mrn),patient_name=coalesce(p_data->>'patient_name',patient_name),surgery=coalesce(p_data->>'surgery',surgery),diagnosis=coalesce(p_data->>'diagnosis',diagnosis),doctor=coalesce(p_data->>'doctor',doctor),specialist=coalesce(p_data->>'specialist',specialist),sub_specialty=coalesce(p_data->>'sub_specialty',sub_specialty),phone=coalesce(p_data->>'phone',phone),remark=coalesce(p_data->>'remark',remark),updated_at=now() where id=v_req.id;

  if act='CANCEL' and v_user.role='STAFF' then
    if v_req.deletion_status='PENDING' then raise exception 'A cancellation request is already pending review.'; end if;
    reason:=coalesce(nullif(trim(p_data->>'cancel_reason'),''),nullif(trim(p_data->>'remark'),''),'Cancellation requested by Staff');
    update public.orl_requests set deletion_status='PENDING',deletion_reason=reason,deletion_requested_by=v_user.id,deletion_requested_at=now(),updated_at=now() where id=v_req.id;
    insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details) values(v_user.id,v_user.display_name,v_user.role,'STAFF_CANCELLATION_REQUESTED','REQUEST',v_req.id::text,reason);
    return;
  end if;

  if act='CONFIRM' and v_user.role in('ADMIN','WEBMASTER') then
    update public.orl_requests set status='SCHEDULED',updated_at=now() where id=v_req.id;
    update public.orl_ot_slots set status='CONFIRMED',updated_by=v_user.id,updated_at=now() where id=p_slot_id;
  elsif act='CANCEL' then
    update public.orl_requests set status='CANCELLED',assigned_slot_id=null,updated_at=now() where id=v_req.id;
    update public.orl_ot_slots set request_id=null,status='AVAILABLE',updated_by=v_user.id,updated_at=now() where id=p_slot_id;
    if v_slot.slot_type='MAIN' then perform public.orl_compact_main(v_slot.session_id,v_user.id); end if;
  end if;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details) values(v_user.id,v_user.display_name,v_user.role,'SLOT_EDIT_'||act,'REQUEST',v_req.id::text,case when act='CANCEL' then 'Patient cancelled by Admin/Webmaster; OT slot released' else 'Patient details updated' end);
end $$;

grant execute on function public.orl_edit_scheduled_request(uuid,uuid,jsonb,text) to anon,authenticated;
commit;
