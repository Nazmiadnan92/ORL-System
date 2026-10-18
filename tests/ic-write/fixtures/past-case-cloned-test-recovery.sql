-- Only a named disposable local clone may use this fixture initialization.
\set ON_ERROR_STOP on
begin;
do $$begin
 if session_user<>'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet
  or current_database() !~ '^orl_past_test_[a-z0-9_]+$' then
  raise exception 'Disposable local historical-test clone only';
 end if;
end $$;
select public.orl_ic_c1_finalize_full_dump_recovery(
 (select generation from orl_private.c1_restore_generation where singleton),
 'ROTATE C1 GENERATION AND INVALIDATE SESSIONS',true);
commit;
