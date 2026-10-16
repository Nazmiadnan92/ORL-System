-- Read-only, sanitized deployment evidence. Returns booleans, never patient values.
begin read only;
set local statement_timeout='30s';
with reviewed(signature,body_md5,security_definer) as (values
 ('public.orl_ic_ot_lifecycle(uuid,uuid,uuid,text,text,uuid,timestamptz)','23f48d226ea2fa298821f8cfe06c5ffa',true),
 ('public.orl_get_ot_hold_requests(uuid)','4a0fff644bba7701d0b84f0be0021748',true),
 ('orl_private.c1_mask_json(jsonb,date)','c0f13f6252204154dd0e860a1b1ba476',true),
 ('orl_private.ot_export_snapshot(uuid)','c4d1e0156ccd8b1c936daf46c2000bde',false),
 ('public.orl_compact_main(uuid,uuid)','f84e2d4231517f8df19f3be033433b44',true),
 ('public.orl_edit_scheduled_request_checked(uuid,uuid,jsonb,text,uuid)','83567629ce4b31f8c9bd361f5384b6ff',true),
 ('public.orl_move_postponed_checked(uuid,uuid,uuid,jsonb,text,uuid)','3589a9e866155d91641accafb59ce01d',true),
 ('public.orl_clear_slot_checked(uuid,uuid,uuid)','de1a33e33a8da63d3718f62d31158e02',true),
 ('public.orl_swap_slots_checked(uuid,uuid,uuid,uuid,uuid)','f3d2b7af8df7434acaf2d53985a5e589',true),
 ('public.orl_review_request(uuid,uuid,text,text)','eb02cd973d9cd40b054d6b00795a1508',true),
 ('public.orl_ic_c1_deletion(uuid,text,uuid,uuid,timestamptz,uuid,text)','62df9445629de00b97959fa0c2f17cad',true),
 ('public.orl_booking_move_view(uuid,uuid)','0e9cf7e4a1a5efb42ce1b6d3df13a6eb',true),
 ('public.orl_booking_move_request(uuid,uuid,date,text,uuid,timestamptz,uuid)','1b4697c9e242cc5911696fc60c87ffa0',true),
 ('public.orl_booking_move_review(uuid,uuid,text,uuid,timestamptz,timestamptz,uuid)','2473bcdf691eb5b613431772bb90c1e3',true),
 ('public.orl_db_import_locked(uuid,text,jsonb)','097da3e68879e5e783e7cd2d6fbc2e8c',true),
 ('public.orl_require_session(uuid)','ba9d29923e7269729c8025bf1e266208',true),
 ('public.orl_ic_c1_mutate(uuid,text,uuid,uuid,uuid,jsonb,text,text,text,jsonb,jsonb,uuid,timestamptz)','9369627b09c1739c304e1c7256b3eaa7',true),
 ('public.orl_assign_slot(uuid,uuid,uuid)','b924d46e7bcac41332c9470521a72080',true),
 ('orl_private.c1_read_schedule(uuid,integer,integer)','0f922b237c5c2a89976c3b4c22345ae7',true)
)
select jsonb_build_object(
 'reviewed_definitions',not exists(select 1 from reviewed r left join pg_proc p on p.oid=to_regprocedure(r.signature)
   where p.oid is null or md5(replace(p.prosrc,chr(13),'')) is distinct from r.body_md5 or p.prosecdef is distinct from r.security_definer
    or not coalesce(p.proconfig @> array['search_path=""'] or p.proconfig @> array['search_path=public, extensions'],false)),
 'lifecycle_columns',(select count(*)=6 from information_schema.columns where table_schema='public' and table_name='orl_requests'
   and ((column_name='ot_hold' and data_type='boolean' and is_nullable='NO' and column_default='false')
    or (column_name='ot_hold_reason' and data_type='text' and is_nullable='NO' and column_default='''''::text')
    or (column_name in('ot_hold_at','completed_at') and data_type='timestamp with time zone' and is_nullable='YES')
    or (column_name in('ot_hold_by','completed_by') and data_type='uuid' and is_nullable='YES'))),
 'lifecycle_constraints',(select count(*)=2 from pg_constraint where conrelid='public.orl_requests'::regclass and contype='c' and convalidated
   and ((conname='orl_requests_ot_hold_state' and md5(pg_get_constraintdef(oid))='1e349f27bce99cca05bb78ca7bd086f8')
    or (conname='orl_requests_completion_state' and md5(pg_get_constraintdef(oid))='02db201046491079252d08cd5966fcef')))
   and (select count(*)=2 from pg_constraint where conrelid='public.orl_requests'::regclass and contype='f' and confrelid='public.orl_users'::regclass
     and convalidated and confdeltype='n' and conname in('orl_requests_ot_hold_by_fkey','orl_requests_completed_by_fkey')),
 'lifecycle_index',coalesce((select i.indisvalid and i.indisready and pg_get_expr(i.indpred,i.indrelid)='ot_hold'
   from pg_index i where i.indexrelid=to_regclass('public.orl_requests_ot_hold_queue')),false),
 'protected_action_acl',has_function_privilege('service_role','public.orl_ic_ot_lifecycle(uuid,uuid,uuid,text,text,uuid,timestamptz)','EXECUTE')
   and not exists(select 1 from unnest(array['anon','authenticated']) r
    where has_function_privilege(r,'public.orl_ic_ot_lifecycle(uuid,uuid,uuid,text,text,uuid,timestamptz)','EXECUTE')),
 'held_read_acl',not exists(select 1 from unnest(array['anon','authenticated']) r where not has_function_privilege(r,'public.orl_get_ot_hold_requests(uuid)','EXECUTE'))
   and not has_function_privilege('service_role','public.orl_get_ot_hold_requests(uuid)','EXECUTE'),
 'private_helpers',not exists(select 1 from unnest(array['anon','authenticated','service_role']) r
   cross join unnest(array['public.orl_require_session(uuid)','orl_private.c1_read_schedule(uuid,integer,integer)','orl_private.c1_mask_json(jsonb,date)',
    'orl_private.ot_export_snapshot(uuid)','public.orl_edit_scheduled_request_checked(uuid,uuid,jsonb,text,uuid)',
    'public.orl_move_postponed_checked(uuid,uuid,uuid,jsonb,text,uuid)','public.orl_clear_slot_checked(uuid,uuid,uuid)',
    'public.orl_swap_slots_checked(uuid,uuid,uuid,uuid,uuid)','public.orl_review_request(uuid,uuid,text,text)',
    'public.orl_db_import_locked(uuid,text,jsonb)']) f where has_function_privilege(r,f,'EXECUTE'))
   and not exists(select 1 from unnest(array['anon','authenticated']) r where has_function_privilege(r,'public.orl_compact_main(uuid,uuid)','EXECUTE')),
 'browser_tables_closed',not exists(select 1 from unnest(array['anon','authenticated']) r
   where has_table_privilege(r,'public.orl_requests','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    or has_table_privilege(r,'public.orl_ot_slots','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')),
 'recovery_ready',orl_private.c1_recovery_ready() is true,
 'masked_wrapper_preserved',coalesce((select md5(replace(prosrc,chr(13),''))='176cc950c7c8a75b13e85bb1addbae03' and prosecdef
   and proconfig @> array['search_path=""'] from pg_proc where oid=to_regprocedure('public.orl_get_schedule(uuid,integer,integer)')),false),
 'export_lease_protected',coalesce((select relrowsecurity and relforcerowsecurity from pg_class where oid=to_regclass('orl_private.ot_export_lease')),false)
   and not exists(select 1 from unnest(array['anon','authenticated','service_role']) r
    where has_table_privilege(r,'orl_private.ot_export_lease','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
   and (select count(*)=2 and bool_and(prosecdef and has_function_privilege('service_role',p.oid,'EXECUTE')
    and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE'))
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in('orl_ic_ot_export_view','orl_ic_ot_export_commit')),
 'ic_storage_preserved',coalesce((orl_private.c6_stats()->>'cutover_complete')::boolean and (orl_private.c6_stats()->>'plaintext_rows')::integer=0
   and (orl_private.c6_stats()->>'identity_mismatch')::integer=0,false)
);
rollback;
