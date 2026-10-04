-- LOCAL SYNTHETIC EXPERIMENT, NOT migration 046. Must not be deployed.
-- Keep production functions unmodified; derive clinical core from reviewed 040.
begin;
do $guard$
declare source text; expected text;
begin
  if session_user <> 'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet
     or to_regclass('c1_test_baseline') is null then
    raise exception 'LOCAL synthetic test runner required. Not a production migration.';
  end if;
  select body into expected from c1_test_baseline;
  select replace(prosrc,chr(13),'') into source from pg_proc
    where oid='public.orl_create_request(uuid,jsonb)'::regprocedure;
  if source is distinct from expected then raise exception 'Creation baseline changed; stop and review.'; end if;
  -- Exact clinical body retained. Only caller-supplied request UUID is added to INSERT.
  source := replace(source, E'    request_number,patient_ic,age,age_months,mrn,patient_name,surgery,diagnosis,doctor,',
    E'    id,request_number,patient_ic,age,age_months,mrn,patient_name,surgery,diagnosis,doctor,');
  source := replace(source, '    v_number,ic,v_age,v_months,trim(p_data', '    p_request_id,v_number,ic,v_age,v_months,trim(p_data');
  if source = expected or position('p_request_id,v_number' in source)=0 then raise exception 'Core adaptation failed.'; end if;
  execute 'create function orl_private.c1_create_core(p_session_token uuid,p_request_id uuid,p_data jsonb) returns uuid '
    || 'language plpgsql security definer set search_path=public,extensions as ' || quote_literal(source);
end $guard$;
revoke all on function orl_private.c1_create_core(uuid,uuid,jsonb) from public,anon,authenticated,service_role;

-- Durable creation receipts/tombstones: references only, no clinical data or tokens.
-- Kept when a request is removed, so a delayed CREATE cannot resurrect it.
create table orl_private.c1_creation_receipts (
  request_id uuid primary key, owner_id uuid not null,
  outcome text not null check(outcome in ('CREATED','CANCELLED')),
  created_at timestamptz not null default now()
);
alter table orl_private.c1_creation_receipts enable row level security;
alter table orl_private.c1_creation_receipts force row level security;
revoke all on orl_private.c1_creation_receipts from public,anon,authenticated,service_role;

-- A fresh generation on install/restore invalidates unknown delayed CREATEs too.
-- This state is deliberately NOT restored from a backup.
create table orl_private.c1_restore_generation (
  singleton boolean primary key default true check(singleton),
  generation uuid not null default gen_random_uuid()
);
insert into orl_private.c1_restore_generation(singleton) values(true);
alter table orl_private.c1_restore_generation enable row level security;
alter table orl_private.c1_restore_generation force row level security;
revoke all on orl_private.c1_restore_generation from public,anon,authenticated,service_role;

create function public.orl_ic_c1_prepare_create(p_session_token uuid)
returns uuid language plpgsql security definer set search_path='' as $$
begin
  perform public.orl_require_session(p_session_token);
  return (select generation from orl_private.c1_restore_generation where singleton);
end $$;
revoke all on function public.orl_ic_c1_prepare_create(uuid) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_c1_prepare_create(uuid) to service_role;

create function public.orl_ic_c1_create(p_session_token uuid,p_request_id uuid,p_data jsonb,p_envelope jsonb,p_search jsonb,p_generation uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype; raw text; result uuid;
begin
  -- Hard local-only gate also applies to function calls, not just fixture installation.
  if session_user <> 'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet then
    raise exception 'C1 local testing only.' using errcode='42501';
  end if;
  u:=public.orl_require_session(p_session_token);
  if p_request_id is null or jsonb_typeof(p_data) is distinct from 'object' then
    raise exception 'Invalid input.';
  end if;
  perform pg_advisory_xact_lock_shared(hashtextextended('orl_ic_restore_generation',0));
  if p_generation is distinct from (select generation from orl_private.c1_restore_generation where singleton)
    then raise exception 'Restore changed the save generation. Resolve the previous attempt.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('orl_ic_create:'||p_request_id::text,0));
  -- Existing or cancelled UUIDs never cause a second creation, even for overrides.
  insert into orl_private.c1_creation_receipts(request_id,owner_id,outcome)
    values(p_request_id,u.id,'CREATED');
  raw:=trim(coalesce(p_data->>'patient_ic',''));
  if raw='' then
    if p_envelope is not null or p_search is not null then raise exception 'Unexpected identity.'; end if;
  else
    if length(raw)>128 or raw ~ '[^ -~]' or raw !~ '[A-Za-z0-9]'
       or jsonb_typeof(p_envelope) is distinct from 'object'
       or jsonb_typeof(p_search) is distinct from 'object'
       or p_envelope->'version' is distinct from '1'::jsonb
       or p_search->'normalization_version' is distinct from '1'::jsonb then
      raise exception 'Invalid identity envelope.';
    end if;
  end if;
  -- UUID collisions fail; never overwrite an existing record on retry.
  result:=orl_private.c1_create_core(p_session_token,p_request_id,p_data);
  if raw<>'' then
    insert into orl_private.request_identity(request_id,envelope_version,encryption_key_id,nonce,ciphertext,
      search_key_id,search_hash,normalization_version)
    values(result,1,p_envelope->>'key_id',decode(p_envelope->>'nonce','base64'),decode(p_envelope->>'ciphertext','base64'),
      p_search->>'key_id',decode(p_search->>'hash','base64'),1);
  end if;
  -- No raw IC, search hash or envelope in audit details.
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
    values(u.id,u.display_name,u.role,'IC_SHADOW_CREATED','REQUEST',result::text,
      case when raw='' then 'Optional IC absent' else 'Encrypted copy verified by backend; original retained' end);
  return result;
end $$;
revoke all on function public.orl_ic_c1_create(uuid,uuid,jsonb,jsonb,jsonb,uuid) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_c1_create(uuid,uuid,jsonb,jsonb,jsonb,uuid) to service_role;

-- Resolves an uncertain save. If no CREATE committed, permanently fences this UUID.
-- A CREATE still encrypting/in flight must take the same lock and cannot arrive later.
create function public.orl_ic_c1_resolve_create(p_session_token uuid,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype; receipt orl_private.c1_creation_receipts%rowtype;
  r public.orl_requests%rowtype;
begin
  if session_user <> 'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet
    then raise exception 'C1 local testing only.' using errcode='42501'; end if;
  u:=public.orl_require_session(p_session_token);
  if p_request_id is null then raise exception 'Invalid input.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('orl_ic_create:'||p_request_id::text,0));
  u:=public.orl_require_session(p_session_token); -- recheck after any lock wait
  select * into receipt from orl_private.c1_creation_receipts where request_id=p_request_id;
  if found and receipt.owner_id is distinct from u.id then
    raise exception 'Access denied.' using errcode='42501';
  end if;
  select * into r from public.orl_requests where id=p_request_id;
  if found then
    if r.created_by is distinct from u.id then raise exception 'Access denied.' using errcode='42501'; end if;
    return jsonb_build_object('request_id',p_request_id,'outcome','CREATED',
      'status',r.status,'assigned',r.assigned_slot_id is not null);
  end if;
  if receipt.outcome='CREATED' then
    return jsonb_build_object('request_id',p_request_id,'outcome','UNAVAILABLE');
  end if;
  insert into orl_private.c1_creation_receipts(request_id,owner_id,outcome)
    values(p_request_id,u.id,'CANCELLED') on conflict(request_id) do nothing;
  return jsonb_build_object('request_id',p_request_id,'outcome','CANCELLED');
end $$;
revoke all on function public.orl_ic_c1_resolve_create(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_c1_resolve_create(uuid,uuid) to service_role;
commit;
