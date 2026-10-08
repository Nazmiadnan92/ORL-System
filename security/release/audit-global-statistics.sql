-- Sanitized read-only checks. No patient values are returned.
begin read only;
select jsonb_build_object(
 'reviewed_statistics',coalesce((select md5(replace(prosrc,chr(13),''))='904a7c884989c5fadc8411a7c1c9c2d7' and prosecdef
  and proconfig @> array['search_path=public, extensions'] from pg_proc
  where oid=to_regprocedure('orl_private.c1_read_orl_subspecialty_statistics(uuid,date,date,text,text,text,text,integer)')),false),
 'mask_wrapper_preserved',coalesce((select prosrc='select orl_private.c1_mask_json(orl_private.c1_read_orl_subspecialty_statistics(p_session_token,p_from,p_to,p_sub,p_specialist,p_status,p_assignment,p_offset),null)'
  and prosecdef and proconfig @> array['search_path=""'] from pg_proc
  where oid=to_regprocedure('public.orl_subspecialty_statistics(uuid,date,date,text,text,text,text,integer)')),false),
 'session_gate_preserved',coalesce((select md5(replace(prosrc,chr(13),''))='ba9d29923e7269729c8025bf1e266208'
  from pg_proc where oid=to_regprocedure('public.orl_require_session(uuid)')),false),
 'private_access_closed',not exists(select 1 from unnest(array['anon','authenticated','service_role']) r
  where has_function_privilege(r,'orl_private.c1_read_orl_subspecialty_statistics(uuid,date,date,text,text,text,text,integer)','EXECUTE')
  or has_function_privilege(r,'public.orl_require_session(uuid)','EXECUTE')),
 'public_statistics_available',has_function_privilege('anon','public.orl_subspecialty_statistics(uuid,date,date,text,text,text,text,integer)','EXECUTE')
  and has_function_privilege('authenticated','public.orl_subspecialty_statistics(uuid,date,date,text,text,text,text,integer)','EXECUTE'),
 'recovery_ready',orl_private.c1_recovery_ready(),
 'ic_storage_preserved',coalesce((orl_private.c6_stats()->>'cutover_complete')::boolean
  and (orl_private.c6_stats()->>'plaintext_rows')::integer=0 and (orl_private.c6_stats()->>'identity_mismatch')::integer=0,false)
);
rollback;
