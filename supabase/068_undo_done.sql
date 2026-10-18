-- Password-confirmed Webmaster correction of an accidentally completed episode.
-- Installation changes no patient data. Existing completion events are retained.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $baseline$
declare item record;
begin
 if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='orl_ic_undo_done') then
  raise exception '068: Undo Done already exists or installation is partial. Inspect before retrying.';
 end if;
 if orl_private.c1_recovery_ready() is distinct from true
  or (orl_private.c6_stats()->>'cutover_complete')::boolean is distinct from true then
  raise exception '068: completed protected recovery/cutover baseline required.';
 end if;
 for item in select * from (values
  ('public.orl_swap_slots_checked(uuid,uuid,uuid,uuid,uuid)','b32dcd4c6ecda6bfd6e2adba0d2248e6'),
  ('public.orl_ic_c1_reassign(uuid,uuid,uuid,uuid,uuid,uuid)','2b4d1a321a41bed78ff559b3ec542d19'),
  ('public.orl_require_session(uuid)','ba9d29923e7269729c8025bf1e266208'),
  ('public.orl_require_webmaster_password(uuid,text)','db8fc906a57e43110f61b1a4c54bfeff'),
  ('orl_private.c1_check_generation(uuid)','5c654a99ad55c29ba66b9b74371c8239'),
  ('orl_private.c1_redact_text(text)','aea30f10772d86163fb1aa4e2362fac3'),
  ('public.orl_ic_ot_lifecycle(uuid,uuid,uuid,text,text,uuid,timestamptz)','23f48d226ea2fa298821f8cfe06c5ffa'),
  ('public.orl_ic_past_case_save(uuid,text,text,uuid,uuid,jsonb,text,text,jsonb,jsonb,uuid,text,timestamptz)','163c7e2855fe88f37f3360aec891158c'),
  ('public.orl_ic_c1_mutate(uuid,text,uuid,uuid,uuid,jsonb,text,text,text,jsonb,jsonb,uuid,timestamptz)','3b951b49b1638b8bb268e8fc972074a0')
 ) v(signature,expected_md5) loop
  if not coalesce((select prosecdef and md5(replace(prosrc,chr(13),''))=item.expected_md5
   and (proconfig @> array['search_path=""'] or proconfig @> array['search_path=public, extensions'])
   from pg_proc where oid=to_regprocedure(item.signature)),false) then
   raise exception '068: reviewed protected baseline differs: %',item.signature;
  end if;
 end loop;
 if exists(select 1 from unnest(array['anon','authenticated','service_role']) client
  cross join unnest(array['public.orl_swap_slots_checked(uuid,uuid,uuid,uuid,uuid)',
   'public.orl_require_session(uuid)','orl_private.c1_check_generation(uuid)']) signature
  where has_function_privilege(client,signature,'EXECUTE'))
  or exists(select 1 from unnest(array['anon','authenticated']) client
   where has_function_privilege(client,'public.orl_require_webmaster_password(uuid,text)','EXECUTE')
    or has_function_privilege(client,'public.orl_ic_ot_lifecycle(uuid,uuid,uuid,text,text,uuid,timestamptz)','EXECUTE')) then
  raise exception '068: protected permissions differ.';
 end if;
 if (select count(*) from pg_constraint where conrelid='public.orl_requests'::regclass
  and conname in('orl_requests_completion_state','orl_requests_ot_hold_state') and convalidated)<>2 then
  raise exception '068: lifecycle constraints missing.';
 end if;
end $baseline$;

create function public.orl_ic_undo_done(p_session_token uuid,p_password text,p_request_id uuid,p_slot_id uuid,
 p_reason text,p_generation uuid,p_expected_version timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype;r public.orl_requests%rowtype;sl public.orl_ot_slots%rowtype;
 ot_day date;revision timestamptz;clean_reason text;case_mrn text;case_surgery text;
begin
 if p_password is null or length(p_password) not between 1 and 1024 then
  raise exception 'Current Webmaster password required.' using errcode='42501';
 end if;
 u:=public.orl_require_webmaster_password(p_session_token,p_password);
 if p_request_id is null or p_slot_id is null or p_expected_version is null or not isfinite(p_expected_version)
  or p_reason is null or length(p_reason)>4096 or p_reason !~ '[^[:space:]]' then
  raise exception 'A current patient selection and correction reason are required.';
 end if;
 perform orl_private.c1_check_generation(p_generation);
 -- Rare corrective action: prevent concurrent case creation AND clinical edits
 -- changing a different episode's duplicate key. Fail fast, never wait while
 -- holding this table fence for another workflow's slot/request/proposal locks.
 lock table public.orl_requests in share row exclusive mode nowait;
 perform 1 from public.orl_ot_slots
  where session_id=(select session_id from public.orl_ot_slots where id=p_slot_id)
  order by id for update nowait;
 select * into sl from public.orl_ot_slots where id=p_slot_id;
 select * into r from public.orl_requests where id=p_request_id for update nowait;
 if not found or r.updated_at is distinct from p_expected_version
  or r.assigned_slot_id is distinct from p_slot_id or sl.request_id is distinct from p_request_id
  or sl.status is distinct from 'CONFIRMED' or r.status is distinct from 'COMPLETED'
  or r.deletion_status is distinct from '' then
  raise exception 'The completed OT patient changed. Reload the schedule and review again.';
 end if;
 select ot_date into ot_day from public.orl_ot_sessions where id=sl.session_id for share nowait;
 if ot_day is null or ot_day>(clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date then
  raise exception 'Undo Done is limited to an existing operation on today or a past OT date.';
 end if;
 case_mrn:=lower(btrim(coalesce(r.mrn,'')));
 case_surgery:=lower(regexp_replace(btrim(coalesce(r.surgery,'')),'\s+',' ','g'));
 if case_mrn='' or case_surgery='' then
  raise exception 'The existing episode must have an MRN and procedure before Undo Done.';
 end if;
 -- Match the existing creation/assignment case heuristic, not identity data.
 -- Try-lock also avoids a cycle with CREATE holding this key before INSERT.
 if not pg_try_advisory_xact_lock(hashtextextended(case_mrn||chr(31)||case_surgery,0)) then
  raise exception 'Another case update is in progress. Reload and review before retrying.';
 end if;
 if exists(select 1 from public.orl_requests other where other.id<>r.id
  and other.status not in('CANCELLED','COMPLETED','REJECTED')
  and lower(btrim(other.mrn))=case_mrn
  and lower(regexp_replace(btrim(other.surgery),'\s+',' ','g'))=case_surgery) then
  raise exception 'Undo Done rejected: another active episode has the same MRN and procedure.';
 end if;
 perform 1 from orl_private.booking_move_requests where request_id=r.id
  and generation=p_generation and status='PENDING' order by id for update nowait;
 revision:=greatest(clock_timestamp(),r.updated_at+interval '1 microsecond');
 -- Even a password accidentally pasted into the reason must never be audited.
 clean_reason:=orl_private.c1_redact_text(btrim(replace(p_reason,p_password,'[redacted]')));
 insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
 values(u.id,u.display_name,u.role,'OT_DONE_REVERSED','REQUEST',r.id::text,
  jsonb_build_object('ot_date',ot_day,'slot_id',sl.id,'reason',clean_reason,
   'previous_status','COMPLETED','new_status','SCHEDULED','previous_hold',r.ot_hold,
   'original_completed_at',r.completed_at,'original_completed_by',r.completed_by)::text);
 -- Preserve the original OT_MARKED_DONE events; clear only the live markers.
 update public.orl_requests set status='SCHEDULED',completed_at=null,completed_by=null,updated_at=revision where id=r.id;
 update orl_private.booking_move_requests set status='INVALIDATED',updated_at=revision
  where request_id=r.id and generation=p_generation and status='PENDING';
 return jsonb_build_object('request_id',r.id,'slot_id',sl.id,'status','SCHEDULED','action','UNDO_DONE','ot_hold',r.ot_hold);
end $$;
revoke all on function public.orl_ic_undo_done(uuid,text,uuid,uuid,text,uuid,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_undo_done(uuid,text,uuid,uuid,text,uuid,timestamptz) to service_role;

notify pgrst,'reload schema';
commit;
