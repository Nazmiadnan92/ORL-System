-- ORL OT Management System: role-aware operational dashboard
begin;

create or replace function public.orl_admission_date(p_ot_date date)
returns date language sql stable security definer set search_path=public,extensions as $$
  select max(d::date)
  from generate_series(p_ot_date-16,p_ot_date-2,interval '1 day') d
  where extract(dow from d) not in (5,6)
    and not exists (select 1 from public.orl_holidays h where h.holiday_date=d::date and h.is_active);
$$;
revoke all on function public.orl_admission_date(date) from public,anon,authenticated;

create or replace function public.orl_get_dashboard(p_session_token uuid)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare
  u public.orl_users%rowtype;
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
begin
  u:=public.orl_require_session(p_session_token);
  return jsonb_build_object(
    'draft',(select count(*) from public.orl_requests r where (u.role<>'STAFF' or r.created_by=u.id) and r.status='DRAFT'),
    'confirmed',(select count(*) from public.orl_requests r where (u.role<>'STAFF' or r.created_by=u.id) and r.status='CONFIRMED'),
    'scheduled',(select count(*) from public.orl_requests r where (u.role<>'STAFF' or r.created_by=u.id) and r.status='SCHEDULED'),
    'upcoming_ot',(select count(*) from public.orl_ot_sessions s where s.ot_date>=today and s.status='ACTIVE'),
    'reserved',(select count(*) from public.orl_ot_slots sl join public.orl_requests r on r.id=sl.request_id where sl.status='RESERVED' and (u.role<>'STAFF' or r.created_by=u.id)),
    'pending_cancellations',(select count(*) from public.orl_requests r where r.deletion_status='PENDING' and (u.role<>'STAFF' or r.created_by=u.id)),
    'postponed',(select count(*) from public.orl_requests r where r.postpone_count>0 and (u.role<>'STAFF' or r.created_by=u.id)),
    'available_month',(select count(*) from public.orl_ot_slots sl join public.orl_ot_sessions s on s.id=sl.session_id where sl.status='AVAILABLE' and s.status='ACTIVE' and extract(year from s.ot_date)=extract(year from today) and extract(month from s.ot_date)=extract(month from today) and (u.role<>'STAFF' or sl.slot_type='MAIN')),
    'closed_month',(select count(*) from public.orl_ot_slots sl join public.orl_ot_sessions s on s.id=sl.session_id where sl.status='CLOSED' and extract(year from s.ot_date)=extract(year from today) and extract(month from s.ot_date)=extract(month from today) and (u.role<>'STAFF' or sl.slot_type='MAIN')),
    'next_ot',coalesce((select jsonb_build_object(
      'date',s.ot_date,'day_name',s.day_name,'title',s.special_title,'admission_date',public.orl_admission_date(s.ot_date),
      'available',(select count(*) from public.orl_ot_slots x where x.session_id=s.id and x.status='AVAILABLE' and (u.role<>'STAFF' or x.slot_type='MAIN')),
      'reserved',(select count(*) from public.orl_ot_slots x where x.session_id=s.id and x.status='RESERVED' and (u.role<>'STAFF' or x.slot_type='MAIN')),
      'confirmed',(select count(*) from public.orl_ot_slots x where x.session_id=s.id and x.status='CONFIRMED' and (u.role<>'STAFF' or x.slot_type='MAIN')),
      'closed',(select count(*) from public.orl_ot_slots x where x.session_id=s.id and x.status='CLOSED' and (u.role<>'STAFF' or x.slot_type='MAIN'))
    ) from public.orl_ot_sessions s where s.ot_date>=today and s.status='ACTIVE' and not exists(select 1 from public.orl_holidays h where h.holiday_date=s.ot_date and h.is_active) order by s.ot_date limit 1),'null'::jsonb),
    'month_capacity',jsonb_build_object(
      'available',(select count(*) from public.orl_ot_slots sl join public.orl_ot_sessions s on s.id=sl.session_id where sl.status='AVAILABLE' and s.status='ACTIVE' and date_trunc('month',s.ot_date)=date_trunc('month',today) and (u.role<>'STAFF' or sl.slot_type='MAIN')),
      'reserved',(select count(*) from public.orl_ot_slots sl join public.orl_ot_sessions s on s.id=sl.session_id join public.orl_requests r on r.id=sl.request_id where sl.status='RESERVED' and s.status='ACTIVE' and date_trunc('month',s.ot_date)=date_trunc('month',today) and (u.role<>'STAFF' or r.created_by=u.id)),
      'confirmed',(select count(*) from public.orl_ot_slots sl join public.orl_ot_sessions s on s.id=sl.session_id join public.orl_requests r on r.id=sl.request_id where sl.status='CONFIRMED' and s.status='ACTIVE' and date_trunc('month',s.ot_date)=date_trunc('month',today) and (u.role<>'STAFF' or r.created_by=u.id)),
      'closed',(select count(*) from public.orl_ot_slots sl join public.orl_ot_sessions s on s.id=sl.session_id where sl.status='CLOSED' and date_trunc('month',s.ot_date)=date_trunc('month',today) and (u.role<>'STAFF' or sl.slot_type='MAIN'))
    ),
    'pending_actions',jsonb_build_object(
      'requests',case when u.role in('ADMIN','WEBMASTER') then (select count(*) from public.orl_requests where status='CONFIRMED') else 0 end,
      'cancellations',case when u.role in('ADMIN','WEBMASTER') then (select count(*) from public.orl_requests where deletion_status='PENDING') else 0 end,
      'reserved',case when u.role in('ADMIN','WEBMASTER') then (select count(*) from public.orl_ot_slots where status='RESERVED') else 0 end,
      'database_warnings',case when u.role='WEBMASTER' then ((select count(*) from public.orl_requests r where r.status='SCHEDULED' and r.assigned_slot_id is null)+(select count(*) from public.orl_ot_slots sl where (sl.request_id is null and sl.status in('RESERVED','CONFIRMED')) or (sl.request_id is not null and sl.status in('AVAILABLE','CLOSED')))) else 0 end
    ),
    'upcoming_admissions',coalesce((select jsonb_agg(to_jsonb(x) order by x.ot_date,x.slot_type,x.slot_number) from (
      select r.id,r.patient_name,r.mrn,r.surgery,s.ot_date,public.orl_admission_date(s.ot_date) admission_date,sl.slot_type,sl.slot_number,sl.status
      from public.orl_requests r join public.orl_ot_slots sl on sl.id=r.assigned_slot_id join public.orl_ot_sessions s on s.id=sl.session_id
      where s.ot_date>=today and s.status='ACTIVE' and sl.status in('RESERVED','CONFIRMED') and r.status in('CONFIRMED','SCHEDULED') and (u.role<>'STAFF' or r.created_by=u.id)
      order by s.ot_date,sl.slot_type,sl.slot_number limit 8
    )x),'[]'::jsonb),
    'postponed_alerts',coalesce((select jsonb_agg(to_jsonb(x) order by x.postpone_count desc,x.patient_name) from (
      select r.id,r.patient_name,r.mrn,r.surgery,r.postpone_count,s.ot_date
      from public.orl_requests r left join public.orl_ot_slots sl on sl.id=r.assigned_slot_id left join public.orl_ot_sessions s on s.id=sl.session_id
      where r.postpone_count>=2 and r.status<>'CANCELLED' and (u.role<>'STAFF' or r.created_by=u.id)
      order by r.postpone_count desc,r.updated_at desc limit 6
    )x),'[]'::jsonb),
    'special_days',coalesce((select jsonb_agg(to_jsonb(x) order by x.ot_date) from (
      select s.ot_date,s.day_name,s.special_title from public.orl_ot_sessions s where extract(year from s.ot_date)=extract(year from today) and trim(s.special_title)<>'' order by s.ot_date limit 8
    )x),'[]'::jsonb),
    'recent_activity',case when u.role='WEBMASTER' then coalesce((select jsonb_agg(to_jsonb(x) order by x.occurred_at desc) from (
      select a.occurred_at,a.user_name,a.action,a.details from public.orl_audit_log a order by a.occurred_at desc limit 8
    )x),'[]'::jsonb) else '[]'::jsonb end
  );
end $$;

grant execute on function public.orl_get_dashboard(uuid) to anon,authenticated;
commit;
