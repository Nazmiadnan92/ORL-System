-- ORL OT Management System: My Requests and Admin request review

begin;

create or replace function public.orl_get_requests(p_session_token uuid)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.orl_users%rowtype;
begin
  v_user := public.orl_require_session(p_session_token);
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id',r.id,'request_number',r.request_number,'patient_name',r.patient_name,'mrn',r.mrn,
    'surgery',r.surgery,'doctor',r.doctor,'status',r.status,'created_at',r.created_at,
    'postpone_count',r.postpone_count,'ot_date',s.ot_date,'slot_type',sl.slot_type,'slot_number',sl.slot_number
  ) order by r.created_at desc)
  from public.orl_requests r
  left join public.orl_ot_slots sl on sl.id=r.assigned_slot_id
  left join public.orl_ot_sessions s on s.id=sl.session_id
  where v_user.role <> 'STAFF' or r.created_by=v_user.id), '[]'::jsonb);
end;
$$;

create or replace function public.orl_review_request(p_session_token uuid, p_request_id uuid, p_action text, p_note text default '')
returns text
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.orl_users%rowtype; v_request public.orl_requests%rowtype;
begin
  v_user:=public.orl_require_session(p_session_token);
  if v_user.role not in ('ADMIN','WEBMASTER') then raise exception 'Admin access required.'; end if;
  select r.* into v_request from public.orl_requests r where r.id=p_request_id for update;
  if not found then raise exception 'Request not found.'; end if;
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

grant execute on function public.orl_get_requests(uuid),public.orl_review_request(uuid,uuid,text,text) to anon,authenticated;

commit;
