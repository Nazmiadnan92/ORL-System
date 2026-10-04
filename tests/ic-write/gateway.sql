-- Local candidate authorization helpers. Return no user row/password hash.
begin;
do $$ begin
 if session_user<>'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet
   or to_regprocedure('public.orl_ic_c1_export(uuid,text)') is null then raise exception 'Local C1 runner required.'; end if;
end $$;
create function public.orl_ic_c1_authorize(p_session_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype;
begin
 u:=public.orl_require_session(p_session_token);
 return jsonb_build_object('role',u.role);
end $$;
create function public.orl_ic_c1_check_password(p_session_token uuid,p_password text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 perform public.orl_require_webmaster_password(p_session_token,p_password);
 return true;
end $$;
revoke all on function public.orl_ic_c1_authorize(uuid),public.orl_ic_c1_check_password(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_c1_authorize(uuid),public.orl_ic_c1_check_password(uuid,text) to service_role;
commit;
