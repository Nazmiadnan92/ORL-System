-- Past dates are display-only, never an automatic COMPLETED/CANCELLED status.
-- Guard only new destinations; preserve historical data, restore, export and same-day reordering.
begin;
set local lock_timeout='5s';
do $guard$
begin
 if not exists(select 1 from pg_proc where oid=to_regprocedure('public.orl_assign_slot(uuid,uuid,uuid)') and prosecdef and md5(replace(prosrc,chr(13),''))='3b5a97307623ee4747ff66c0b6d61ecd') then raise exception '061: orl_assign_slot baseline differs; nothing installed.'; end if;
 if not exists(select 1 from pg_proc where oid=to_regprocedure('public.orl_move_postponed_checked(uuid,uuid,uuid,jsonb,text,uuid)') and prosecdef and md5(replace(prosrc,chr(13),''))='9d6a636c394b7a774f37a7084a5aa581') then raise exception '061: orl_move_postponed_checked baseline differs; nothing installed.'; end if;
 if not exists(select 1 from pg_proc where oid=to_regprocedure('public.orl_booking_move_request(uuid,uuid,date,text,uuid,timestamptz,uuid)') and prosecdef and md5(replace(prosrc,chr(13),''))='1769924c9e73acc96660bb3338593847') then raise exception '061: orl_booking_move_request baseline differs; nothing installed.'; end if;
 if not exists(select 1 from pg_proc where oid=to_regprocedure('public.orl_booking_move_review(uuid,uuid,text,uuid,timestamptz,timestamptz,uuid)') and prosecdef and md5(replace(prosrc,chr(13),''))='488b5a16ad3fe7be54f34d59f3006766') then raise exception '061: orl_booking_move_review baseline differs; nothing installed.'; end if;
end $guard$;
create or replace function public.orl_assign_slot(p_session_token uuid,p_request_id uuid,p_slot_id uuid)
returns text
language plpgsql security definer set search_path=public,extensions as $$
declare u public.orl_users%rowtype; r public.orl_requests%rowtype; sl public.orl_ot_slots%rowtype; slot_status text;
begin
  u:=public.orl_require_session(p_session_token);
  -- Acquire the slot before the request, matching slot actions.
  perform 1 from public.orl_ot_slots where id=p_slot_id for update;
  select * into r from public.orl_requests where id=p_request_id for update;
  if not found then raise exception 'Request not found.'; end if;
  if u.role='STAFF' and r.created_by is distinct from u.id then raise exception 'You can only assign your own request.'; end if;
  if r.assigned_slot_id is not null then raise exception 'This request already has an OT slot.'; end if;
  if u.role='STAFF' and r.status<>'CONFIRMED' then raise exception 'Confirm the request before reserving a slot.'; end if;
  if u.role in('ADMIN','WEBMASTER') and r.status not in('CONFIRMED','APPROVED') then raise exception 'This request cannot be assigned yet.'; end if;
  select x.* into sl
  from public.orl_ot_slots x
  join public.orl_ot_sessions s on s.id=x.session_id
  where x.id=p_slot_id and s.status='ACTIVE'
    and (s.holiday_override or not exists(
      select 1 from public.orl_holidays h where h.holiday_date=s.ot_date and h.is_active
    ))
  for update of x;
  if not found or sl.status<>'AVAILABLE' or sl.request_id is not null then raise exception 'This OT slot is unavailable or blocked by a holiday.'; end if;
  if (select ot_date from public.orl_ot_sessions where id=sl.session_id) < (clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date then
    raise exception 'Past OT dates are closed to new bookings. Choose today or a future date.' using errcode='22023';
  end if;
  if u.role='STAFF' and sl.slot_type='SPECIAL' then raise exception 'Special slots are available to Admin and Webmaster only.'; end if;
  slot_status:=case when u.role in('ADMIN','WEBMASTER') then 'CONFIRMED' else 'RESERVED' end;
  update public.orl_ot_slots set request_id=r.id,status=slot_status,updated_by=u.id,updated_at=now() where id=sl.id;
  update public.orl_requests set assigned_slot_id=sl.id,status=case when slot_status='CONFIRMED' then 'SCHEDULED' else 'CONFIRMED' end,updated_at=now() where id=r.id;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
  values(u.id,u.display_name,u.role,case when slot_status='CONFIRMED' then 'PATIENT_ASSIGNED_CONFIRMED' else 'OT_SLOT_RESERVED' end,'REQUEST',r.id::text,'OT slot assigned');
  return slot_status;
end $$;
create or replace function public.orl_move_postponed_checked(p_session_token uuid,p_from_slot_id uuid,p_to_slot_id uuid,p_data jsonb,p_reason text,p_expected_request_id uuid)
returns text language plpgsql security definer set search_path=public,extensions as $$
declare u public.orl_users%rowtype; a public.orl_ot_slots%rowtype; b public.orl_ot_slots%rowtype; r public.orl_requests%rowtype; old_date date; new_date date; new_status text; safe_data jsonb;
begin
  u:=public.orl_require_session(p_session_token);
  -- Lock both sessions' existing slots in one order before taking patient locks.
  perform 1 from public.orl_ot_slots
  where session_id in(select session_id from public.orl_ot_slots where id in(p_from_slot_id,p_to_slot_id))
  order by id for update;
  select * into a from public.orl_ot_slots where id=p_from_slot_id for update;
  select * into b from public.orl_ot_slots where id=p_to_slot_id for update;
  if p_expected_request_id is null or a.request_id is distinct from p_expected_request_id then
    raise exception 'The selected OT patient has changed. Refresh the schedule and select again.';
  end if;
  if a.id is null or a.request_id is null then raise exception 'Original patient slot not found.'; end if;
  if b.id is null or b.request_id is not null or b.status<>'AVAILABLE' then raise exception 'The selected slot is no longer available.'; end if;
  select * into r from public.orl_requests where id=a.request_id for update;
  if not found then raise exception 'Assigned request not found.'; end if;
  if r.assigned_slot_id is distinct from a.id or r.status='CANCELLED' then
    raise exception 'OT slot links are inconsistent. No changes applied; contact Admin.';
  end if;
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
  if new_date < (clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date then
    raise exception 'Past OT dates are closed to new bookings. Choose today or a future date.' using errcode='22023';
  end if;
  new_status:=case when u.role='STAFF' then 'RESERVED' else 'CONFIRMED' end;
  update public.orl_ot_slots set request_id=null,status='AVAILABLE',updated_by=u.id,updated_at=now() where id=a.id;
  update public.orl_ot_slots set request_id=r.id,status=new_status,updated_by=u.id,updated_at=now() where id=b.id;
  update public.orl_requests set
    age_months=case when safe_data ? 'age_months' then public.orl_valid_age_months(safe_data->>'age_months') else age_months end,
    age=coalesce(nullif(trim(safe_data->>'age'),'')::integer,age),
    patient_ic=coalesce(safe_data->>'patient_ic',patient_ic),mrn=coalesce(safe_data->>'mrn',mrn),
    patient_name=coalesce(safe_data->>'patient_name',patient_name),surgery=coalesce(safe_data->>'surgery',surgery),
    diagnosis=coalesce(safe_data->>'diagnosis',diagnosis),doctor=case when u.role='STAFF' then doctor else initcap(coalesce(safe_data->>'doctor',doctor)) end,
    specialist=case when u.role='STAFF' then specialist else initcap(coalesce(safe_data->>'specialist',specialist)) end,sub_specialty=coalesce(safe_data->>'sub_specialty',sub_specialty),
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
create or replace function public.orl_booking_move_request(p_session_token uuid,p_request_id uuid,p_target_date date,p_reason text,
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
  if p_target_date < (clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date then
    raise exception 'Past OT dates are closed to new bookings. Choose today or a future date.' using errcode='22023';
  end if;
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
create or replace function public.orl_booking_move_review(p_session_token uuid,p_move_id uuid,p_action text,p_target_slot uuid,
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
  if destination_date < (clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date then
    raise exception 'Past OT dates are closed to new bookings. Choose today or a future date.' using errcode='22023';
  end if;
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
notify pgrst,'reload schema';
commit;
