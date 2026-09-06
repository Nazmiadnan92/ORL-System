-- ORL OT Management System: 10 Main slots for 2026, 5 from 2027 onward
-- Run once in Supabase SQL Editor after 019.

begin;

update public.orl_settings
set setting_value='5', updated_at=now()
where setting_key='MAIN_SLOTS';

create or replace function public.orl_prepare_schedule(p_session_token uuid,p_year integer,p_month integer)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype; v_main integer; v_special integer;
begin
  v_user:=public.orl_require_session(p_session_token);
  if p_year not between 2026 and 2100 or p_month not between 1 and 12 then
    raise exception 'Invalid schedule period.';
  end if;

  v_main:=case when p_year=2026 then 10 else 5 end;
  select setting_value::integer into v_special
  from public.orl_settings where setting_key='SPECIAL_SLOTS';

  insert into public.orl_ot_sessions(ot_date,day_name)
  select d::date,trim(to_char(d,'Day'))
  from generate_series(
    make_date(p_year,p_month,1),
    (make_date(p_year,p_month,1)+interval '1 month - 1 day')::date,
    interval '1 day'
  ) d
  where extract(dow from d) in (0,3)
  on conflict(ot_date) do nothing;

  insert into public.orl_ot_slots(session_id,slot_type,slot_number)
  select s.id,x.slot_type,n
  from public.orl_ot_sessions s
  cross join (values('MAIN'::text,v_main),('SPECIAL'::text,v_special)) x(slot_type,maximum)
  cross join lateral generate_series(1,x.maximum) n
  where extract(year from s.ot_date)=p_year
    and extract(month from s.ot_date)=p_month
  on conflict(session_id,slot_type,slot_number) do nothing;
end $$;

-- Immediately add Main Slots 6-10 to every 2026 OT date already generated.
insert into public.orl_ot_slots(session_id,slot_type,slot_number)
select s.id,'MAIN',n
from public.orl_ot_sessions s
cross join generate_series(1,10) n
where extract(year from s.ot_date)=2026
on conflict(session_id,slot_type,slot_number) do nothing;

grant execute on function public.orl_prepare_schedule(uuid,integer,integer) to anon,authenticated;

notify pgrst, 'reload schema';
commit;
