-- Move proposals refer to the existing request UUID; no clinical data is copied.
-- Queue references intentionally have no FK: application Restore replaces public
-- rows and rotates generation. Pending proposals then become INVALIDATED even if
-- request UUIDs are reused. Queue history is included in full database backups
-- only; this migration does not expand the application backup format.
begin;
set local lock_timeout='10s';
set local statement_timeout='30s';
do $$
begin
 if to_regclass('orl_private.booking_move_requests') is not null then raise exception '057 already installed; inspect before retrying.'; end if;
 if to_regclass('orl_private.site_maintenance') is null or not orl_private.c1_recovery_ready()
   or not coalesce((orl_private.c6_stats()->>'cutover_complete')::boolean,false)
   or coalesce((orl_private.c6_stats()->>'plaintext_rows')::integer,-1)<>0
   or coalesce((orl_private.c6_stats()->>'identity_mismatch')::integer,-1)<>0 then
   raise exception 'Protected maintenance/recovery baseline missing or identity storage requires repair.';
 end if;
 if exists(select 1 from unnest(array['anon','authenticated','service_role']) r
   where has_function_privilege(r,'public.orl_require_session(uuid)','EXECUTE')) then raise exception 'Private session access must be closed.'; end if;
end $$;

create table orl_private.booking_move_requests(
 id uuid primary key default gen_random_uuid(),request_id uuid not null,from_slot_id uuid not null,
 from_date date not null,target_date date not null check(target_date<>from_date),
 reason text not null check(length(reason) between 1 and 2000),request_version timestamptz not null,generation uuid not null,
 requested_by uuid not null,requested_by_name text not null,
 status text not null default 'PENDING' check(status in('PENDING','APPROVED','REJECTED','INVALIDATED')),
 target_slot_id uuid,reviewed_by uuid,reviewed_by_name text,reviewed_at timestamptz,
 created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp()
);
create unique index booking_move_one_pending on orl_private.booking_move_requests(request_id,generation) where status='PENDING';
create index booking_move_requested_by on orl_private.booking_move_requests(requested_by,created_at desc);
alter table orl_private.booking_move_requests enable row level security;
alter table orl_private.booking_move_requests force row level security;
revoke all on orl_private.booking_move_requests from public,anon,authenticated,service_role;
comment on table orl_private.booking_move_requests is 'Private move proposals; full-database backup only. Application restore invalidates pending proposals through generation rotation. No clinical data or encrypted identity is copied.';

create function orl_private.booking_move_summary(p_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
 -- Redact display text only. IDs, dates and exact revisions are protocol values;
 -- a numeric UUID suffix must never be interpreted as a patient identity number.
 select jsonb_build_object(
  'id',m.id,'request_id',m.request_id,'request_number',r.request_number,
  'patient_name',orl_private.c1_redact_text(r.patient_name),'mrn',orl_private.c1_redact_text(r.mrn),'surgery',orl_private.c1_redact_text(r.surgery),
  'from_slot_id',m.from_slot_id,'from_date',m.from_date,'target_date',m.target_date,'reason',orl_private.c1_redact_text(m.reason),
  'action',case when m.target_date<m.from_date then 'REASSIGN' else 'POSTPONE' end,
  'status',case when m.status='PENDING' and (m.generation is distinct from g.generation
   or r.id is null or r.updated_at is distinct from m.request_version or r.assigned_slot_id is distinct from m.from_slot_id
   or sl.request_id is distinct from m.request_id or r.status not in('SCHEDULED','CONFIRMED') or r.deletion_status<>''
   or sl.status not in('CONFIRMED','RESERVED') or s.status is distinct from 'ACTIVE' or s.ot_date is distinct from m.from_date)
   then 'INVALIDATED' else m.status end,
  'requested_by',m.requested_by,'requested_by_name',orl_private.c1_redact_text(m.requested_by_name),'created_at',m.created_at,
  'move_version',m.updated_at,'request_version',m.request_version,'generation',m.generation,'target_slot_id',m.target_slot_id,
  'reviewed_by_name',orl_private.c1_redact_text(m.reviewed_by_name),'reviewed_at',m.reviewed_at)
 from orl_private.booking_move_requests m cross join orl_private.c1_restore_generation g
 left join public.orl_requests r on r.id=m.request_id and m.generation=g.generation left join public.orl_ot_slots sl on sl.id=m.from_slot_id
 left join public.orl_ot_sessions s on s.id=sl.session_id where m.id=p_id and g.singleton
$$;
revoke all on function orl_private.booking_move_summary(uuid) from public,anon,authenticated,service_role;

create function public.orl_booking_assign_view(p_session_token uuid,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype;r public.orl_requests%rowtype;g uuid;
begin
 u:=public.orl_require_session(p_session_token);
 if u.role not in('ADMIN','WEBMASTER') then raise exception 'Admin or Webmaster access required.'; end if;
 select generation into g from orl_private.c1_restore_generation where singleton;
 perform orl_private.c1_check_generation(g);
 select * into r from public.orl_requests where id=p_request_id;
 if not found or r.status<>'APPROVED' or r.assigned_slot_id is not null or r.deletion_status<>'' then
  raise exception 'Only an approved, unassigned request can be selected.';
 end if;
 return jsonb_build_object('generation',g,'request_version',r.updated_at,'request_id',r.id,
  'patient_name',orl_private.c1_redact_text(r.patient_name),'mrn',orl_private.c1_redact_text(r.mrn),
  'surgery',orl_private.c1_redact_text(r.surgery),'request_number',r.request_number,'status',r.status);
end $$;

create function public.orl_booking_assign_existing(p_session_token uuid,p_request_id uuid,p_target_slot uuid,p_expected_version timestamptz,p_generation uuid)
returns text language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype;r public.orl_requests%rowtype;
begin
 u:=public.orl_require_session(p_session_token);
 if u.role not in('ADMIN','WEBMASTER') then raise exception 'Admin or Webmaster access required.'; end if;
 perform orl_private.c1_check_generation(p_generation);
 -- Conflict with control/holiday writers before reading eligibility. Ordinary
 -- booking writers take the same compatible ROW EXCLUSIVE lock.
 lock table public.orl_settings,public.orl_holidays,public.orl_ot_sessions,public.orl_ot_slots in row exclusive mode nowait;
 perform 1 from public.orl_ot_slots where id=p_target_slot for update;
 select * into r from public.orl_requests where id=p_request_id for update;
 if not found or r.status<>'APPROVED' or r.assigned_slot_id is not null or r.deletion_status<>''
  or p_expected_version is null or r.updated_at is distinct from p_expected_version then
  raise exception 'This approved request changed or was already assigned. Reload before assigning it.';
 end if;
 -- Existing core validates active session, holiday override, free Main/Special
 -- destination and writes the normal assignment audit. It never edits clinical data.
 return public.orl_assign_slot(p_session_token,p_request_id,p_target_slot);
end $$;

create function public.orl_booking_move_view(p_session_token uuid,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype;r public.orl_requests%rowtype;sl public.orl_ot_slots%rowtype;s public.orl_ot_sessions%rowtype;g uuid;pending uuid;
begin
 u:=public.orl_require_session(p_session_token);
 select generation into g from orl_private.c1_restore_generation where singleton;perform orl_private.c1_check_generation(g);
 select * into r from public.orl_requests where id=p_request_id;
 if not found or (u.role='STAFF' and r.created_by is distinct from u.id) then raise exception 'Request not found or access denied.'; end if;
 select * into sl from public.orl_ot_slots where id=r.assigned_slot_id;
 select * into s from public.orl_ot_sessions where id=sl.session_id;
 if sl.id is null or sl.request_id is distinct from r.id or sl.status not in('CONFIRMED','RESERVED')
  or r.status not in('SCHEDULED','CONFIRMED') or r.deletion_status<>'' or s.status is distinct from 'ACTIVE' then
  raise exception 'This request has no active booking available to move.';
 end if;
 select m.id into pending from orl_private.booking_move_requests m where m.request_id=r.id and m.generation=g and m.status='PENDING'
  and m.request_version=r.updated_at and m.from_slot_id=sl.id;
 return jsonb_build_object('generation',g,'request_id',r.id,'request_number',r.request_number,
  'patient_name',orl_private.c1_redact_text(r.patient_name),'mrn',orl_private.c1_redact_text(r.mrn),
  'surgery',orl_private.c1_redact_text(r.surgery),'status',r.status,'postpone_count',r.postpone_count,
  'from_slot_id',sl.id,'from_date',s.ot_date,'from_slot_type',sl.slot_type,'from_slot_number',sl.slot_number,
  'request_version',r.updated_at,'pending_move_id',pending);
end $$;

-- Staff may propose a date with Special availability without seeing or choosing
-- individual Special slots. Admin/Webmaster selects the actual slot on review.
create function public.orl_booking_move_dates(p_session_token uuid,p_year integer,p_month integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype;g uuid;result jsonb;
begin
 u:=public.orl_require_session(p_session_token);
 select generation into g from orl_private.c1_restore_generation where singleton;
 perform orl_private.c1_check_generation(g);
 perform public.orl_prepare_schedule(p_session_token,p_year,p_month);
 select coalesce(jsonb_agg(jsonb_build_object('ot_date',s.ot_date,'day_name',orl_private.c1_redact_text(s.day_name),'status',s.status,
  'special_title',orl_private.c1_redact_text(s.special_title),'generation',g,'available_slots',
   (select count(*) from public.orl_ot_slots sl where sl.session_id=s.id and sl.status='AVAILABLE' and sl.request_id is null))
  order by s.ot_date),'[]'::jsonb) into result
 from public.orl_ot_sessions s where s.ot_date>=make_date(p_year,p_month,1)
  and s.ot_date<(make_date(p_year,p_month,1)+interval '1 month')::date and s.status='ACTIVE'
  and (s.holiday_override or not exists(select 1 from public.orl_holidays h where h.holiday_date=s.ot_date and h.is_active));
 return result;
end $$;

create function public.orl_booking_move_request(p_session_token uuid,p_request_id uuid,p_target_date date,p_reason text,
 p_expected_from_slot uuid,p_expected_version timestamptz,p_generation uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype;r public.orl_requests%rowtype;sl public.orl_ot_slots%rowtype;s public.orl_ot_sessions%rowtype;
 m orl_private.booking_move_requests%rowtype;clean_reason text;move_id uuid;
begin
 u:=public.orl_require_session(p_session_token);perform orl_private.c1_check_generation(p_generation);
 lock table public.orl_settings,public.orl_holidays,public.orl_ot_sessions,public.orl_ot_slots in row exclusive mode nowait;
 clean_reason:=orl_private.c1_redact_text(btrim(coalesce(p_reason,'')));
 if p_target_date is null or not isfinite(p_target_date) or extract(year from p_target_date) not between 2026 and 2100
  or clean_reason='' or length(clean_reason)>2000 or p_expected_from_slot is null or p_expected_version is null then
  raise exception 'Choose a valid target date and enter a reason (maximum 2000 characters).';
 end if;
 -- Match existing workflow lock order: affected slots, request, then queue.
 perform 1 from public.orl_ot_slots where id=p_expected_from_slot for update;
 select * into r from public.orl_requests where id=p_request_id for update;
 if not found or (u.role='STAFF' and r.created_by is distinct from u.id) then raise exception 'Request not found or access denied.'; end if;
 select * into sl from public.orl_ot_slots where id=p_expected_from_slot;
 select * into s from public.orl_ot_sessions where id=sl.session_id;
 if r.updated_at is distinct from p_expected_version or r.assigned_slot_id is distinct from p_expected_from_slot
  or sl.request_id is distinct from r.id or r.status not in('SCHEDULED','CONFIRMED') or sl.status not in('CONFIRMED','RESERVED')
  or r.deletion_status<>'' or s.status is distinct from 'ACTIVE' then raise exception 'The original booking changed. Reload it before requesting a move.'; end if;
 if p_target_date=s.ot_date then raise exception 'Duplicate booking rejected: this case is already booked on the selected date. The original booking is unchanged.'; end if;
 if not exists(select 1 from public.orl_ot_sessions target join public.orl_ot_slots slot on slot.session_id=target.id
  where target.ot_date=p_target_date and target.status='ACTIVE' and slot.status='AVAILABLE' and slot.request_id is null
   and (target.holiday_override or not exists(select 1 from public.orl_holidays h where h.holiday_date=target.ot_date and h.is_active))) then
  raise exception 'The target date has no eligible available slot. Reload the schedule.';
 end if;
 update orl_private.booking_move_requests set status='INVALIDATED',updated_at=clock_timestamp()
 where request_id=r.id and status='PENDING' and (generation is distinct from p_generation
  or request_version is distinct from r.updated_at or from_slot_id is distinct from sl.id);
 select * into m from orl_private.booking_move_requests where request_id=r.id and generation=p_generation and status='PENDING' for update;
 if found then
  if m.target_date=p_target_date and m.reason=clean_reason and m.requested_by=u.id then return orl_private.booking_move_summary(m.id); end if;
  raise exception 'This case already has a pending move request. Review it before requesting another move.';
 end if;
 insert into orl_private.booking_move_requests(request_id,from_slot_id,from_date,target_date,reason,request_version,generation,requested_by,requested_by_name)
 values(r.id,sl.id,s.ot_date,p_target_date,clean_reason,r.updated_at,p_generation,u.id,u.display_name) returning id into move_id;
 insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
 values(u.id,u.display_name,u.role,'BOOKING_MOVE_REQUESTED','REQUEST',r.id::text,
  jsonb_build_object('move_id',move_id,'from',s.ot_date,'to',p_target_date,'reason',clean_reason)::text);
 return orl_private.booking_move_summary(move_id);
end $$;

create function public.orl_booking_move_list(p_session_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype;g uuid;result jsonb;
begin
 u:=public.orl_require_session(p_session_token);
 select generation into g from orl_private.c1_restore_generation where singleton;perform orl_private.c1_check_generation(g);
 select coalesce(jsonb_agg(orl_private.booking_move_summary(m.id) order by m.created_at desc),'[]'::jsonb) into result
 from(select id,created_at from orl_private.booking_move_requests where u.role in('ADMIN','WEBMASTER') or (requested_by=u.id and generation=g)
  order by created_at desc) m;
 return result;
end $$;

create function public.orl_booking_move_review(p_session_token uuid,p_move_id uuid,p_action text,p_target_slot uuid,
 p_expected_move_version timestamptz,p_expected_request_version timestamptz,p_generation uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype;m orl_private.booking_move_requests%rowtype;r public.orl_requests%rowtype;
 a public.orl_ot_slots%rowtype;b public.orl_ot_slots%rowtype;source_date date;destination_date date;move_action text;revision timestamptz;
begin
 u:=public.orl_require_session(p_session_token);
 if u.role not in('ADMIN','WEBMASTER') then raise exception 'Admin or Webmaster approval is required.'; end if;
 perform orl_private.c1_check_generation(p_generation);
 lock table public.orl_settings,public.orl_holidays,public.orl_ot_sessions,public.orl_ot_slots in row exclusive mode nowait;
 if p_action is null or p_action not in('APPROVE','REJECT') or p_expected_move_version is null or p_expected_request_version is null
  or (p_action='APPROVE' and p_target_slot is null) or (p_action='REJECT' and p_target_slot is not null) then raise exception 'Invalid move review.'; end if;
 select * into m from orl_private.booking_move_requests where id=p_move_id;
 if not found or m.generation is distinct from p_generation then raise exception 'Move request missing or invalidated by Restore. Reload the list.'; end if;
 -- Lock both sessions in the same slot order as checked cancellation/movement,
 -- then the request, then proposal. An occupied destination is never swapped.
 perform 1 from public.orl_ot_slots where session_id in(select session_id from public.orl_ot_slots where id in(m.from_slot_id,p_target_slot)) order by id for update;
 select * into r from public.orl_requests where id=m.request_id for update;
 select * into m from orl_private.booking_move_requests where id=p_move_id for update;
 if m.status<>'PENDING' or m.updated_at is distinct from p_expected_move_version then raise exception 'This move was already reviewed or changed. Reload the list to reconcile the result.'; end if;
 if m.generation is distinct from p_generation or m.request_version is distinct from p_expected_request_version then raise exception 'Move snapshot changed. Reload the list.'; end if;
 if p_action='REJECT' then
  update orl_private.booking_move_requests set status='REJECTED',reviewed_by=u.id,reviewed_by_name=u.display_name,reviewed_at=clock_timestamp(),updated_at=clock_timestamp() where id=m.id;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
  values(u.id,u.display_name,u.role,'BOOKING_MOVE_REJECTED','REQUEST',m.request_id::text,jsonb_build_object('move_id',m.id)::text);
  return orl_private.booking_move_summary(m.id);
 end if;
 select * into a from public.orl_ot_slots where id=m.from_slot_id;select * into b from public.orl_ot_slots where id=p_target_slot;
 if r.id is null or r.updated_at is distinct from m.request_version or r.assigned_slot_id is distinct from a.id
  or a.request_id is distinct from r.id or a.status not in('CONFIRMED','RESERVED') or r.status not in('SCHEDULED','CONFIRMED')
  or r.deletion_status<>'' then raise exception 'The original booking changed. No move was applied; reload and request again.'; end if;
 select ot_date into source_date from public.orl_ot_sessions where id=a.session_id and status='ACTIVE';
 select ot_date into destination_date from public.orl_ot_sessions s where id=b.session_id and s.status='ACTIVE'
  and (s.holiday_override or not exists(select 1 from public.orl_holidays h where h.holiday_date=s.ot_date and h.is_active));
 if source_date is distinct from m.from_date or destination_date is distinct from m.target_date or b.id is null
  or b.request_id is not null or b.status<>'AVAILABLE' then raise exception 'The selected date or slot is no longer available. The original booking is unchanged.'; end if;
 if destination_date=source_date then raise exception 'Duplicate booking rejected: this case is already booked on the selected date.'; end if;
 move_action:=case when destination_date<source_date then 'REASSIGN' else 'POSTPONE' end;
 if move_action='POSTPONE' and r.postpone_count>=999 then raise exception 'Postpone count has reached its maximum. No move was applied.'; end if;
 revision:=greatest(clock_timestamp(),r.updated_at+interval '1 microsecond');
 update public.orl_ot_slots set request_id=null,status='AVAILABLE',updated_by=u.id,updated_at=revision where id=a.id;
 update public.orl_ot_slots set request_id=r.id,status='CONFIRMED',updated_by=u.id,updated_at=revision where id=b.id;
 update public.orl_requests set assigned_slot_id=b.id,status='SCHEDULED',postpone_count=postpone_count+case when move_action='POSTPONE' then 1 else 0 end,
  postpone_history=case when move_action='POSTPONE' then postpone_history||jsonb_build_array(jsonb_build_object('date',revision,'by',u.display_name,
   'from',source_date||' '||a.slot_type||' Slot '||a.slot_number,'to',destination_date||' '||b.slot_type||' Slot '||b.slot_number,'reason',m.reason,'move_id',m.id)) else postpone_history end,
  updated_at=revision where id=r.id;
 update orl_private.booking_move_requests set status='APPROVED',target_slot_id=b.id,reviewed_by=u.id,reviewed_by_name=u.display_name,reviewed_at=revision,updated_at=revision where id=m.id;
 insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
 values(u.id,u.display_name,u.role,case when move_action='POSTPONE' then 'PATIENT_POSTPONED' else 'PATIENT_REASSIGNED' end,'REQUEST',r.id::text,
  jsonb_build_object('move_id',m.id,'from',source_date,'to',destination_date,'from_slot',a.id,'to_slot',b.id,'reason',m.reason,'requested_by',m.requested_by)::text);
 return orl_private.booking_move_summary(m.id);
end $$;

-- Same-date protection at the shared assignment boundary, including approved
-- duplicate overrides. Existing request creation already serializes this case
-- heuristic. Different procedures on the same MRN remain separate bookings.
create function orl_private.booking_same_date_guard()
returns trigger language plpgsql security definer set search_path='' as $$
declare case_mrn text;case_surgery text;target_date date;
begin
 if new.request_id is null or new.status not in('RESERVED','CONFIRMED') then return new; end if;
 select lower(btrim(mrn)),lower(regexp_replace(btrim(surgery),'\s+',' ','g')) into case_mrn,case_surgery
 from public.orl_requests where id=new.request_id and status not in('CANCELLED','COMPLETED','REJECTED');
 if case_mrn is null or case_mrn='' or case_surgery is null or case_surgery='' then return new; end if;
 select ot_date into target_date from public.orl_ot_sessions where id=new.session_id;
 perform pg_advisory_xact_lock(hashtextextended(case_mrn||chr(31)||case_surgery,0));
 if exists(select 1 from public.orl_ot_slots slot join public.orl_ot_sessions session on session.id=slot.session_id
  join public.orl_requests r on r.id=slot.request_id where slot.id<>new.id and slot.request_id<>new.request_id
   and session.ot_date=target_date and slot.status in('RESERVED','CONFIRMED') and r.status not in('CANCELLED','COMPLETED','REJECTED')
   and lower(btrim(r.mrn))=case_mrn and lower(regexp_replace(btrim(r.surgery),'\s+',' ','g'))=case_surgery) then
  raise exception 'Duplicate booking rejected: the same MRN and procedure already has an active booking on this date. Keep the original case and use Request move.';
 end if;
 return new;
end $$;
revoke all on function orl_private.booking_same_date_guard() from public,anon,authenticated,service_role;
create trigger orl_booking_same_date_guard before insert or update of request_id,session_id,status on public.orl_ot_slots
 for each row execute function orl_private.booking_same_date_guard();

revoke all on function public.orl_booking_assign_view(uuid,uuid),public.orl_booking_assign_existing(uuid,uuid,uuid,timestamptz,uuid),
 public.orl_booking_move_view(uuid,uuid),public.orl_booking_move_request(uuid,uuid,date,text,uuid,timestamptz,uuid),
 public.orl_booking_move_list(uuid),public.orl_booking_move_dates(uuid,integer,integer),
 public.orl_booking_move_review(uuid,uuid,text,uuid,timestamptz,timestamptz,uuid) from public,anon,authenticated,service_role;
grant execute on function public.orl_booking_assign_view(uuid,uuid),public.orl_booking_assign_existing(uuid,uuid,uuid,timestamptz,uuid),
 public.orl_booking_move_view(uuid,uuid),public.orl_booking_move_request(uuid,uuid,date,text,uuid,timestamptz,uuid),
 public.orl_booking_move_list(uuid),public.orl_booking_move_dates(uuid,integer,integer),
 public.orl_booking_move_review(uuid,uuid,text,uuid,timestamptz,timestamptz,uuid) to anon,authenticated;
notify pgrst,'reload schema';
commit;
