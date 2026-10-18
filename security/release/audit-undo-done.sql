-- Read-only sanitized verification. No patient, credential or identity values.
begin read only;
set local statement_timeout='30s';
with reviewed(signature,body_md5) as (values
 ('public.orl_ic_undo_done(uuid,text,uuid,uuid,text,uuid,timestamptz)','d67883946a35daad215fa8b29eb6f762'),
 ('public.orl_require_webmaster_password(uuid,text)','db8fc906a57e43110f61b1a4c54bfeff'),
 ('orl_private.c1_redact_text(text)','aea30f10772d86163fb1aa4e2362fac3'),
 ('public.orl_swap_slots_checked(uuid,uuid,uuid,uuid,uuid)','b32dcd4c6ecda6bfd6e2adba0d2248e6'),
 ('public.orl_ic_c1_reassign(uuid,uuid,uuid,uuid,uuid,uuid)','2b4d1a321a41bed78ff559b3ec542d19'),
 ('public.orl_require_session(uuid)','ba9d29923e7269729c8025bf1e266208'),
 ('orl_private.c1_check_generation(uuid)','5c654a99ad55c29ba66b9b74371c8239')
)
select jsonb_build_object(
 'reviewed_definitions',not exists(select 1 from reviewed r left join pg_proc p on p.oid=to_regprocedure(r.signature)
  where p.oid is null or md5(replace(p.prosrc,chr(13),'')) is distinct from r.body_md5 or not p.prosecdef
   or not coalesce(p.proconfig @> array['search_path=""'] or p.proconfig @> array['search_path=public, extensions'],false)),
 'undo_done_service_only',coalesce(has_function_privilege('service_role','public.orl_ic_undo_done(uuid,text,uuid,uuid,text,uuid,timestamptz)','EXECUTE'),false)
  and not exists(select 1 from unnest(array['anon','authenticated']) r
   where has_function_privilege(r,'public.orl_ic_undo_done(uuid,text,uuid,uuid,text,uuid,timestamptz)','EXECUTE')),
 'service_only_gateway',coalesce(has_function_privilege('service_role','public.orl_ic_c1_reassign(uuid,uuid,uuid,uuid,uuid,uuid)','EXECUTE'),false)
  and not exists(select 1 from unnest(array['anon','authenticated']) r
   where has_function_privilege(r,'public.orl_ic_c1_reassign(uuid,uuid,uuid,uuid,uuid,uuid)','EXECUTE')),
 'private_core',not exists(select 1 from unnest(array['anon','authenticated','service_role']) r
  cross join unnest(array['public.orl_swap_slots_checked(uuid,uuid,uuid,uuid,uuid)',
   'public.orl_swap_slots(uuid,uuid,uuid)','public.orl_require_session(uuid)',
   'orl_private.c1_check_generation(uuid)']) f
  where to_regprocedure(f) is null or has_function_privilege(r,f,'EXECUTE')),
 'historical_correction_preserved',not exists(select 1 from (values
   ('public.orl_ic_past_case_view(uuid,uuid)','42e133e4521e0766919b6f8f7bcd53b2'),
   ('public.orl_ic_past_case_save(uuid,text,text,uuid,uuid,jsonb,text,text,jsonb,jsonb,uuid,text,timestamptz)','163c7e2855fe88f37f3360aec891158c'),
   ('orl_private.past_case_snapshot(uuid)','9cfae6e954dfb21532a46824a07b4878'),
   ('orl_private.past_case_record(uuid)','12ad709e1348ca80146fd1c84427001d'),
   ('public.orl_ic_c1_mutate(uuid,text,uuid,uuid,uuid,jsonb,text,text,text,jsonb,jsonb,uuid,timestamptz)','3b951b49b1638b8bb268e8fc972074a0')
  ) v(signature,expected_md5) left join pg_proc p on p.oid=to_regprocedure(v.signature)
  where p.oid is null or not p.prosecdef or md5(replace(p.prosrc,chr(13),'')) is distinct from v.expected_md5)
  and not exists(select 1 from unnest(array['public.orl_ic_past_case_view(uuid,uuid)',
   'public.orl_ic_past_case_save(uuid,text,text,uuid,uuid,jsonb,text,text,jsonb,jsonb,uuid,text,timestamptz)']) f
   where not has_function_privilege('service_role',f,'EXECUTE') or has_function_privilege('anon',f,'EXECUTE')
    or has_function_privilege('authenticated',f,'EXECUTE'))
  and not exists(select 1 from unnest(array['anon','authenticated','service_role']) r
   cross join unnest(array['orl_private.past_case_snapshot(uuid)','orl_private.past_case_record(uuid)']) f
   where has_function_privilege(r,f,'EXECUTE')),
 'ordinary_past_booking_guard',coalesce((select md5(replace(prosrc,chr(13),''))='b924d46e7bcac41332c9470521a72080'
  from pg_proc where oid=to_regprocedure('public.orl_assign_slot(uuid,uuid,uuid)')),false),
 'ordinary_move_preserved',coalesce((select md5(replace(prosrc,chr(13),''))='3589a9e866155d91641accafb59ce01d'
  from pg_proc where oid=to_regprocedure('public.orl_move_postponed_checked(uuid,uuid,uuid,jsonb,text,uuid)')),false),
 'lifecycle_preserved',coalesce((select md5(replace(prosrc,chr(13),''))='23f48d226ea2fa298821f8cfe06c5ffa'
  from pg_proc where oid=to_regprocedure('public.orl_ic_ot_lifecycle(uuid,uuid,uuid,text,text,uuid,timestamptz)')),false)
  and (select count(*)=2 from pg_constraint where conrelid='public.orl_requests'::regclass and convalidated
   and conname in('orl_requests_ot_hold_state','orl_requests_completion_state')),
 'restore_preserved',coalesce((select md5(replace(prosrc,chr(13),''))='097da3e68879e5e783e7cd2d6fbc2e8c'
  from pg_proc where oid=to_regprocedure('public.orl_db_import_locked(uuid,text,jsonb)')),false),
 'browser_tables_closed',not exists(select 1 from unnest(array['anon','authenticated']) r
  where has_table_privilege(r,'public.orl_requests','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   or has_table_privilege(r,'public.orl_ot_slots','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')),
 'identity_tables_closed',not exists(select 1 from unnest(array['anon','authenticated','service_role']) r
  where has_table_privilege(r,'orl_private.request_identity','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   or has_table_privilege(r,'orl_private.c1_write_permit','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   or has_table_privilege(r,'orl_private.c1_creation_receipts','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')),
 'recovery_ready',orl_private.c1_recovery_ready() is true,
 'masked_read_preserved',coalesce((select md5(replace(prosrc,chr(13),''))='176cc950c7c8a75b13e85bb1addbae03'
  from pg_proc where oid=to_regprocedure('public.orl_get_schedule(uuid,integer,integer)')),false)
  and coalesce((select md5(replace(prosrc,chr(13),''))='c0f13f6252204154dd0e860a1b1ba476'
  from pg_proc where oid=to_regprocedure('orl_private.c1_mask_json(jsonb,date)')),false),
 'ic_storage_preserved',coalesce((orl_private.c6_stats()->>'cutover_complete')::boolean
  and (orl_private.c6_stats()->>'plaintext_rows')::integer=0 and (orl_private.c6_stats()->>'identity_mismatch')::integer=0,false)
);
rollback;
