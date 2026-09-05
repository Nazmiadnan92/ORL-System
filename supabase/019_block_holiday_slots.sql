-- ORL OT Management System: block holiday slots and support explicit Admin/Webmaster override
-- Run once in Supabase SQL Editor after 018.

begin;

alter table public.orl_ot_sessions
  add column if not exists holiday_override boolean not null default false;

update public.orl_ot_sessions s
set holiday_override=false
where exists(
  select 1 from public.orl_holidays h
  where h.holiday_date=s.ot_date and h.is_active
);

create or replace function public.orl_reset_holiday_override()
returns trigger
language plpgsql
security definer
set search_path=public,extensions
as $$
begin
  if new.is_active then
    update public.orl_ot_sessions
    set holiday_override=false
    where ot_date=new.holiday_date;
  end if;
  return new;
end $$;

drop trigger if exists orl_holiday_resets_override on public.orl_holidays;
create trigger orl_holiday_resets_override
after insert or update of holiday_date,is_active on public.orl_holidays
for each row execute function public.orl_reset_holiday_override();

create or replace function public.orl_get_year_month_counts(p_session_token uuid,p_year integer)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype; m integer;
begin
  v_user:=public.orl_require_session(p_session_token);
  for m in 1..12 loop perform public.orl_prepare_schedule(p_session_token,p_year,m); end loop;
  return coalesce((select jsonb_agg(jsonb_build_object('month',x.m,'available',x.available) order by x.m) from
    (select m.m,count(sl.id) filter(where sl.status='AVAILABLE' and s.status='ACTIVE' and (h.id is null or s.holiday_override))::integer available
     from generate_series(1,12)m(m)
     left join public.orl_ot_sessions s on extract(year from s.ot_date)=p_year and extract(month from s.ot_date)=m.m
     left join public.orl_holidays h on h.holiday_date=s.ot_date and h.is_active
     left join public.orl_ot_slots sl on sl.session_id=s.id and (v_user.role<>'STAFF' or sl.slot_type='MAIN')
     group by m.m)x),'[]'::jsonb);
end $$;

create or replace function public.orl_get_schedule(p_session_token uuid,p_year integer,p_month integer)
returns table(session_id uuid,ot_date date,day_name text,status text,note text,special_title text,holiday_name text,slots jsonb)
language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype;
begin
  v_user:=public.orl_require_session(p_session_token);
  perform public.orl_prepare_schedule(p_session_token,p_year,p_month);
  return query
  select s.id,s.ot_date,s.day_name,
    case when h.id is not null and s.status='ACTIVE' and not s.holiday_override then 'HOLIDAY' else s.status end,
    s.note,s.special_title,coalesce(h.title,''),
    coalesce(jsonb_agg(jsonb_build_object(
      'id',sl.id,'type',sl.slot_type,'number',sl.slot_number,'status',sl.status,
      'request_id',sl.request_id,'request_status',r.status,'created_by',r.created_by,
      'patient_name',r.patient_name,'patient_ic',r.patient_ic,'mrn',r.mrn,
      'surgery',r.surgery,'diagnosis',r.diagnosis,'doctor',r.doctor,
      'specialist',r.specialist,'sub_specialty',r.sub_specialty,'phone',r.phone,
      'remark',r.remark,'postpone_count',r.postpone_count)
      order by case when sl.slot_type='MAIN' then 0 else 1 end,sl.slot_number),'[]'::jsonb)
  from public.orl_ot_sessions s
  left join public.orl_holidays h on h.holiday_date=s.ot_date and h.is_active
  left join public.orl_ot_slots sl on sl.session_id=s.id and (v_user.role<>'STAFF' or sl.slot_type='MAIN')
  left join public.orl_requests r on r.id=sl.request_id
  where extract(year from s.ot_date)=p_year and extract(month from s.ot_date)=p_month
  group by s.id,h.id,h.title
  order by s.ot_date;
end $$;

create or replace function public.orl_set_session(p_session_token uuid,p_session_id uuid,p_status text,p_title text default null)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare u public.orl_users%rowtype; s public.orl_ot_sessions%rowtype; is_holiday boolean;
begin
  u:=public.orl_require_session(p_session_token);
  if u.role not in('ADMIN','WEBMASTER') then raise exception 'Admin access required.'; end if;
  if p_status is not null and p_status not in('ACTIVE','CANCELLED') then raise exception 'Invalid OT status.'; end if;
  select * into s from public.orl_ot_sessions where id=p_session_id for update;
  if not found then raise exception 'OT session not found.'; end if;
  select exists(select 1 from public.orl_holidays h where h.holiday_date=s.ot_date and h.is_active) into is_holiday;
  update public.orl_ot_sessions
  set status=coalesce(p_status,status),
      special_title=coalesce(p_title,special_title),
      holiday_override=case
        when p_status='ACTIVE' and is_holiday then true
        when p_status is not null then false
        else holiday_override
      end,
      updated_by=u.id,updated_at=now()
  where id=p_session_id;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
  values(u.id,u.display_name,u.role,
    case when p_status='ACTIVE' and is_holiday then 'HOLIDAY_OVERRIDE_ACTIVATED' else 'OT_SESSION_UPDATED' end,
    'OT_SESSION',p_session_id::text,coalesce(p_status,'')||' '||coalesce(p_title,''));
end $$;

create or replace function public.orl_assign_slot(p_session_token uuid,p_request_id uuid,p_slot_id uuid)
returns text
language plpgsql security definer set search_path=public,extensions as $$
declare u public.orl_users%rowtype; r public.orl_requests%rowtype; sl public.orl_ot_slots%rowtype; slot_status text;
begin
  u:=public.orl_require_session(p_session_token);
  select * into r from public.orl_requests where id=p_request_id for update;
  if not found then raise exception 'Request not found.'; end if;
  if u.role='STAFF' and r.created_by<>u.id then raise exception 'You can only assign your own request.'; end if;
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
  if not found or sl.status<>'AVAILABLE' then raise exception 'This OT slot is unavailable or blocked by a holiday.'; end if;
  if u.role='STAFF' and sl.slot_type='SPECIAL' then raise exception 'Special slots are available to Admin and Webmaster only.'; end if;
  slot_status:=case when u.role in('ADMIN','WEBMASTER') then 'CONFIRMED' else 'RESERVED' end;
  update public.orl_ot_slots set request_id=r.id,status=slot_status,updated_by=u.id,updated_at=now() where id=sl.id;
  update public.orl_requests set assigned_slot_id=sl.id,status=case when slot_status='CONFIRMED' then 'SCHEDULED' else 'CONFIRMED' end,updated_at=now() where id=r.id;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
  values(u.id,u.display_name,u.role,case when slot_status='CONFIRMED' then 'PATIENT_ASSIGNED_CONFIRMED' else 'OT_SLOT_RESERVED' end,'REQUEST',r.id::text,'OT slot assigned');
  return slot_status;
end $$;

create or replace function public.orl_move_postponed(p_session_token uuid,p_from_slot_id uuid,p_to_slot_id uuid,p_data jsonb,p_reason text)
returns text language plpgsql security definer set search_path=public,extensions as $$
declare u public.orl_users%rowtype; a public.orl_ot_slots%rowtype; b public.orl_ot_slots%rowtype; r public.orl_requests%rowtype; old_date date; new_date date; new_status text;
begin
  u:=public.orl_require_session(p_session_token);
  select * into a from public.orl_ot_slots where id=p_from_slot_id for update;
  select * into b from public.orl_ot_slots where id=p_to_slot_id for update;
  if a.id is null or a.request_id is null then raise exception 'Original patient slot not found.'; end if;
  if b.id is null or b.request_id is not null or b.status<>'AVAILABLE' then raise exception 'The selected slot is no longer available.'; end if;
  select * into r from public.orl_requests where id=a.request_id for update;
  if u.role='STAFF' and r.created_by<>u.id then raise exception 'You do not have access.'; end if;
  if u.role='STAFF' and b.slot_type='SPECIAL' then raise exception 'Special slots are available to Admin and Webmaster only.'; end if;
  select ot_date into old_date from public.orl_ot_sessions where id=a.session_id;
  select s.ot_date into new_date
  from public.orl_ot_sessions s
  where s.id=b.session_id and s.status='ACTIVE'
    and (s.holiday_override or not exists(
      select 1 from public.orl_holidays h where h.holiday_date=s.ot_date and h.is_active
    ));
  if not found then raise exception 'The selected OT date is closed or blocked by a holiday.'; end if;
  new_status:=case when u.role='STAFF' then 'RESERVED' else 'CONFIRMED' end;
  update public.orl_ot_slots set request_id=null,status='AVAILABLE',updated_by=u.id,updated_at=now() where id=a.id;
  update public.orl_ot_slots set request_id=r.id,status=new_status,updated_by=u.id,updated_at=now() where id=b.id;
  update public.orl_requests set
    patient_ic=coalesce(p_data->>'patient_ic',patient_ic),mrn=coalesce(p_data->>'mrn',mrn),
    patient_name=coalesce(p_data->>'patient_name',patient_name),surgery=coalesce(p_data->>'surgery',surgery),
    diagnosis=coalesce(p_data->>'diagnosis',diagnosis),doctor=coalesce(p_data->>'doctor',doctor),
    specialist=coalesce(p_data->>'specialist',specialist),sub_specialty=coalesce(p_data->>'sub_specialty',sub_specialty),
    phone=coalesce(p_data->>'phone',phone),remark=coalesce(p_data->>'remark',remark),assigned_slot_id=b.id,
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

revoke all on function public.orl_reset_holiday_override() from public,anon,authenticated;
grant execute on function public.orl_get_year_month_counts(uuid,integer),public.orl_get_schedule(uuid,integer,integer),public.orl_set_session(uuid,uuid,text,text),public.orl_assign_slot(uuid,uuid,uuid),public.orl_move_postponed(uuid,uuid,uuid,jsonb,text) to anon,authenticated;

notify pgrst, 'reload schema';
commit;
