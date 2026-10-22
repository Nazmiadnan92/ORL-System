-- Catalog metadata only. No patient, identity, note, token or credential values are read.
-- Do not invoke application functions in this release verification.
begin read only;
set local statement_timeout='30s';
with assignment_functions(signature,body_md5) as (values
 ('public.orl_booking_assign_view(uuid,uuid)','22512869668d90879f91082d9899ace9'),
 ('public.orl_booking_assign_existing(uuid,uuid,uuid,timestamptz,uuid)','db0893a9df012b4bd359b30b6bce1526')
), core_dependencies(signature,body_md5,config) as (values
 ('public.orl_require_session(uuid)','ba9d29923e7269729c8025bf1e266208','search_path=""'),
 ('orl_private.c1_check_generation(uuid)','5c654a99ad55c29ba66b9b74371c8239','search_path=""'),
 ('orl_private.c1_redact_text(text)','aea30f10772d86163fb1aa4e2362fac3','search_path=""'),
 ('public.orl_review_request(uuid,uuid,text,text)','eb02cd973d9cd40b054d6b00795a1508','search_path=public, extensions'),
 ('public.orl_assign_slot(uuid,uuid,uuid)','b924d46e7bcac41332c9470521a72080','search_path=public, extensions'),
 ('orl_private.booking_same_date_guard()','30be1c5fe983f12238591fd2f3661b44','search_path=""')
)
select jsonb_build_object(
 'reviewed_assignment_definitions',not exists(select 1 from assignment_functions f left join pg_proc p on p.oid=to_regprocedure(f.signature)
  where p.oid is null or md5(replace(p.prosrc,chr(13),'')) is distinct from f.body_md5 or not p.prosecdef
   or p.proconfig is distinct from array['search_path=""']
   or p.proowner is distinct from (select proowner from pg_proc where oid=to_regprocedure('public.orl_require_session(uuid)')))
  and (select count(*)=2 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname in('orl_booking_assign_view','orl_booking_assign_existing')),
 'reviewed_core_dependencies',not exists(select 1 from core_dependencies f left join pg_proc p on p.oid=to_regprocedure(f.signature)
  where p.oid is null or md5(replace(p.prosrc,chr(13),'')) is distinct from f.body_md5 or not p.prosecdef
   or p.proconfig is distinct from array[f.config]
   or p.proowner is distinct from (select proowner from pg_proc where oid=to_regprocedure('public.orl_require_session(uuid)'))),
 'assignment_rpc_grants',not exists(select 1 from assignment_functions f cross join unnest(array['anon','authenticated']) client
  where not coalesce(has_function_privilege(client,to_regprocedure(f.signature),'EXECUTE'),false))
  and not exists(select 1 from assignment_functions f where coalesce(has_function_privilege('service_role',to_regprocedure(f.signature),'EXECUTE'),false))
  and not exists(select 1 from assignment_functions f join pg_proc p on p.oid=to_regprocedure(f.signature)
   cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
   where (acl.grantee=0 or (acl.grantee<>p.proowner and acl.is_grantable)) and acl.privilege_type='EXECUTE'),
 'private_functions_closed',not exists(select 1 from core_dependencies f cross join unnest(array['anon','authenticated','service_role']) client
  where coalesce(has_function_privilege(client,to_regprocedure(f.signature),'EXECUTE'),true))
  and not exists(select 1 from core_dependencies f join pg_proc p on p.oid=to_regprocedure(f.signature)
   cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
   where (acl.grantee=0 or (acl.grantee<>p.proowner and acl.is_grantable)) and acl.privilege_type='EXECUTE'),
 'browser_tables_closed',not exists(select 1 from unnest(array['anon','authenticated']) client
  cross join unnest(array['public.orl_requests','public.orl_ot_slots','public.orl_ot_sessions','public.orl_audit_log','public.orl_settings','public.orl_holidays']) t
  where coalesce(has_table_privilege(client,to_regclass(t),'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),true)),
 'private_tables_closed',not exists(select 1 from unnest(array['anon','authenticated','service_role']) client
  where coalesce(has_table_privilege(client,to_regclass('orl_private.request_identity'),'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),true)),
 'protected_rls',not exists(select 1 from (values
   ('public.orl_requests',false),('public.orl_ot_slots',false),('public.orl_ot_sessions',false),
   ('orl_private.request_identity',true)
  ) expected(table_name,force_rls) left join pg_class c on c.oid=to_regclass(expected.table_name)
  where c.oid is null or not c.relrowsecurity or (expected.force_rls and not c.relforcerowsecurity)),
 'same_date_guard_enabled',exists(select 1 from pg_trigger where tgrelid='public.orl_ot_slots'::regclass
  and tgname='orl_booking_same_date_guard' and not tgisinternal and tgenabled in('O','A') and tgtype=23
  and tgfoid=to_regprocedure('orl_private.booking_same_date_guard()'))
);
rollback;
