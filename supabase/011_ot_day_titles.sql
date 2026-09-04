-- ORL OT Management System: yearly directory of titled OT days
begin;

create or replace function public.orl_get_special_ot_days(p_session_token uuid,p_year integer)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype;
begin
  v_user:=public.orl_require_session(p_session_token);
  if p_year not between 2026 and 2100 then raise exception 'Invalid year.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('session_id',s.id,'date',s.ot_date,'day_name',s.day_name,'title',s.special_title) order by s.ot_date)
    from public.orl_ot_sessions s where extract(year from s.ot_date)=p_year and trim(s.special_title)<>''),'[]'::jsonb);
end $$;

grant execute on function public.orl_get_special_ot_days(uuid,integer) to anon,authenticated;
commit;
