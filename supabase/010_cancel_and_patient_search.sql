-- ORL OT Management System: cancellation frees slot; MRN patient search
begin;

create or replace function public.orl_edit_scheduled_request(p_session_token uuid,p_slot_id uuid,p_data jsonb,p_action text)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype; v_slot public.orl_ot_slots%rowtype; v_req public.orl_requests%rowtype; act text:=upper(p_action);
begin
  v_user:=public.orl_require_session(p_session_token);
  select * into v_slot from public.orl_ot_slots where id=p_slot_id for update;
  select * into v_req from public.orl_requests where id=v_slot.request_id for update;
  if not found then raise exception 'Assigned request not found.'; end if;
  if v_user.role='STAFF' and v_req.created_by<>v_user.id then raise exception 'You do not have access.'; end if;
  if act not in('CONFIRM','POSTPONE','CANCEL') then raise exception 'Invalid status action.'; end if;
  update public.orl_requests set patient_ic=coalesce(p_data->>'patient_ic',patient_ic),mrn=coalesce(p_data->>'mrn',mrn),patient_name=coalesce(p_data->>'patient_name',patient_name),surgery=coalesce(p_data->>'surgery',surgery),diagnosis=coalesce(p_data->>'diagnosis',diagnosis),doctor=coalesce(p_data->>'doctor',doctor),specialist=coalesce(p_data->>'specialist',specialist),sub_specialty=coalesce(p_data->>'sub_specialty',sub_specialty),phone=coalesce(p_data->>'phone',phone),remark=coalesce(p_data->>'remark',remark),status=case when act='CANCEL' then 'CANCELLED' when act='CONFIRM' and v_user.role in('ADMIN','WEBMASTER') then 'SCHEDULED' else status end,assigned_slot_id=case when act='CANCEL' then null else assigned_slot_id end,updated_at=now() where id=v_req.id;
  if act='CONFIRM' and v_user.role in('ADMIN','WEBMASTER') then
    update public.orl_ot_slots set status='CONFIRMED',updated_by=v_user.id,updated_at=now() where id=p_slot_id;
  elsif act='CANCEL' then
    update public.orl_ot_slots set request_id=null,status='AVAILABLE',updated_by=v_user.id,updated_at=now() where id=p_slot_id;
    if v_slot.slot_type='MAIN' then perform public.orl_compact_main(v_slot.session_id,v_user.id); end if;
  end if;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details) values(v_user.id,v_user.display_name,v_user.role,'SLOT_EDIT_'||act,'REQUEST',v_req.id::text,case when act='CANCEL' then 'Patient cancelled; OT slot released' else 'Patient details updated' end);
end $$;

create or replace function public.orl_find_patient(p_session_token uuid,p_mrn text)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype;
begin
  v_user:=public.orl_require_session(p_session_token);
  if length(trim(coalesce(p_mrn,'')))<2 then raise exception 'Enter a valid MRN number.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'request_number',r.request_number,'patient_name',r.patient_name,'patient_ic',r.patient_ic,'mrn',r.mrn,'surgery',r.surgery,'diagnosis',r.diagnosis,'doctor',r.doctor,'specialist',r.specialist,'sub_specialty',r.sub_specialty,'phone',r.phone,'remark',r.remark,'status',r.status,'postpone_count',r.postpone_count,'created_at',r.created_at,'ot_date',s.ot_date,'slot_type',sl.slot_type,'slot_number',sl.slot_number) order by r.created_at desc) from public.orl_requests r left join public.orl_ot_slots sl on sl.id=r.assigned_slot_id left join public.orl_ot_sessions s on s.id=sl.session_id where lower(trim(r.mrn))=lower(trim(p_mrn))),'[]'::jsonb);
end $$;

grant execute on function public.orl_edit_scheduled_request(uuid,uuid,jsonb,text),public.orl_find_patient(uuid,text) to anon,authenticated;
commit;
