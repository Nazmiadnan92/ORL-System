-- Add aggregate availability only; does not change sessions, slots or requests.
begin;
create or replace function public.orl_get_special_ot_days(p_session_token uuid,p_year integer)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype;
begin
  v_user:=public.orl_require_session(p_session_token);
  if p_year is null or p_year not between 2026 and 2100 then raise exception 'Invalid year.'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'session_id',s.id,'date',s.ot_date,'day_name',s.day_name,'title',s.special_title,
      'status',case when s.status='ACTIVE' and not s.holiday_override and exists(
        select 1 from public.orl_holidays h where h.holiday_date=s.ot_date and h.is_active
      ) then 'HOLIDAY' else s.status end,
      'main_available',(select count(*) from public.orl_ot_slots sl where sl.session_id=s.id and sl.slot_type='MAIN' and sl.status='AVAILABLE' and sl.request_id is null),
      'main_closed',(select count(*) from public.orl_ot_slots sl where sl.session_id=s.id and sl.slot_type='MAIN' and sl.status='CLOSED'),
      'main_total',(select count(*) from public.orl_ot_slots sl where sl.session_id=s.id and sl.slot_type='MAIN'),
      'special_available',case when v_user.role in('ADMIN','WEBMASTER') then (select count(*) from public.orl_ot_slots sl where sl.session_id=s.id and sl.slot_type='SPECIAL' and sl.status='AVAILABLE' and sl.request_id is null) else null end,
      'special_closed',case when v_user.role in('ADMIN','WEBMASTER') then (select count(*) from public.orl_ot_slots sl where sl.session_id=s.id and sl.slot_type='SPECIAL' and sl.status='CLOSED') else null end,
      'special_total',case when v_user.role in('ADMIN','WEBMASTER') then (select count(*) from public.orl_ot_slots sl where sl.session_id=s.id and sl.slot_type='SPECIAL') else null end
    ) order by s.ot_date) from public.orl_ot_sessions s
    where extract(year from s.ot_date)=p_year and trim(s.special_title)<>''
  ),'[]'::jsonb);
end $$;
revoke all on function public.orl_get_special_ot_days(uuid,integer) from public;
grant execute on function public.orl_get_special_ot_days(uuid,integer) to anon,authenticated;
notify pgrst,'reload schema';
commit;
