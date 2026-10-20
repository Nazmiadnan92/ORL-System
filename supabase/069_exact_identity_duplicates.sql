-- Read-only Webmaster duplicate detection using the full normalized identity HMAC.
-- No decrypt, clinical write, deletion, new endpoint, or permission expansion.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $baseline$
declare item record;
begin
 if orl_private.c1_recovery_ready() is distinct from true
  or (orl_private.c6_stats()->>'cutover_complete')::boolean is distinct from true then
  raise exception '069: protected recovery and completed cutover required.';
 end if;
 for item in select * from (values
  ('orl_private.c1_read_orl_db_duplicates(uuid)','7c022fabe4bef2ec57c4106a5d9dcaf2'),
  ('public.orl_db_duplicates(uuid)','60420accafe98c044b39a803a74b1e42'),
  ('public.orl_require_session(uuid)','ba9d29923e7269729c8025bf1e266208'),
  ('orl_private.c1_mask_json(jsonb,date)','c0f13f6252204154dd0e860a1b1ba476')
 ) v(signature,expected_md5) loop
  if not coalesce((select prosecdef and md5(replace(prosrc,chr(13),''))=item.expected_md5
   from pg_proc where oid=to_regprocedure(item.signature)),false) then
   raise exception '069: reviewed duplicate detector baseline differs: %',item.signature;
  end if;
 end loop;
 if exists(select 1 from unnest(array['anon','authenticated','service_role']) client
  where has_function_privilege(client,'orl_private.c1_read_orl_db_duplicates(uuid)','EXECUTE')
   or has_table_privilege(client,'orl_private.request_identity','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
  or exists(select 1 from unnest(array['anon','authenticated']) client
   where not has_function_privilege(client,'public.orl_db_duplicates(uuid)','EXECUTE')) then
  raise exception '069: duplicate detector access boundary differs.';
 end if;
end $baseline$;

-- STABLE gives the coverage checks and both groups the same read snapshot.
-- Keep the public masking wrapper and its existing session/role boundary.
create or replace function orl_private.c1_read_orl_db_duplicates(p_session_token uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare u public.orl_users%rowtype;
begin
 u:=public.orl_require_session(p_session_token);
 if u.role is distinct from 'WEBMASTER' then
  raise exception 'Webmaster access required.' using errcode='42501';
 end if;
 -- Never fall back to a display mask or report a complete negative scan when
 -- some identities cannot be compared. Key rotation requires reconciliation.
 if exists(
  select 1 from public.orl_requests r
  left join orl_private.request_identity i on i.request_id=r.id
  where (trim(coalesce(r.patient_ic,''))<>'' and i.request_id is null)
   or (i.request_id is not null and (trim(coalesce(r.patient_ic,''))=''
    or i.normalization_version<>1 or octet_length(i.search_hash)<>32))
 ) or (select count(*) from (
  select distinct i.search_key_id,i.normalization_version
  from orl_private.request_identity i join public.orl_requests r on r.id=i.request_id
 ) domains)>1 then
  raise exception 'Unable to verify full IC matches safely. Protected identity data needs review.';
 end if;
 return coalesce((
  with records as (
   select r.id,trim(r.mrn) mrn,orl_private.c1_mask_ic(r.patient_ic) display_ic,r.created_at,
    jsonb_build_object('id',r.id,'request_number',r.request_number,'patient_name',r.patient_name,
     'patient_ic',orl_private.c1_mask_ic(r.patient_ic),'mrn',r.mrn,'surgery',r.surgery,
     'diagnosis',r.diagnosis,'status',r.status,'created_at',r.created_at) payload
   from public.orl_requests r
  ), groups as (
   select 'MRN'::text match_type,r.mrn match_value,count(*) record_count,
    jsonb_agg(r.payload order by r.created_at,r.id) records
   from records r where r.mrn<>'' group by r.mrn having count(*)>1
   union all
   select 'PATIENT IC'::text,min(r.display_ic),count(*),
    jsonb_agg(r.payload order by r.created_at,r.id)
   from records r join orl_private.request_identity i on i.request_id=r.id
   group by i.search_key_id,i.normalization_version,i.search_hash having count(*)>1
  )
  -- No search hash, key ID, encrypted envelope or full identifier leaves SQL.
  select jsonb_agg(to_jsonb(g) order by g.record_count desc,g.match_type,g.match_value,g.records->0->>'id')
  from groups g
 ),'[]'::jsonb);
end $$;
revoke all on function orl_private.c1_read_orl_db_duplicates(uuid) from public,anon,authenticated,service_role;

notify pgrst,'reload schema';
commit;
