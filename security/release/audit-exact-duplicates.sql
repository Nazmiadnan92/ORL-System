-- Read-only booleans only: no patient, full IC, key ID, search hash or credentials.
begin read only;
set local statement_timeout='30s';
with reviewed(signature,body_md5) as (values
 ('orl_private.c1_read_orl_db_duplicates(uuid)','53e0a9fd59a00d257ad5fe02e442a400'),
 ('public.orl_db_duplicates(uuid)','60420accafe98c044b39a803a74b1e42'),
 ('public.orl_require_session(uuid)','ba9d29923e7269729c8025bf1e266208'),
 ('orl_private.c1_mask_json(jsonb,date)','c0f13f6252204154dd0e860a1b1ba476')
)
select jsonb_build_object(
 'reviewed_definitions',not exists(select 1 from reviewed r left join pg_proc p on p.oid=to_regprocedure(r.signature)
  where p.oid is null or md5(replace(p.prosrc,chr(13),'')) is distinct from r.body_md5 or not p.prosecdef),
 'stable_private_core',coalesce((select provolatile='s' and proconfig @> array['search_path=""']
  from pg_proc where oid=to_regprocedure('orl_private.c1_read_orl_db_duplicates(uuid)')),false)
  and not exists(select 1 from unnest(array['anon','authenticated','service_role']) client
   where has_function_privilege(client,'orl_private.c1_read_orl_db_duplicates(uuid)','EXECUTE')),
 'masked_public_wrapper',not exists(select 1 from unnest(array['anon','authenticated']) client
  where not has_function_privilege(client,'public.orl_db_duplicates(uuid)','EXECUTE')),
 'identity_tables_closed',not exists(select 1 from unnest(array['anon','authenticated','service_role']) client
  where has_table_privilege(client,'orl_private.request_identity','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')),
 'browser_tables_closed',not exists(select 1 from unnest(array['anon','authenticated']) client
  where has_table_privilege(client,'public.orl_requests','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')),
 'recovery_ready',orl_private.c1_recovery_ready() is true,
 'ic_storage_preserved',coalesce((orl_private.c6_stats()->>'cutover_complete')::boolean
  and (orl_private.c6_stats()->>'plaintext_rows')::integer=0 and (orl_private.c6_stats()->>'identity_mismatch')::integer=0,false),
 'single_search_domain',(select count(*) from (
  select distinct i.search_key_id,i.normalization_version from orl_private.request_identity i
  join public.orl_requests r on r.id=i.request_id) domains)<=1,
 'identity_coverage',not exists(select 1 from public.orl_requests r
  left join orl_private.request_identity i on i.request_id=r.id
  where (trim(coalesce(r.patient_ic,''))<>'' and i.request_id is null)
   or (i.request_id is not null and (trim(coalesce(r.patient_ic,''))=''
    or i.normalization_version<>1 or octet_length(i.search_hash)<>32)))
);
rollback;
