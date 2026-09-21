-- Preserve legacy total; add role-scoped Main/Special counts.
begin;
create or replace function public.orl_get_year_month_counts(p_session_token uuid,p_year integer)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype; m integer;
begin
 v_user:=public.orl_require_session(p_session_token);
 if p_year is null or p_year not between 2026 and 2100 then raise exception 'Invalid year.'; end if;
 for m in 1..12 loop perform public.orl_prepare_schedule(p_session_token,p_year,m); end loop;
 return (with counts as (
 select mon.n,
 count(sl.id) filter(where sl.slot_type='MAIN')::integer main_available,
 count(sl.id) filter(where sl.slot_type='SPECIAL')::integer special_available
 from generate_series(1,12) mon(n)
 left join public.orl_ot_sessions s on extract(year from s.ot_date)=p_year and extract(month from s.ot_date)=mon.n and s.status='ACTIVE'
 and (s.holiday_override or not exists(select 1 from public.orl_holidays h where h.holiday_date=s.ot_date and h.is_active))
 left join public.orl_ot_slots sl on sl.session_id=s.id and sl.status='AVAILABLE' and sl.request_id is null
 and (v_user.role in('ADMIN','WEBMASTER') or sl.slot_type='MAIN')
 group by mon.n)
 select jsonb_agg(jsonb_build_object('month',n,'available',main_available+special_available,
 'main_available',main_available,'special_available',case when v_user.role in('ADMIN','WEBMASTER') then special_available else null end) order by n) from counts);
end $$;
revoke all on function public.orl_get_year_month_counts(uuid,integer) from public;
grant execute on function public.orl_get_year_month_counts(uuid,integer) to anon,authenticated;
notify pgrst,'reload schema';
commit;
