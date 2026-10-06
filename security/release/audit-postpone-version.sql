begin read only;
set local statement_timeout='30s';
select jsonb_build_object(
 'reviewed_definition',(select md5(replace(prosrc,chr(13),''))='f47cec01cc6028c6320a2b8bc8fb2115'
   from pg_proc where oid=to_regprocedure('orl_private.c1_mask_json(jsonb,date)')),
 'exact_record_versions',not exists(select 1 from public.orl_requests r
   where (orl_private.c1_mask_json(jsonb_build_object('request_id',r.id))->'_ic_edit_version')
     is distinct from to_jsonb(r.updated_at)),
 'recursive_versions',not exists(select 1 from public.orl_requests r
   where (orl_private.c1_mask_json(jsonb_build_array(jsonb_build_object('request_id',r.id)))
     #> '{0,_ic_edit_version}') is distinct from to_jsonb(r.updated_at)),
 'private_access_closed',not exists(select 1 from unnest(array['anon','authenticated','service_role']) role_name
   where has_function_privilege(role_name,'orl_private.c1_mask_json(jsonb,date)','EXECUTE')
      or has_function_privilege(role_name,'public.orl_require_session(uuid)','EXECUTE')),
 'recovery_ready',orl_private.c1_recovery_ready(),
 'cutover_preserved',coalesce((orl_private.c6_stats()->>'cutover_complete')::boolean
   and (orl_private.c6_stats()->>'plaintext_rows')::integer=0
   and (orl_private.c6_stats()->>'identity_mismatch')::integer=0,false)
);
rollback;
