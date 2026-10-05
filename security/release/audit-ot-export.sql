begin read only;
select jsonb_build_object(
 'cutover_complete',(orl_private.c6_stats()->>'cutover_complete')::boolean,
 'plaintext_rows',(orl_private.c6_stats()->>'plaintext_rows')::integer,
 'identity_mismatch',(orl_private.c6_stats()->>'identity_mismatch')::integer,
 'recovery_ready',orl_private.c1_recovery_ready(),
 'lease_rls',(select relrowsecurity and relforcerowsecurity from pg_class where oid='orl_private.ot_export_lease'::regclass),
 'lease_closed',not exists(select 1 from unnest(array['anon','authenticated','service_role']) r
   where has_table_privilege(r,'orl_private.ot_export_lease','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')),
 'snapshot_closed',not exists(select 1 from unnest(array['anon','authenticated','service_role']) r
   where has_function_privilege(r,'orl_private.ot_export_snapshot(uuid)','EXECUTE')),
 'export_rpc_count',(select count(*)=2 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname in('orl_ic_ot_export_view','orl_ic_ot_export_commit')),
 'export_rpc_acl',(select bool_and(p.prosecdef
     and not has_function_privilege('anon',p.oid,'EXECUTE')
     and not has_function_privilege('authenticated',p.oid,'EXECUTE')
     and has_function_privilege('service_role',p.oid,'EXECUTE'))
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname in('orl_ic_ot_export_view','orl_ic_ot_export_commit'))
);
rollback;
