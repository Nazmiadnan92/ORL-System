-- Package C2: controlled legacy identity backfill and complete cryptographic
-- reconciliation. Plaintext patient_ic remains in place until separately
-- approved Package C6. Encryption keys are never stored in PostgreSQL.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $$
begin
  if to_regprocedure('public.orl_ic_c1_create(uuid,uuid,jsonb,jsonb,jsonb,uuid)') is null
     or to_regprocedure('orl_private.c1_store_identity(uuid,text,jsonb,jsonb)') is null
     or to_regprocedure('orl_private.c1_recovery_ready()') is null
     or orl_private.c1_mask_ic('010203-04-5678') is distinct from '010203-**-****' then
    raise exception 'STOP: migrations 046 and 047 are required';
  end if;
  if to_regclass('orl_private.c2_verification_runs') is not null
     or to_regprocedure('public.orl_ic_c2_status(uuid,text)') is not null then
    raise exception 'STOP: migration 048 already exists or conflicts';
  end if;
  if not orl_private.c1_recovery_ready() then
    raise exception 'STOP: full-dump recovery gate is not ready';
  end if;
end $$;

create table orl_private.c2_verification_runs(
  run_id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.orl_users(id) on delete restrict,
  generation uuid not null,
  revision text not null check(revision~'^[a-f0-9]{32}$'),
  started_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default clock_timestamp()+interval '2 hours',
  completed_at timestamptz,
  check(expires_at>started_at)
);
create table orl_private.c2_verified_identity(
  run_id uuid not null references orl_private.c2_verification_runs(run_id) on delete cascade,
  request_id uuid not null references orl_private.request_identity(request_id) on delete cascade,
  request_updated_at timestamptz not null,
  identity_updated_at timestamptz not null,
  verified_at timestamptz not null default clock_timestamp(),
  primary key(run_id,request_id)
);
alter table orl_private.c2_verification_runs enable row level security;
alter table orl_private.c2_verification_runs force row level security;
alter table orl_private.c2_verified_identity enable row level security;
alter table orl_private.c2_verified_identity force row level security;
revoke all on orl_private.c2_verification_runs,orl_private.c2_verified_identity
  from public,anon,authenticated,service_role;

create function orl_private.c2_supported(p_raw text) returns boolean
language sql immutable set search_path='' as $$
  select p_raw is not null and length(trim(p_raw)) between 1 and 128
    and p_raw !~ '[^ -~]' and p_raw ~ '[A-Za-z0-9]'
$$;
revoke all on function orl_private.c2_supported(text) from public,anon,authenticated,service_role;

create function orl_private.c2_revision() returns text
language sql stable security definer set search_path='' as $$
  select md5(coalesce(string_agg(
    r.id::text||':'||extract(epoch from r.updated_at)::text||':'||md5(coalesce(r.patient_ic,''))||':'||
    coalesce(extract(epoch from i.updated_at)::text,'-')||':'||coalesce(md5(encode(i.ciphertext,'hex')),'-')||':'||
    coalesce(encode(i.search_hash,'hex'),'-'),',' order by r.id),'')||':'||
    (select generation::text from orl_private.c1_restore_generation where singleton))
  from public.orl_requests r left join orl_private.request_identity i on i.request_id=r.id
$$;
revoke all on function orl_private.c2_revision() from public,anon,authenticated,service_role;

create function orl_private.c2_stats() returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'total_requests',(select count(*) from public.orl_requests),
    'nonblank_requests',(select count(*) from public.orl_requests where trim(coalesce(patient_ic,''))<>''),
    'identity_rows',(select count(*) from orl_private.request_identity),
    'protected_nonblank',(select count(*) from public.orl_requests r join orl_private.request_identity i on i.request_id=r.id
      where trim(coalesce(r.patient_ic,''))<>''),
    'missing_supported',(select count(*) from public.orl_requests r left join orl_private.request_identity i on i.request_id=r.id
      where i.request_id is null and trim(coalesce(r.patient_ic,''))<>'' and orl_private.c2_supported(r.patient_ic)),
    'missing_unsupported',(select count(*) from public.orl_requests r left join orl_private.request_identity i on i.request_id=r.id
      where i.request_id is null and trim(coalesce(r.patient_ic,''))<>'' and not orl_private.c2_supported(r.patient_ic)),
    'blank_with_identity',(select count(*) from public.orl_requests r join orl_private.request_identity i on i.request_id=r.id
      where trim(coalesce(r.patient_ic,''))=''),
    'complete',not exists(select 1 from public.orl_requests r left join orl_private.request_identity i on i.request_id=r.id
      where (trim(coalesce(r.patient_ic,''))<>'' and i.request_id is null) or
            (trim(coalesce(r.patient_ic,''))='' and i.request_id is not null)))
$$;
revoke all on function orl_private.c2_stats() from public,anon,authenticated,service_role;

create function public.orl_ic_c2_status(p_session_token uuid,p_password text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype; g uuid; result jsonb;
begin
  u:=public.orl_require_webmaster_password(p_session_token,p_password);
  perform orl_private.c1_check_generation((select generation from orl_private.c1_restore_generation where singleton));
  select generation into g from orl_private.c1_restore_generation where singleton;
  result:=orl_private.c2_stats()||jsonb_build_object('generation',g,'revision',orl_private.c2_revision(),
    'last_completed_at',(select max(completed_at) from orl_private.c2_verification_runs));
  return result;
end $$;
revoke all on function public.orl_ic_c2_status(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_c2_status(uuid,text) to service_role;

create function public.orl_ic_c2_backfill_view(p_session_token uuid,p_password text,p_generation uuid,p_revision text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype; g uuid; current_revision text; items jsonb;
begin
  u:=public.orl_require_webmaster_password(p_session_token,p_password);
  perform orl_private.c1_check_generation(p_generation);
  if p_revision is null or p_revision!~'^[a-f0-9]{32}$' then raise exception 'Invalid C2 revision'; end if;
  lock table public.orl_requests,orl_private.request_identity in share mode nowait;
  current_revision:=orl_private.c2_revision();
  if p_revision is distinct from current_revision then raise exception 'C2 inventory changed. Reload status'; end if;
  select generation into g from orl_private.c1_restore_generation where singleton;
  select coalesce(jsonb_agg(jsonb_build_object('request_id',x.id,'patient_ic',x.patient_ic,
      'expected_request_updated_at',x.updated_at) order by x.id),'[]'::jsonb) into items
  from (select r.id,r.patient_ic,r.updated_at from public.orl_requests r
    left join orl_private.request_identity i on i.request_id=r.id
    where i.request_id is null and trim(coalesce(r.patient_ic,''))<>'' and orl_private.c2_supported(r.patient_ic)
    order by r.id limit 40) x;
  return jsonb_build_object('generation',g,'revision',current_revision,'items',items);
end $$;
revoke all on function public.orl_ic_c2_backfill_view(uuid,text,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_c2_backfill_view(uuid,text,uuid,text) to service_role;

create function public.orl_ic_c2_backfill_commit(p_session_token uuid,p_password text,p_generation uuid,p_revision text,p_items jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype; item jsonb; expected jsonb; supplied jsonb; request_row public.orl_requests%rowtype;
  committed integer:=0; result jsonb;
begin
  u:=public.orl_require_webmaster_password(p_session_token,p_password);
  perform orl_private.c1_check_generation(p_generation);
  if p_revision is null or p_revision!~'^[a-f0-9]{32}$' or jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_array_length(p_items) not between 1 and 40 then raise exception 'Invalid C2 batch'; end if;
  if exists(select 1 from jsonb_array_elements(p_items) x(value) where jsonb_typeof(value) is distinct from 'object'
      or value-array['request_id','expected_request_updated_at','envelope','search']<>'{}'::jsonb
      or coalesce(value->>'request_id','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or jsonb_typeof(value->'envelope') is distinct from 'object' or jsonb_typeof(value->'search') is distinct from 'object')
    then raise exception 'Invalid C2 batch item'; end if;
  lock table public.orl_requests,orl_private.request_identity in share row exclusive mode nowait;
  if p_revision is distinct from orl_private.c2_revision() then raise exception 'C2 inventory changed. Reload status'; end if;
  select coalesce(jsonb_agg(to_jsonb(x.id::text) order by x.id),'[]'::jsonb) into expected from
    (select r.id from public.orl_requests r left join orl_private.request_identity i on i.request_id=r.id
      where i.request_id is null and trim(coalesce(r.patient_ic,''))<>'' and orl_private.c2_supported(r.patient_ic)
      order by r.id limit 40) x;
  select coalesce(jsonb_agg(to_jsonb(x.value->>'request_id') order by x.ordinality),'[]'::jsonb) into supplied
    from jsonb_array_elements(p_items) with ordinality x(value,ordinality);
  if supplied is distinct from expected then raise exception 'C2 batch targets changed'; end if;
  for item in select value from jsonb_array_elements(p_items) loop
    select * into request_row from public.orl_requests where id=(item->>'request_id')::uuid for update;
    if not found or request_row.updated_at is distinct from (item->>'expected_request_updated_at')::timestamptz
       or trim(coalesce(request_row.patient_ic,''))='' or not orl_private.c2_supported(request_row.patient_ic)
       or exists(select 1 from orl_private.request_identity where request_id=request_row.id) then
      raise exception 'C2 batch record changed';
    end if;
    perform orl_private.c1_store_identity(request_row.id,request_row.patient_ic,item->'envelope',item->'search');
    committed:=committed+1;
  end loop;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
    values(u.id,u.display_name,u.role,'IC_C2_BACKFILL_BATCH','SYSTEM','C2',
      'Encrypted legacy identity batch; plaintext retained pending C6. Count: '||committed);
  result:=orl_private.c2_stats()||jsonb_build_object('generation',p_generation,'revision',orl_private.c2_revision(),'committed',committed);
  return result;
end $$;
revoke all on function public.orl_ic_c2_backfill_commit(uuid,text,uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_c2_backfill_commit(uuid,text,uuid,text,jsonb) to service_role;

create function public.orl_ic_c2_verify_start(p_session_token uuid,p_password text,p_generation uuid,p_revision text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype; stats jsonb; run uuid; total integer;
begin
  u:=public.orl_require_webmaster_password(p_session_token,p_password);
  perform orl_private.c1_check_generation(p_generation);
  lock table public.orl_requests,orl_private.request_identity in share mode nowait;
  if p_revision is distinct from orl_private.c2_revision() then raise exception 'C2 inventory changed. Reload status'; end if;
  stats:=orl_private.c2_stats();
  if (stats->>'complete')::boolean is distinct from true or (stats->>'missing_unsupported')::integer<>0
     or (stats->>'blank_with_identity')::integer<>0 then raise exception 'C2 backfill is not structurally complete'; end if;
  delete from orl_private.c2_verification_runs where owner_id=u.id and completed_at is null;
  insert into orl_private.c2_verification_runs(owner_id,generation,revision)
    values(u.id,p_generation,p_revision) returning run_id into run;
  total:=(stats->>'identity_rows')::integer;
  return jsonb_build_object('run_id',run,'generation',p_generation,'total',total,'verified',0,'remaining',total);
end $$;
revoke all on function public.orl_ic_c2_verify_start(uuid,text,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_c2_verify_start(uuid,text,uuid,text) to service_role;

create function public.orl_ic_c2_verify_view(p_session_token uuid,p_password text,p_generation uuid,p_run_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype; run orl_private.c2_verification_runs%rowtype; items jsonb;
begin
  u:=public.orl_require_webmaster_password(p_session_token,p_password);
  perform orl_private.c1_check_generation(p_generation);
  select * into run from orl_private.c2_verification_runs where run_id=p_run_id for update;
  if not found or run.owner_id<>u.id or run.generation<>p_generation or run.completed_at is not null
     or run.expires_at<=clock_timestamp() then raise exception 'C2 verification run unavailable'; end if;
  lock table public.orl_requests,orl_private.request_identity in share mode nowait;
  if run.revision is distinct from orl_private.c2_revision() then raise exception 'C2 records changed. Restart verification'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('request_id',x.request_id,'patient_ic',x.patient_ic,
      'expected_request_updated_at',x.request_updated_at,'expected_identity_updated_at',x.identity_updated_at,
      'envelope',jsonb_build_object('version',x.envelope_version,'key_id',x.encryption_key_id,
        'nonce',replace(encode(x.nonce,'base64'),chr(10),''),'ciphertext',replace(encode(x.ciphertext,'base64'),chr(10),'')),
      'search',jsonb_build_object('key_id',x.search_key_id,'normalization_version',x.normalization_version,
        'hash',replace(encode(x.search_hash,'base64'),chr(10),''))) order by x.request_id),'[]'::jsonb) into items
  from (select r.id request_id,r.patient_ic,r.updated_at request_updated_at,i.updated_at identity_updated_at,
      i.envelope_version,i.encryption_key_id,i.nonce,i.ciphertext,i.search_key_id,i.search_hash,i.normalization_version
    from public.orl_requests r join orl_private.request_identity i on i.request_id=r.id
    where not exists(select 1 from orl_private.c2_verified_identity v where v.run_id=p_run_id and v.request_id=r.id)
    order by r.id limit 40) x;
  return jsonb_build_object('run_id',p_run_id,'generation',p_generation,'items',items);
end $$;
revoke all on function public.orl_ic_c2_verify_view(uuid,text,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_c2_verify_view(uuid,text,uuid,uuid) to service_role;

create function public.orl_ic_c2_verify_commit(p_session_token uuid,p_password text,p_generation uuid,p_run_id uuid,p_items jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype; run orl_private.c2_verification_runs%rowtype; item jsonb; expected jsonb; supplied jsonb;
  r_updated timestamptz; i_updated timestamptz; total integer; verified integer;
begin
  u:=public.orl_require_webmaster_password(p_session_token,p_password);
  perform orl_private.c1_check_generation(p_generation);
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 40
     or exists(select 1 from jsonb_array_elements(p_items) x(value) where jsonb_typeof(value) is distinct from 'object'
       or value-array['request_id','expected_request_updated_at','expected_identity_updated_at']<>'{}'::jsonb
       or coalesce(value->>'request_id','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    then raise exception 'Invalid C2 verification receipt'; end if;
  select * into run from orl_private.c2_verification_runs where run_id=p_run_id for update;
  if not found or run.owner_id<>u.id or run.generation<>p_generation or run.completed_at is not null
     or run.expires_at<=clock_timestamp() then raise exception 'C2 verification run unavailable'; end if;
  lock table public.orl_requests,orl_private.request_identity in share mode nowait;
  if run.revision is distinct from orl_private.c2_revision() then raise exception 'C2 records changed. Restart verification'; end if;
  select coalesce(jsonb_agg(to_jsonb(x.request_id::text) order by x.request_id),'[]'::jsonb) into expected from
    (select r.id request_id from public.orl_requests r join orl_private.request_identity i on i.request_id=r.id
      where not exists(select 1 from orl_private.c2_verified_identity v where v.run_id=p_run_id and v.request_id=r.id)
      order by r.id limit 40) x;
  select coalesce(jsonb_agg(to_jsonb(x.value->>'request_id') order by x.ordinality),'[]'::jsonb) into supplied
    from jsonb_array_elements(p_items) with ordinality x(value,ordinality);
  if supplied is distinct from expected then raise exception 'C2 verification targets changed'; end if;
  for item in select value from jsonb_array_elements(p_items) loop
    select r.updated_at,i.updated_at into r_updated,i_updated from public.orl_requests r
      join orl_private.request_identity i on i.request_id=r.id where r.id=(item->>'request_id')::uuid;
    if not found or r_updated is distinct from (item->>'expected_request_updated_at')::timestamptz
       or i_updated is distinct from (item->>'expected_identity_updated_at')::timestamptz then
      raise exception 'C2 verification record changed';
    end if;
    insert into orl_private.c2_verified_identity(run_id,request_id,request_updated_at,identity_updated_at)
      values(p_run_id,(item->>'request_id')::uuid,r_updated,i_updated);
  end loop;
  select count(*) into total from orl_private.request_identity;
  select count(*) into verified from orl_private.c2_verified_identity where run_id=p_run_id;
  return jsonb_build_object('run_id',p_run_id,'generation',p_generation,'total',total,
    'verified',verified,'remaining',total-verified);
end $$;
revoke all on function public.orl_ic_c2_verify_commit(uuid,text,uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_c2_verify_commit(uuid,text,uuid,uuid,jsonb) to service_role;

create function public.orl_ic_c2_finalize(p_session_token uuid,p_password text,p_generation uuid,p_run_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype; run orl_private.c2_verification_runs%rowtype; stats jsonb; total integer;
begin
  u:=public.orl_require_webmaster_password(p_session_token,p_password);
  perform orl_private.c1_check_generation(p_generation);
  select * into run from orl_private.c2_verification_runs where run_id=p_run_id for update;
  if not found or run.owner_id<>u.id or run.generation<>p_generation or run.completed_at is not null
     or run.expires_at<=clock_timestamp() then raise exception 'C2 verification run unavailable'; end if;
  lock table public.orl_requests,orl_private.request_identity in share mode nowait;
  if run.revision is distinct from orl_private.c2_revision() then raise exception 'C2 records changed. Restart verification'; end if;
  stats:=orl_private.c2_stats();
  if (stats->>'complete')::boolean is distinct from true or (stats->>'missing_unsupported')::integer<>0
     or (stats->>'blank_with_identity')::integer<>0 then raise exception 'C2 reconciliation incomplete'; end if;
  if exists(select 1 from public.orl_requests r join orl_private.request_identity i on i.request_id=r.id
      left join orl_private.c2_verified_identity v on v.run_id=p_run_id and v.request_id=r.id
        and v.request_updated_at=r.updated_at and v.identity_updated_at=i.updated_at
      where trim(coalesce(r.patient_ic,''))='' or v.request_id is null) then
    raise exception 'C2 cryptographic verification incomplete';
  end if;
  update orl_private.c2_verification_runs set completed_at=clock_timestamp() where run_id=p_run_id;
  total:=(stats->>'identity_rows')::integer;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
    values(u.id,u.display_name,u.role,'IC_C2_COMPLETED','SYSTEM','C2',
      'Legacy identity encryption and full cryptographic reconciliation completed. Plaintext retained pending C6. Count: '||total);
  return stats||jsonb_build_object('status','COMPLETED','run_id',p_run_id,'generation',p_generation,
    'revision',run.revision,'verified',total,'completed_at',clock_timestamp());
end $$;
revoke all on function public.orl_ic_c2_finalize(uuid,text,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_c2_finalize(uuid,text,uuid,uuid) to service_role;

notify pgrst,'reload schema';
commit;
