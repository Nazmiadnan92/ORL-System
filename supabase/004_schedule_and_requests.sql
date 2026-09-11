-- ORL OT Management System: schedule, slots and request workflow

begin;

create sequence if not exists public.orl_request_number_seq;

alter table public.orl_requests
  add column if not exists assigned_slot_id uuid unique;

create or replace function public.orl_require_session(p_session_token uuid)
returns public.orl_users
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.orl_users%rowtype;
begin
  select u.* into v_user
  from public.orl_sessions s
  join public.orl_users u on u.id = s.user_id
  where s.token_hash = encode(digest(p_session_token::text, 'sha256'), 'hex')
    and s.expires_at > now() and u.is_active = true;
  if not found then raise exception 'Your session has expired. Please sign in again.' using errcode = '28000'; end if;
  return v_user;
end;
$$;

create or replace function public.orl_prepare_schedule(p_session_token uuid, p_year integer, p_month integer)
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.orl_users%rowtype; v_main integer; v_special integer;
begin
  v_user := public.orl_require_session(p_session_token);
  if p_year not between 2026 and 2100 or p_month not between 1 and 12 then raise exception 'Invalid schedule period.'; end if;
  select setting_value::integer into v_main from public.orl_settings where setting_key = 'MAIN_SLOTS';
  select setting_value::integer into v_special from public.orl_settings where setting_key = 'SPECIAL_SLOTS';
  insert into public.orl_ot_sessions (ot_date, day_name)
  select d::date, trim(to_char(d, 'Day'))
  from generate_series(make_date(p_year,p_month,1), (make_date(p_year,p_month,1) + interval '1 month - 1 day')::date, interval '1 day') d
  where extract(dow from d) in (0,3)
    and not exists (select 1 from public.orl_holidays h where h.holiday_date = d::date and h.is_active)
  on conflict (ot_date) do nothing;
  insert into public.orl_ot_slots (session_id, slot_type, slot_number)
  select s.id, x.slot_type, n
  from public.orl_ot_sessions s
  cross join (values ('MAIN'::text, v_main), ('SPECIAL'::text, v_special)) x(slot_type, maximum)
  cross join lateral generate_series(1, x.maximum) n
  where extract(year from s.ot_date) = p_year and extract(month from s.ot_date) = p_month
  on conflict (session_id, slot_type, slot_number) do nothing;
end;
$$;

create or replace function public.orl_get_schedule(p_session_token uuid, p_year integer, p_month integer)
returns table(session_id uuid, ot_date date, day_name text, status text, note text, special_title text, slots jsonb)
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.orl_users%rowtype;
begin
  v_user := public.orl_require_session(p_session_token);
  perform public.orl_prepare_schedule(p_session_token, p_year, p_month);
  return query
  select s.id, s.ot_date, s.day_name, s.status, s.note, s.special_title,
    coalesce(jsonb_agg(jsonb_build_object('id',sl.id,'type',sl.slot_type,'number',sl.slot_number,'status',sl.status,'request_id',sl.request_id,'patient_name',r.patient_name) order by sl.slot_type, sl.slot_number), '[]'::jsonb)
  from public.orl_ot_sessions s
  left join public.orl_ot_slots sl on sl.session_id = s.id
  left join public.orl_requests r on r.id = sl.request_id
  where extract(year from s.ot_date) = p_year and extract(month from s.ot_date) = p_month
  group by s.id
  order by s.ot_date;
end;
$$;

create or replace function public.orl_create_request(p_session_token uuid, p_data jsonb)
returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.orl_users%rowtype; v_id uuid; v_number text;
begin
  v_user := public.orl_require_session(p_session_token);
  v_number := 'REQ-' || to_char(current_date,'YYYY') || '-' || lpad(nextval('public.orl_request_number_seq')::text, 6, '0');
  insert into public.orl_requests (request_number,patient_ic,mrn,patient_name,surgery,diagnosis,doctor,specialist,sub_specialty,phone,remark,created_by)
  values (v_number, coalesce(p_data->>'patient_ic',''), coalesce(p_data->>'mrn',''), coalesce(p_data->>'patient_name',''), coalesce(p_data->>'surgery',''), coalesce(p_data->>'diagnosis',''), coalesce(p_data->>'doctor',''), coalesce(p_data->>'specialist',''), coalesce(p_data->>'sub_specialty',''), coalesce(p_data->>'phone',''), coalesce(p_data->>'remark',''), v_user.id)
  returning id into v_id;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
  values(v_user.id,v_user.display_name,v_user.role,'REQUEST_CREATED','REQUEST',v_id::text,'Draft request created');
  return v_id;
end;
$$;

create or replace function public.orl_confirm_request(p_session_token uuid, p_request_id uuid)
returns text
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.orl_users%rowtype; v_request public.orl_requests%rowtype; v_status text;
begin
  v_user := public.orl_require_session(p_session_token);
  select r.* into v_request from public.orl_requests r where r.id = p_request_id for update;
  if not found then raise exception 'Request not found.'; end if;
  if v_user.role = 'STAFF' and v_request.created_by <> v_user.id then raise exception 'You can only confirm your own request.'; end if;
  if v_request.status <> 'DRAFT' then raise exception 'Only a draft request can be confirmed.'; end if;
  if v_user.role in ('ADMIN','WEBMASTER') then v_status := 'APPROVED'; else v_status := 'CONFIRMED'; end if;
  update public.orl_requests set status=v_status, confirmed_at=now(), reviewed_by=case when v_status='APPROVED' then v_user.id else null end, reviewed_at=case when v_status='APPROVED' then now() else null end, review_note=case when v_status='APPROVED' then 'Direct entry by Admin' else '' end, updated_at=now() where id=v_request.id;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
  values(v_user.id,v_user.display_name,v_user.role,'REQUEST_CONFIRMED','REQUEST',v_request.id::text,'Request ready for OT slot selection');
  return v_status;
end;
$$;

create or replace function public.orl_assign_slot(p_session_token uuid, p_request_id uuid, p_slot_id uuid)
returns text
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.orl_users%rowtype; v_request public.orl_requests%rowtype; v_slot public.orl_ot_slots%rowtype; v_slot_status text;
begin
  v_user := public.orl_require_session(p_session_token);
  select r.* into v_request from public.orl_requests r where r.id = p_request_id for update;
  if not found then raise exception 'Request not found.'; end if;
  if v_user.role='STAFF' and v_request.created_by <> v_user.id then raise exception 'You can only assign your own request.'; end if;
  if v_request.assigned_slot_id is not null then raise exception 'This request already has an OT slot.'; end if;
  if v_user.role='STAFF' and v_request.status <> 'CONFIRMED' then raise exception 'Confirm the request before reserving a slot.'; end if;
  if v_user.role in ('ADMIN','WEBMASTER') and v_request.status not in ('CONFIRMED','APPROVED') then raise exception 'This request cannot be assigned yet.'; end if;
  select sl.* into v_slot from public.orl_ot_slots sl join public.orl_ot_sessions s on s.id=sl.session_id where sl.id=p_slot_id and s.status='ACTIVE' for update;
  if not found or v_slot.status <> 'AVAILABLE' then raise exception 'This OT slot is no longer available.'; end if;
  if v_user.role='STAFF' and v_slot.slot_type='SPECIAL' then raise exception 'Special slots are available to Admin and Webmaster only.'; end if;
  if v_user.role in ('ADMIN','WEBMASTER') then v_slot_status := 'CONFIRMED'; else v_slot_status := 'RESERVED'; end if;
  update public.orl_ot_slots set request_id=v_request.id,status=v_slot_status,updated_by=v_user.id,updated_at=now() where id=v_slot.id;
  update public.orl_requests set assigned_slot_id=v_slot.id,status=case when v_slot_status='CONFIRMED' then 'SCHEDULED' else 'CONFIRMED' end,updated_at=now() where id=v_request.id;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
  values(v_user.id,v_user.display_name,v_user.role,case when v_slot_status='CONFIRMED' then 'PATIENT_ASSIGNED_CONFIRMED' else 'OT_SLOT_RESERVED' end,'REQUEST',v_request.id::text,'OT slot assigned');
  return v_slot_status;
end;
$$;

create or replace function public.orl_get_dashboard(p_session_token uuid)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_user public.orl_users%rowtype;
begin
  v_user := public.orl_require_session(p_session_token);
  return jsonb_build_object(
    'draft', (select count(*) from public.orl_requests r where (v_user.role <> 'STAFF' or r.created_by=v_user.id) and r.status='DRAFT'),
    'confirmed', (select count(*) from public.orl_requests r where (v_user.role <> 'STAFF' or r.created_by=v_user.id) and r.status='CONFIRMED'),
    'scheduled', (select count(*) from public.orl_requests r where (v_user.role <> 'STAFF' or r.created_by=v_user.id) and r.status='SCHEDULED'),
    'upcoming_ot', (select count(*) from public.orl_ot_sessions s where s.ot_date >= current_date and s.status='ACTIVE')
  );
end;
$$;

revoke all on function public.orl_require_session(uuid) from public;
grant execute on function public.orl_prepare_schedule(uuid,integer,integer), public.orl_get_schedule(uuid,integer,integer), public.orl_create_request(uuid,jsonb), public.orl_confirm_request(uuid,uuid), public.orl_assign_slot(uuid,uuid,uuid), public.orl_get_dashboard(uuid) to anon, authenticated;

commit;
