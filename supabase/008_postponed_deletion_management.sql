-- ORL OT Management System: Postponed and Deletion Management
begin;

create or replace function public.orl_get_postponed(p_session_token uuid)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype;
begin
  v_user:=public.orl_require_session(p_session_token); if v_user.role not in('ADMIN','WEBMASTER') then raise exception 'Admin access required.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'request_number',r.request_number,'patient_name',r.patient_name,'patient_ic',r.patient_ic,'mrn',r.mrn,'surgery',r.surgery,'diagnosis',r.diagnosis,'sub_specialty',r.sub_specialty,'doctor',r.doctor,'specialist',r.specialist,'status',r.status,'postpone_count',r.postpone_count,'history',r.postpone_history,'first_postponed',r.postpone_history->0->>'date','last_postponed',r.postpone_history->(jsonb_array_length(r.postpone_history)-1)->>'date') order by r.postpone_history->0->>'date') from public.orl_requests r where r.postpone_count>0),'[]'::jsonb);
end $$;

create or replace function public.orl_request_deletion(p_session_token uuid,p_request_id uuid,p_reason text)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype; v_req public.orl_requests%rowtype;
begin
  v_user:=public.orl_require_session(p_session_token); select * into v_req from public.orl_requests where id=p_request_id for update;
  if not found then raise exception 'Request not found.'; end if;
  if v_user.role='STAFF' and v_req.created_by<>v_user.id then raise exception 'You do not have access.'; end if;
  if v_req.status in('COMPLETED','CANCELLED') then raise exception 'This request is already closed.'; end if;
  if v_req.deletion_status='PENDING' then raise exception 'A deletion request is already pending.'; end if;
  update public.orl_requests set deletion_status='PENDING',deletion_reason=trim(p_reason),deletion_requested_by=v_user.id,deletion_requested_at=now(),updated_at=now() where id=p_request_id;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details) values(v_user.id,v_user.display_name,v_user.role,'DELETION_REQUESTED','REQUEST',p_request_id::text,trim(p_reason));
end $$;

create or replace function public.orl_get_deletions(p_session_token uuid)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype;
begin
  v_user:=public.orl_require_session(p_session_token); if v_user.role not in('ADMIN','WEBMASTER') then raise exception 'Admin access required.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'request_number',r.request_number,'patient_name',r.patient_name,'patient_ic',r.patient_ic,'mrn',r.mrn,'surgery',r.surgery,'status',r.status,'requested_by',u.display_name,'reason',r.deletion_reason,'requested_at',r.deletion_requested_at) order by r.deletion_requested_at) from public.orl_requests r left join public.orl_users u on u.id=r.deletion_requested_by where r.deletion_status='PENDING'),'[]'::jsonb);
end $$;

create or replace function public.orl_resolve_deletion(p_session_token uuid,p_request_id uuid,p_action text)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype; v_req public.orl_requests%rowtype; v_slot public.orl_ot_slots%rowtype; packed jsonb; item jsonb; target_id uuid; n integer:=1;
begin
  v_user:=public.orl_require_session(p_session_token); if v_user.role not in('ADMIN','WEBMASTER') then raise exception 'Admin access required.'; end if;
  select * into v_req from public.orl_requests where id=p_request_id for update; if not found or v_req.deletion_status<>'PENDING' then raise exception 'No pending deletion request.'; end if;
  if upper(p_action)='REJECT' then
    update public.orl_requests set deletion_status='',deletion_reason='',deletion_requested_by=null,deletion_requested_at=null,updated_at=now() where id=p_request_id;
  elsif upper(p_action)='APPROVE' then
    if v_req.assigned_slot_id is not null then
      select * into v_slot from public.orl_ot_slots where id=v_req.assigned_slot_id for update;
      update public.orl_ot_slots set request_id=null,status='AVAILABLE',updated_by=v_user.id,updated_at=now() where id=v_slot.id;
      if v_slot.slot_type='MAIN' then
        select coalesce(jsonb_agg(jsonb_build_object('request_id',request_id,'status',status) order by slot_number),'[]'::jsonb) into packed from public.orl_ot_slots where session_id=v_slot.session_id and slot_type='MAIN' and request_id is not null;
        update public.orl_ot_slots set request_id=null,status='AVAILABLE' where session_id=v_slot.session_id and slot_type='MAIN';
        for item in select * from jsonb_array_elements(packed) loop
          select id into target_id from public.orl_ot_slots where session_id=v_slot.session_id and slot_type='MAIN' and slot_number=n;
          update public.orl_ot_slots set request_id=(item->>'request_id')::uuid,status=item->>'status',updated_by=v_user.id,updated_at=now() where id=target_id;
          update public.orl_requests set assigned_slot_id=target_id where id=(item->>'request_id')::uuid; n:=n+1;
        end loop;
      end if;
    end if;
    update public.orl_requests set status='CANCELLED',assigned_slot_id=null,deletion_status='APPROVED',updated_at=now() where id=p_request_id;
  else raise exception 'Invalid action.'; end if;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details) values(v_user.id,v_user.display_name,v_user.role,'DELETION_'||upper(p_action),'REQUEST',p_request_id::text,v_req.deletion_reason);
end $$;

grant execute on function public.orl_get_postponed(uuid),public.orl_request_deletion(uuid,uuid,text),public.orl_get_deletions(uuid),public.orl_resolve_deletion(uuid,uuid,text) to anon,authenticated;
commit;
