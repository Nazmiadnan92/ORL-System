-- Close direct API access to the internal session helper.
-- ACL-only, repeat-safe: no account, session, patient or encryption values change.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $$
begin
  if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='orl_require_session') <> 1
     or not exists(select 1 from pg_proc
       where oid=to_regprocedure('public.orl_require_session(uuid)')
         and prorettype='public.orl_users'::regtype and prosecdef
         and exists(select 1 from unnest(proconfig) c where c like 'search_path=%')) then
    raise exception 'STOP: unexpected session helper definition or overload. Review before installation.';
  end if;
end $$;

-- Revoking PUBLIC alone does not remove explicit or inherited client grants.
-- SECURITY DEFINER callers continue to use their trusted function-owner rights.
revoke all on function public.orl_require_session(uuid) from public,anon,authenticated,service_role;

do $$
begin
  if exists(select 1 from unnest(array['anon','authenticated','service_role']) r
      where has_function_privilege(r,'public.orl_require_session(uuid)','EXECUTE')) then
    raise exception 'STOP: inherited session helper access remains. No ACL changes committed.';
  end if;
  if exists(select 1 from pg_proc p
      where p.prosecdef and position('public.orl_require_session(' in p.prosrc)>0
        and not has_function_privilege(p.proowner,'public.orl_require_session(uuid)'::regprocedure,'EXECUTE')) then
    raise exception 'STOP: a trusted caller would lose session access. No ACL changes committed.';
  end if;
end $$;
notify pgrst,'reload schema';
commit;
