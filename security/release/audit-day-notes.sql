-- Read-only sanitized verification: only booleans, no note, patient, identity or credential values.
begin read only;
set local statement_timeout='30s';
with reviewed(signature,body_md5) as (values
 ('public.orl_get_ot_day_notes(uuid,integer)','e4f3982a7fbda9903e27fe22dd7e6163'),
 ('public.orl_set_ot_day_note(uuid,uuid,text,bigint,uuid)','dd57034fa3bb40f146715e65143edb07'),
 ('public.orl_require_session(uuid)','ba9d29923e7269729c8025bf1e266208'),
 ('orl_private.c1_check_generation(uuid)','5c654a99ad55c29ba66b9b74371c8239'),
 ('orl_private.c1_redact_text(text)','aea30f10772d86163fb1aa4e2362fac3')
)
select jsonb_build_object(
 'reviewed_definitions',not exists(select 1 from reviewed r left join pg_proc p on p.oid=to_regprocedure(r.signature)
  where p.oid is null or md5(replace(p.prosrc,chr(13),'')) is distinct from r.body_md5 or not p.prosecdef
   or not coalesce(p.proconfig @> array['search_path=""'],false))
  and (select count(*)=2 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname in('orl_get_ot_day_notes','orl_set_ot_day_note')),
 'day_note_columns',not exists(select 1 from (values
   ('day_note','text'::regtype,$default$''::text$default$),('day_note_revision','bigint'::regtype,'0')
  ) expected(name,type_oid,default_expr)
  left join pg_attribute a on a.attrelid='public.orl_ot_sessions'::regclass and a.attname=expected.name and not a.attisdropped
  left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
  where a.attname is null or a.atttypid<>expected.type_oid or not a.attnotnull or a.attgenerated<>'' or a.attidentity<>''
   or pg_get_expr(d.adbin,d.adrelid) is distinct from expected.default_expr),
 'day_note_constraints',not exists(select 1 from (values
   ('orl_ot_sessions_day_note_length','CHECKlengthday_note<=500'),
   ('orl_ot_sessions_day_note_revision','CHECKday_note_revision>=0ANDday_note_revision<=9007199254740991')
  ) expected(name,expression)
  left join pg_constraint c on c.conrelid='public.orl_ot_sessions'::regclass and c.conname=expected.name
  where c.oid is null or c.contype<>'c' or not c.convalidated
   or replace(replace(regexp_replace(pg_get_constraintdef(c.oid),'[[:space:]()]','','g'),'''',''),'::bigint','') is distinct from expected.expression),
 'day_note_rpc_grants',not exists(select 1 from unnest(array['anon','authenticated']) client
  cross join unnest(array['public.orl_get_ot_day_notes(uuid,integer)','public.orl_set_ot_day_note(uuid,uuid,text,bigint,uuid)']) f
  where not has_function_privilege(client,f,'EXECUTE'))
  and not exists(select 1 from unnest(array['public.orl_get_ot_day_notes(uuid,integer)',
   'public.orl_set_ot_day_note(uuid,uuid,text,bigint,uuid)']) f where has_function_privilege('service_role',f,'EXECUTE')),
 'private_guards_closed',not exists(select 1 from unnest(array['anon','authenticated','service_role']) client
  cross join unnest(array['public.orl_require_session(uuid)','orl_private.c1_check_generation(uuid)',
   'orl_private.c1_redact_text(text)','public.orl_db_import_locked(uuid,text,jsonb)','public.orl_db_export(uuid,text)']) f
  where has_function_privilege(client,f,'EXECUTE')),
 'browser_tables_closed',not exists(select 1 from unnest(array['anon','authenticated']) client
  cross join unnest(array['public.orl_ot_sessions','public.orl_ot_slots','public.orl_requests','public.orl_audit_log']) t
  where has_table_privilege(client,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
  and coalesce((select relrowsecurity from pg_class where oid='public.orl_ot_sessions'::regclass),false),
 'identity_tables_closed',not exists(select 1 from unnest(array['anon','authenticated','service_role']) client
  where has_table_privilege(client,'orl_private.request_identity','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')),
 'restore_preserved',not exists(select 1 from (values
   ('public.orl_db_import_locked(uuid,text,jsonb)','6523523d8a3ab3d67daa82a07d73fa4f'),
   ('public.orl_db_export(uuid,text)','685f55c7c5c33548eb79933d3beeb16d')
  ) expected(signature,body_md5)
  left join pg_proc p on p.oid=to_regprocedure(expected.signature)
  where p.oid is null or not p.prosecdef or md5(replace(p.prosrc,chr(13),'')) is distinct from expected.body_md5
   or not coalesce(p.proconfig @> array['search_path=public, extensions'],false)),
 'recovery_ready',orl_private.c1_recovery_ready() is true,
 'ic_storage_preserved',coalesce((orl_private.c6_stats()->>'cutover_complete')::boolean
  and (orl_private.c6_stats()->>'plaintext_rows')::integer=0 and (orl_private.c6_stats()->>'identity_mismatch')::integer=0,false)
);
rollback;
