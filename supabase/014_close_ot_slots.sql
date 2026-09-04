-- ORL OT Management System: Admin/Webmaster can close and reopen empty OT slots
begin;

alter table public.orl_ot_slots drop constraint if exists orl_ot_slots_status_check;
alter table public.orl_ot_slots add constraint orl_ot_slots_status_check check(status in('AVAILABLE','RESERVED','CONFIRMED','CLOSED'));

create or replace function public.orl_compact_main(p_session_id uuid,p_user_id uuid)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare packed jsonb; item jsonb; target_id uuid; n integer:=0;
begin
  select coalesce(jsonb_agg(jsonb_build_object('request_id',request_id,'status',status) order by slot_number),'[]'::jsonb) into packed
  from public.orl_ot_slots where session_id=p_session_id and slot_type='MAIN' and request_id is not null;
  update public.orl_ot_slots set request_id=null,status='AVAILABLE' where session_id=p_session_id and slot_type='MAIN' and status<>'CLOSED';
  for item in select * from jsonb_array_elements(packed) loop
    select id into target_id from public.orl_ot_slots where session_id=p_session_id and slot_type='MAIN' and status<>'CLOSED' order by slot_number offset n limit 1;
    if target_id is null then raise exception 'Not enough open Main slots to compact this OT list.'; end if;
    update public.orl_ot_slots set request_id=(item->>'request_id')::uuid,status=item->>'status',updated_by=p_user_id,updated_at=now() where id=target_id;
    update public.orl_requests set assigned_slot_id=target_id,updated_at=now() where id=(item->>'request_id')::uuid; n:=n+1;
  end loop;
end $$;
revoke all on function public.orl_compact_main(uuid,uuid) from public,anon,authenticated;

create or replace function public.orl_set_slot_closed(p_session_token uuid,p_slot_id uuid,p_closed boolean)
returns text language plpgsql security definer set search_path=public,extensions as $$
declare u public.orl_users%rowtype; sl public.orl_ot_slots%rowtype; new_status text;
begin
  u:=public.orl_require_session(p_session_token);
  if u.role not in('ADMIN','WEBMASTER') then raise exception 'Admin access required.'; end if;
  select * into sl from public.orl_ot_slots where id=p_slot_id for update;
  if not found then raise exception 'OT slot not found.'; end if;
  if sl.request_id is not null then raise exception 'An occupied slot cannot be closed. Reassign, postpone or clear the patient first.'; end if;
  if p_closed and sl.status<>'AVAILABLE' then raise exception 'Only an available slot can be closed.'; end if;
  if not p_closed and sl.status<>'CLOSED' then raise exception 'Only a closed slot can be reopened.'; end if;
  new_status:=case when p_closed then 'CLOSED' else 'AVAILABLE' end;
  update public.orl_ot_slots set status=new_status,updated_by=u.id,updated_at=now() where id=p_slot_id;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details) values(u.id,u.display_name,u.role,case when p_closed then 'OT_SLOT_CLOSED' else 'OT_SLOT_REOPENED' end,'OT_SLOT',p_slot_id::text,sl.slot_type||' Slot '||sl.slot_number);
  return new_status;
end $$;

create or replace function public.orl_resolve_deletion(p_session_token uuid,p_request_id uuid,p_action text)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare u public.orl_users%rowtype; r public.orl_requests%rowtype; sl public.orl_ot_slots%rowtype;
begin
  u:=public.orl_require_session(p_session_token); if u.role not in('ADMIN','WEBMASTER') then raise exception 'Admin access required.'; end if;
  select * into r from public.orl_requests where id=p_request_id for update; if not found or r.deletion_status<>'PENDING' then raise exception 'No pending deletion request.'; end if;
  if upper(p_action)='REJECT' then update public.orl_requests set deletion_status='',deletion_reason='',deletion_requested_by=null,deletion_requested_at=null,updated_at=now() where id=p_request_id;
  elsif upper(p_action)='APPROVE' then
    if r.assigned_slot_id is not null then select * into sl from public.orl_ot_slots where id=r.assigned_slot_id for update; update public.orl_ot_slots set request_id=null,status='AVAILABLE',updated_by=u.id,updated_at=now() where id=sl.id; if sl.slot_type='MAIN' then perform public.orl_compact_main(sl.session_id,u.id); end if; end if;
    update public.orl_requests set status='CANCELLED',assigned_slot_id=null,deletion_status='APPROVED',updated_at=now() where id=p_request_id;
  else raise exception 'Invalid action.'; end if;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details) values(u.id,u.display_name,u.role,'DELETION_'||upper(p_action),'REQUEST',p_request_id::text,r.deletion_reason);
end $$;

grant execute on function public.orl_set_slot_closed(uuid,uuid,boolean),public.orl_resolve_deletion(uuid,uuid,text) to anon,authenticated;
commit;
