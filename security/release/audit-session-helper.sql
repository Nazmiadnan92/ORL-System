begin read only;
select jsonb_build_object(
 'expected_helper',exists(select 1 from pg_proc where oid=to_regprocedure('public.orl_require_session(uuid)')
    and prosecdef and prorettype='public.orl_users'::regtype),
 'single_signature',(select count(*)=1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='orl_require_session'),
 'direct_access_closed',not exists(select 1 from unnest(array['anon','authenticated','service_role']) r
    where has_function_privilege(r,'public.orl_require_session(uuid)','EXECUTE')),
 'trusted_callers_preserved',not exists(select 1 from pg_proc p
    where p.prosecdef and position('public.orl_require_session(' in p.prosrc)>0
      and not has_function_privilege(p.proowner,'public.orl_require_session(uuid)'::regprocedure,'EXECUTE')),
 'login_api_preserved',(select bool_and(has_function_privilege(r,'public.orl_login(text,text)','EXECUTE')
    and has_function_privilege(r,'public.orl_current_user(uuid)','EXECUTE')
    and has_function_privilege(r,'public.orl_logout(uuid)','EXECUTE')) from unnest(array['anon','authenticated']) r),
 'other_account_helper_closed',not exists(select 1 from unnest(array['anon','authenticated']) r
    where has_function_privilege(r,'public.orl_require_webmaster_password(uuid,text)','EXECUTE'))
);
rollback;
