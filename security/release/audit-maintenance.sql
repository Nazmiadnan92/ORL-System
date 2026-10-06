begin read only;
select jsonb_build_object(
 'installed_off',(select count(*)=1 and bool_and(not enabled and revision=0) from orl_private.site_maintenance),
 'reviewed_gate',(select md5(replace(prosrc,chr(13),''))='ba9d29923e7269729c8025bf1e266208' from pg_proc where oid='public.orl_require_session(uuid)'::regprocedure),
 'private_access_closed',not exists(select 1 from unnest(array['anon','authenticated','service_role']) r
  where has_function_privilege(r,'public.orl_require_session(uuid)','EXECUTE')
     or has_function_privilege(r,'orl_private.c1_require_session_core(uuid)','EXECUTE')
     or has_table_privilege(r,'orl_private.site_maintenance','SELECT,INSERT,UPDATE,DELETE')),
 'notice_and_control_grants',(select bool_and(has_function_privilege(r,'public.orl_maintenance_status()','EXECUTE')
  and has_function_privilege(r,'public.orl_set_maintenance(uuid,text,boolean,text,timestamptz,bigint)','EXECUTE')) from unnest(array['anon','authenticated']) r)
  and not has_function_privilege('service_role','public.orl_set_maintenance(uuid,text,boolean,text,timestamptz,bigint)','EXECUTE'),
 'recovery_ready',orl_private.c1_recovery_ready(),
 'cutover_preserved',coalesce((orl_private.c6_stats()->>'cutover_complete')::boolean
  and (orl_private.c6_stats()->>'plaintext_rows')::integer=0 and (orl_private.c6_stats()->>'identity_mismatch')::integer=0,false)
);
rollback;
