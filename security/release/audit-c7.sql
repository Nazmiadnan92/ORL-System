begin read only;
select jsonb_build_object(
 'cutover_complete',(orl_private.c6_stats()->>'cutover_complete')::boolean,
 'plaintext_rows',(orl_private.c6_stats()->>'plaintext_rows')::integer,
 'identity_mismatch',(orl_private.c6_stats()->>'identity_mismatch')::integer,
 'private_tables_closed',not exists(
   select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
   cross join unnest(array['anon','authenticated','service_role']) r
   where n.nspname='orl_private' and c.relkind in ('r','p')
   and has_table_privilege(r,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')),
 'identity_rls',(select relrowsecurity and relforcerowsecurity from pg_class
   where oid='orl_private.request_identity'::regclass),
 'c2_closed',not exists(
   select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   cross join unnest(array['anon','authenticated','service_role']) r
   where n.nspname='public' and p.proname like 'orl_ic_c2_%'
   and has_function_privilege(r,p.oid,'EXECUTE')),
 'edge_rpc_closed_to_browser',not exists(
   select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   cross join unnest(array['anon','authenticated']) r
   where n.nspname='public' and p.proname ~ '^orl_ic_c[1-6]_'
   and has_function_privilege(r,p.oid,'EXECUTE')),
 'finalizer_closed',(select bool_and(not has_function_privilege(r,
   'public.orl_ic_c1_finalize_full_dump_recovery(uuid,text,boolean)','EXECUTE'))
   from unnest(array['anon','authenticated','service_role']) r),
 'private_functions_closed',not exists(
   select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   cross join unnest(array['anon','authenticated','service_role']) r
   where n.nspname='orl_private' and has_function_privilege(r,p.oid,'EXECUTE')),
 'masked_age_ready',public.orl_age_parts('010203-**-****','2030-03-04')
   is not distinct from public.orl_age_parts('010203-04-5678','2030-03-04'),
 'import_scoped',(select position('delete from orl_private.request_identity where request_id is not null;' in prosrc)>0
   and position('delete from orl_private.c3_reveal_lease where lease_id is not null;' in prosrc)>0
   from pg_proc where oid='public.orl_ic_c1_import(uuid,text,jsonb)'::regprocedure)
   and (select position('delete from orl_private.c3_reveal_lease where request_id=any(ids);' in prosrc)>0
   from pg_proc where oid='public.orl_ic_c1_remove(uuid,text,text,text,uuid,uuid[])'::regprocedure),
 'recovery_scoped',(select position('delete from public.orl_sessions where id is not null;' in prosrc)>0
   from pg_proc where oid='public.orl_ic_c1_finalize_full_dump_recovery(uuid,text,boolean)'::regprocedure)
);
rollback;
