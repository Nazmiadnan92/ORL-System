-- ORL OT Management System: expose request origin for interactive OT schedule
-- Run once in Supabase SQL Editor after 024.

begin;

create or replace function public.orl_get_schedule(
  p_session_token uuid,
  p_year integer,
  p_month integer
)
returns table(
  session_id uuid,ot_date date,day_name text,status text,note text,
  special_title text,holiday_name text,slots jsonb
)
language plpgsql security definer set search_path=public,extensions as $$
declare
  v_user public.orl_users%rowtype;
begin
  v_user:=public.orl_require_session(p_session_token);
  perform public.orl_prepare_schedule(p_session_token,p_year,p_month);

  return query
  select
    s.id,s.ot_date,s.day_name,
    case when h.id is not null and s.status='ACTIVE' and not s.holiday_override
      then 'HOLIDAY' else s.status end,
    s.note,s.special_title,coalesce(h.title,''),
    coalesce(jsonb_agg(jsonb_build_object(
      'id',sl.id,
      'type',sl.slot_type,
      'number',sl.slot_number,
      'status',sl.status,
      'request_id',sl.request_id,
      'request_status',r.status,
      'deletion_status',r.deletion_status,
      'created_by',r.created_by,
      'created_by_role',creator.role,
      'patient_name',r.patient_name,
      'patient_ic',r.patient_ic,
      'age',r.age,
      'mrn',r.mrn,
      'surgery',r.surgery,
      'diagnosis',r.diagnosis,
      'doctor',r.doctor,
      'specialist',r.specialist,
      'sub_specialty',r.sub_specialty,
      'phone',r.phone,
      'remark',r.remark,
      'postpone_count',r.postpone_count
    ) order by case when sl.slot_type='MAIN' then 0 else 1 end,sl.slot_number),'[]'::jsonb)
  from public.orl_ot_sessions s
  left join public.orl_holidays h on h.holiday_date=s.ot_date and h.is_active
  left join public.orl_ot_slots sl
    on sl.session_id=s.id and (v_user.role<>'STAFF' or sl.slot_type='MAIN')
  left join public.orl_requests r on r.id=sl.request_id
  left join public.orl_users creator on creator.id=r.created_by
  where extract(year from s.ot_date)=p_year
    and extract(month from s.ot_date)=p_month
  group by s.id,h.id,h.title
  order by s.ot_date;
end $$;

grant execute on function public.orl_get_schedule(uuid,integer,integer) to anon,authenticated;

notify pgrst, 'reload schema';
commit;
