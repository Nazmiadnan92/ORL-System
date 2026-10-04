-- LOCAL ONLY: C1 step 10. Never install this file directly in production.
begin;
do $$ begin
 if session_user<>'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet
   or to_regprocedure('public.orl_ic_c1_repair(uuid,text,uuid,text)') is null then
   raise exception 'Local complete C1 runner required';
 end if;
end $$;

-- Scheduled records already save manual counts atomically through protected Edit.
-- This narrow path exists only for a request that currently has no OT slot.
create function public.orl_ic_c1_unscheduled_count(p_session_token uuid,p_request_id uuid,p_count integer,
  p_expected_version timestamptz,p_generation uuid)
returns integer language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype; r public.orl_requests%rowtype;
begin
 u:=public.orl_require_session(p_session_token);
 if u.role<>'WEBMASTER' then raise exception 'Webmaster access required'; end if;
 if p_count is null or p_count not between 0 and 999 then raise exception 'Invalid postpone count'; end if;
 perform orl_private.c1_check_generation(p_generation);
 select * into r from public.orl_requests where id=p_request_id for update;
 if not found or r.updated_at is distinct from p_expected_version then
   raise exception 'Request changed. Reload before editing the count';
 end if;
 if r.assigned_slot_id is not null then raise exception 'Use scheduled-patient Edit for this count'; end if;
 if r.status in('CANCELLED','COMPLETED') then raise exception 'Closed request count cannot be changed'; end if;
 perform public.orl_set_postpone_count(p_session_token,p_request_id,p_count);
 insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
 values(u.id,u.display_name,u.role,'POSTPONE_COUNT_UPDATED','REQUEST',p_request_id::text,
   'Unscheduled manual count: '||coalesce(r.postpone_count,0)||' to '||p_count);
 return p_count;
end $$;
revoke all on function public.orl_ic_c1_unscheduled_count(uuid,uuid,integer,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.orl_ic_c1_unscheduled_count(uuid,uuid,integer,timestamptz,uuid) to service_role;
commit;
