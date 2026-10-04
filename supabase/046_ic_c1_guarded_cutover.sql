-- C1 guarded cutover: protected write gateway, masked reads, backup V2 and recovery fences.
-- Generated only by security/release/build-046.mjs from hash-pinned local fixtures.
-- This migration does not backfill identities, remove plaintext IC, deploy Edge code, set secrets or enable the website flag.
begin;
set local lock_timeout='5s';
set local statement_timeout='120s';

do $release_guard$
declare create_source text;
begin
  if to_regclass('orl_private.request_identity') is null
     or to_regprocedure('public.orl_ic_foundation_probe(uuid)') is null then
    raise exception 'STOP: migration 045 foundation is required. No changes applied.';
  end if;
  if to_regclass('orl_private.c1_restore_generation') is not null
     or to_regprocedure('public.orl_ic_c1_create(uuid,uuid,jsonb,jsonb,jsonb,uuid)') is not null then
    raise exception 'STOP: migration 046 already exists or conflicts. No changes applied.';
  end if;
  if not exists(select 1 from pg_roles where rolname='service_role')
     or to_regprocedure('public.orl_generate_public_holidays(uuid,integer)') is null then
    raise exception 'STOP: production prerequisites through migration 045 are incomplete. No changes applied.';
  end if;
  select replace(prosrc,chr(13),'') into create_source from pg_proc
    where oid=to_regprocedure('public.orl_create_request(uuid,jsonb)');
  if md5(create_source) is distinct from '510bb2377c27c11629428fe90244aba7' then
    raise exception 'STOP: reviewed migration 040 creation baseline differs. No changes applied.';
  end if;
end $release_guard$;

do $guard$
declare source text; expected_hash constant text:='510bb2377c27c11629428fe90244aba7';
begin
  select replace(prosrc,chr(13),'') into source from pg_proc
    where oid='public.orl_create_request(uuid,jsonb)'::regprocedure;
  if md5(source) is distinct from expected_hash then raise exception 'Creation baseline changed; stop and review.'; end if;
  -- Exact clinical body retained. Only caller-supplied request UUID is added to INSERT.
  source := replace(source, E'    request_number,patient_ic,age,age_months,mrn,patient_name,surgery,diagnosis,doctor,',
    E'    id,request_number,patient_ic,age,age_months,mrn,patient_name,surgery,diagnosis,doctor,');
  source := replace(source, '    v_number,ic,v_age,v_months,trim(p_data', '    p_request_id,v_number,ic,v_age,v_months,trim(p_data');
  if md5(source)=expected_hash or position('p_request_id,v_number' in source)=0 then raise exception 'Core adaptation failed.'; end if;
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


-- Reviewed release body derived from compatibility.sql.
-- Scoped to one transaction, inaccessible to API roles, removed before return.
-- No bypass based on a caller-writable custom PostgreSQL setting.
create table orl_private.c1_write_permit (
  transaction_id xid8 not null, request_id uuid not null,
  primary key(transaction_id,request_id)
);
revoke all on orl_private.c1_write_permit from public,anon,authenticated,service_role;
alter table orl_private.c1_write_permit enable row level security;
alter table orl_private.c1_write_permit force row level security;

create function orl_private.c1_guard_ic_update()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.patient_ic is distinct from old.patient_ic
     and exists(select 1 from orl_private.request_identity where request_id=old.id)
     and not exists(select 1 from orl_private.c1_write_permit
       where transaction_id=pg_current_xact_id() and request_id=old.id) then
    raise exception 'Protected IC must be changed through the compatible backend.';
  end if;
  return new;
end $$;
revoke all on function orl_private.c1_guard_ic_update() from public,anon,authenticated,service_role;
create trigger orl_c1_ic_update_guard before update of patient_ic on public.orl_requests
  for each row execute function orl_private.c1_guard_ic_update();

create function orl_private.c1_store_identity(p_id uuid,p_raw text,p_envelope jsonb,p_search jsonb)
returns void language plpgsql security definer set search_path='' as $$
begin
  if p_raw is null then raise exception 'Explicit IC required.'; end if;
  if p_raw='' then
    if p_envelope is not null or p_search is not null then raise exception 'Unexpected identity.'; end if;
    delete from orl_private.request_identity where request_id=p_id;
    return;
  end if;
  if length(p_raw)>128 or p_raw ~ '[^ -~]' or p_raw !~ '[A-Za-z0-9]'
    or jsonb_typeof(p_envelope) is distinct from 'object' or jsonb_typeof(p_search) is distinct from 'object'
    or p_envelope->'version' is distinct from '1'::jsonb
    or p_search->'normalization_version' is distinct from '1'::jsonb then
    raise exception 'Invalid identity envelope.';
  end if;
  insert into orl_private.request_identity(request_id,envelope_version,encryption_key_id,nonce,ciphertext,search_key_id,search_hash,normalization_version)
  values(p_id,1,p_envelope->>'key_id',decode(p_envelope->>'nonce','base64'),decode(p_envelope->>'ciphertext','base64'),
    p_search->>'key_id',decode(p_search->>'hash','base64'),1)
  on conflict(request_id) do update set envelope_version=excluded.envelope_version,encryption_key_id=excluded.encryption_key_id,
    nonce=excluded.nonce,ciphertext=excluded.ciphertext,search_key_id=excluded.search_key_id,
    search_hash=excluded.search_hash,normalization_version=excluded.normalization_version,updated_at=now();
end $$;
revoke all on function orl_private.c1_store_identity(uuid,text,jsonb,jsonb) from public,anon,authenticated,service_role;

-- KEEP means no patient_ic field at all; SET includes explicit string (empty clears).
-- This prevents a masked display value accidentally replacing the original IC.
create function orl_private.c1_check_generation(p_generation uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not pg_try_advisory_xact_lock_shared(hashtextextended('orl_ic_restore_generation',0)) then
    raise exception 'Restore is running. Reload records before another action.';
  end if;
  if p_generation is null or p_generation is distinct from
    (select generation from orl_private.c1_restore_generation where singleton) then
    raise exception 'Records changed after Restore. Reload before another action.';
  end if;
end $$;
revoke all on function orl_private.c1_check_generation(uuid) from public,anon,authenticated,service_role;

create function public.orl_ic_c1_mutate(p_session_token uuid,p_operation text,p_from_slot uuid,p_to_slot uuid,
  p_expected_request uuid,p_data jsonb,p_action text,p_reason text,p_ic_mode text,p_envelope jsonb,p_search jsonb,
  p_generation uuid,p_expected_version timestamptz)
returns text language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype; r public.orl_requests%rowtype; result text; raw text;
begin
  u:=public.orl_require_session(p_session_token);
  perform orl_private.c1_check_generation(p_generation);
  if p_operation is null or p_operation not in('EDIT','MOVE') or p_ic_mode is null or p_ic_mode not in('KEEP','SET')
    or jsonb_typeof(p_data) is distinct from 'object' then raise exception 'Invalid operation.'; end if;
  if p_data ? 'postpone_count' then
    if u.role<>'WEBMASTER' then raise exception 'Postpone count requires Webmaster.'; end if;
    if p_operation<>'EDIT' or jsonb_typeof(p_data->'postpone_count') is distinct from 'string'
       or (p_data->>'postpone_count') !~ '^[0-9]{1,3}$' then
      raise exception 'Manual postpone count must be 0-999 and saved through Edit.';
    end if;
  end if;
  if p_ic_mode='KEEP' then
    if p_data ? 'patient_ic' or p_envelope is not null or p_search is not null then raise exception 'KEEP cannot replace IC.'; end if;
  else
    if u.role not in('ADMIN','WEBMASTER') then raise exception 'IC changes require Admin or Webmaster.' using errcode='42501'; end if;
    if jsonb_typeof(p_data->'patient_ic') is distinct from 'string' then raise exception 'Explicit IC required.'; end if;
    raw:=trim(p_data->>'patient_ic');
    p_data:=jsonb_set(p_data,'{patient_ic}',to_jsonb(raw));
  end if;
  if p_operation='EDIT' and p_to_slot is not null then raise exception 'Unexpected destination.'; end if;
  if p_operation='MOVE' and p_to_slot is null then raise exception 'Destination required.'; end if;
  -- Same lock order as existing checked functions: ALL involved slots, then request.
  perform 1 from public.orl_ot_slots where session_id in(
    select session_id from public.orl_ot_slots where id in(p_from_slot,p_to_slot)) order by id for update;
  if p_expected_request is null or not exists(select 1 from public.orl_ot_slots
    where id=p_from_slot and request_id=p_expected_request) then raise exception 'The selected OT patient has changed.'; end if;
  select * into r from public.orl_requests where id=p_expected_request for update;
  if not found then raise exception 'Request not found.'; end if;
  -- The generation fence handles Restore. This exact row revision additionally
  -- rejects a same-generation edit opened before another user changed the record.
  if p_expected_version is null or r.updated_at is distinct from p_expected_version then
    raise exception 'The patient record changed. Reload and review it before saving.';
  end if;
  if p_ic_mode='SET' then
    insert into orl_private.c1_write_permit values(pg_current_xact_id(),r.id);
    -- Do not remove old shadow until after core update; guard sees and checks permit.
  end if;
  if p_operation='EDIT' then
    perform public.orl_edit_scheduled_request_checked(p_session_token,p_from_slot,p_data-'postpone_count',p_action,p_expected_request);
    result:='UPDATED';
  else
    result:=public.orl_move_postponed_checked(p_session_token,p_from_slot,p_to_slot,p_data,p_reason,p_expected_request);
  end if;
  if p_ic_mode='SET' then
    if (select patient_ic from public.orl_requests where id=r.id) is distinct from raw then raise exception 'IC write mismatch.'; end if;
    perform orl_private.c1_store_identity(r.id,raw,p_envelope,p_search);
    delete from orl_private.c1_write_permit where transaction_id=pg_current_xact_id() and request_id=r.id;
    insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
      values(u.id,u.display_name,u.role,'IC_SHADOW_UPDATED','REQUEST',r.id::text,'Identity updated atomically; original retained');
  end if;
  if p_data ? 'postpone_count' and (p_data->>'postpone_count')::integer is distinct from r.postpone_count then
    perform public.orl_set_postpone_count(p_session_token,r.id,(p_data->>'postpone_count')::integer);
    insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
      values(u.id,u.display_name,u.role,'POSTPONE_COUNT_UPDATED','REQUEST',r.id::text,
        'Manual count: '||coalesce(r.postpone_count,0)||' to '||(p_data->>'postpone_count'));
  end if;
  return result;
end $$;
revoke all on function public.orl_ic_c1_mutate(uuid,text,uuid,uuid,uuid,jsonb,text,text,text,jsonb,jsonb,uuid,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_c1_mutate(uuid,text,uuid,uuid,uuid,jsonb,text,text,text,jsonb,jsonb,uuid,timestamptz) to service_role;

-- Reassign changes slot links only: identities stay bound to the same request UUID.
create function public.orl_ic_c1_confirm(p_session_token uuid,p_request_id uuid,p_generation uuid)
returns text language plpgsql security definer set search_path='' as $$
begin
  perform public.orl_require_session(p_session_token);
  perform orl_private.c1_check_generation(p_generation);
  -- Historical core checks ownership, DRAFT status and locks the request. Its
  -- status change and audit share this transaction and restore-generation fence.
  return public.orl_confirm_request(p_session_token,p_request_id);
end $$;
revoke all on function public.orl_ic_c1_confirm(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_c1_confirm(uuid,uuid,uuid) to service_role;

-- Both the saved request and the displayed slot must belong to this generation.
create function public.orl_ic_c1_assign(p_session_token uuid,p_request_id uuid,p_slot_id uuid,
  p_generation uuid,p_slot_generation uuid)
returns text language plpgsql security definer set search_path='' as $$
begin
  perform public.orl_require_session(p_session_token);
  perform orl_private.c1_check_generation(p_generation);
  if p_slot_generation is null or p_slot_generation is distinct from p_generation then
    raise exception 'Reload the schedule and check the saved request.';
  end if;
  -- 037 core locks slot then request, rechecks ownership, status, holidays and
  -- Main/Special permissions. Assignment and audit remain one transaction.
  return public.orl_assign_slot(p_session_token,p_request_id,p_slot_id);
end $$;
revoke all on function public.orl_ic_c1_assign(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_c1_assign(uuid,uuid,uuid,uuid,uuid) to service_role;

create function public.orl_ic_c1_review(p_session_token uuid,p_request_id uuid,p_action text,p_note text,
  p_expected_slot uuid,p_generation uuid)
returns text language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype; r public.orl_requests%rowtype;
begin
  u:=public.orl_require_session(p_session_token);
  if u.role not in ('ADMIN','WEBMASTER') then raise exception 'Admin access required.'; end if;
  if p_action is null or p_action not in ('APPROVE','REJECT') or p_note is null or length(p_note)>4096 then
    raise exception 'Invalid review.';
  end if;
  perform orl_private.c1_check_generation(p_generation);
  -- Lock the displayed slot before the request, matching assignment/037 order.
  if p_expected_slot is not null then
    perform 1 from public.orl_ot_slots where id=p_expected_slot for update;
  end if;
  select * into r from public.orl_requests where id=p_request_id for update;
  if not found or r.assigned_slot_id is distinct from p_expected_slot then
    raise exception 'Request slot changed. Reload and review again.';
  end if;
  -- Reuse 037 status/link checks and atomic status/slot/audit writes.
  return public.orl_review_request(p_session_token,p_request_id,p_action,p_note);
end $$;
revoke all on function public.orl_ic_c1_review(uuid,uuid,text,text,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_c1_review(uuid,uuid,text,text,uuid,uuid) to service_role;

create function public.orl_ic_c1_clear(p_session_token uuid,p_slot_id uuid,p_expected_request_id uuid,p_generation uuid)
returns text language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype;
begin
  u:=public.orl_require_session(p_session_token);
  if u.role not in ('ADMIN','WEBMASTER') then raise exception 'Admin access required.'; end if;
  perform orl_private.c1_check_generation(p_generation);
  -- 036 locks slot then request and validates both links/expected patient.
  -- Clear retains the request and identity; no deletion or compaction is added.
  perform public.orl_clear_slot_checked(p_session_token,p_slot_id,p_expected_request_id);
  return 'CLEARED';
end $$;
revoke all on function public.orl_ic_c1_clear(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_c1_clear(uuid,uuid,uuid,uuid) to service_role;

create function public.orl_ic_c1_deletion(p_session_token uuid,p_operation text,p_request_id uuid,
  p_expected_slot uuid,p_expected_version timestamptz,p_generation uuid,p_reason text)
returns text language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype; r public.orl_requests%rowtype;
begin
  u:=public.orl_require_session(p_session_token);
  if p_operation is null or p_operation not in ('REQUEST','APPROVE','REJECT') then raise exception 'Invalid operation.'; end if;
  if p_operation<>'REQUEST' and u.role not in ('ADMIN','WEBMASTER') then raise exception 'Admin access required.'; end if;
  if p_operation='REQUEST' and (p_reason is null or trim(p_reason)='' or length(p_reason)>4096) then raise exception 'Cancellation reason required.'; end if;
  perform orl_private.c1_check_generation(p_generation);
  -- Lock ALL slots in the displayed session before the request, matching 035
  -- resolution/compaction. A changed selection fails before clinical changes.
  if p_expected_slot is not null then
    perform 1 from public.orl_ot_slots where session_id=(select session_id from public.orl_ot_slots where id=p_expected_slot)
      order by id for update;
  end if;
  select * into r from public.orl_requests where id=p_request_id for update;
  if not found or p_expected_version is null or r.updated_at is distinct from p_expected_version
    or r.assigned_slot_id is distinct from p_expected_slot then raise exception 'Cancellation selection changed. Reload and review again.'; end if;
  if p_operation='REQUEST' then
    -- 008 used <>; explicitly deny a Staff request with a missing/null owner.
    if u.role='STAFF' and r.created_by is distinct from u.id then raise exception 'You do not have access.'; end if;
    perform public.orl_request_deletion(p_session_token,p_request_id,p_reason);
    return 'REQUESTED';
  end if;
  perform public.orl_resolve_deletion(p_session_token,p_request_id,p_operation);
  return p_operation;
end $$;
revoke all on function public.orl_ic_c1_deletion(uuid,text,uuid,uuid,timestamptz,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_c1_deletion(uuid,text,uuid,uuid,timestamptz,uuid,text) to service_role;

create function public.orl_ic_c1_reassign(p_session_token uuid,p_from uuid,p_to uuid,
  p_expected_from_request_id uuid,p_expected_to_request_id uuid,p_generation uuid)
returns text language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype;
begin
  u:=public.orl_require_session(p_session_token);
  if u.role not in('ADMIN','WEBMASTER') then raise exception 'Admin access required.'; end if;
  -- Shared transaction lock remains held through the clinical core and its audit.
  perform orl_private.c1_check_generation(p_generation);
  perform public.orl_swap_slots_checked(p_session_token,p_from,p_to,p_expected_from_request_id,p_expected_to_request_id);
  return 'REASSIGNED';
end $$;
revoke all on function public.orl_ic_c1_reassign(uuid,uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_c1_reassign(uuid,uuid,uuid,uuid,uuid,uuid) to service_role;

create function public.orl_ic_c1_remove(p_session_token uuid,p_password text,p_mode text,p_value text,p_generation uuid,p_expected_ids uuid[])
returns integer language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype; ids uuid[];
begin
  u:=public.orl_require_webmaster_password(p_session_token,p_password);
  perform orl_private.c1_check_generation(p_generation);
  lock table public.orl_requests,public.orl_ot_slots,orl_private.request_identity in access exclusive mode nowait;
  if upper(p_mode)='REQUEST' then select array_agg(id) into ids from public.orl_requests where id=p_value::uuid;
  elsif upper(p_mode)='MRN' then select array_agg(id) into ids from public.orl_requests where lower(trim(mrn))=lower(trim(p_value));
  else raise exception 'Invalid removal mode.'; end if;
  if ids is null then raise exception 'No matching patient records found.'; end if;
  if p_expected_ids is null or cardinality(p_expected_ids)=0
    or (select array_agg(x order by x) from unnest(ids) x) is distinct from
       (select array_agg(x order by x) from unnest(p_expected_ids) x) then
    raise exception 'Removal targets changed. Reload and review the records again.';
  end if;
  delete from orl_private.request_identity where request_id=any(ids);
  return public.orl_db_remove_patient(p_session_token,p_password,p_mode,p_value);
end $$;
revoke all on function public.orl_ic_c1_remove(uuid,text,text,text,uuid,uuid[]) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_c1_remove(uuid,text,text,text,uuid,uuid[]) to service_role;

create function public.orl_ic_c1_export(p_session_token uuid,p_password text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype; result jsonb; identities jsonb; receipts jsonb;
begin
  u:=public.orl_require_webmaster_password(p_session_token,p_password);
  if not pg_try_advisory_xact_lock(hashtext('orl_ic_backup_export')) then raise exception 'Backup already running.'; end if;
  -- Avoid a mixed snapshot across the legacy export's multiple SELECT statements.
  lock table public.orl_users,public.orl_sessions,public.orl_settings,public.orl_holidays,public.orl_ot_sessions,
    public.orl_requests,public.orl_ot_slots,public.orl_audit_log,orl_private.request_identity,
    orl_private.c1_creation_receipts in share mode nowait;
  result:=public.orl_db_export(p_session_token,p_password);
  select coalesce(jsonb_agg(jsonb_build_object('request_id',i.request_id,
    'envelope',jsonb_build_object('version',i.envelope_version,'key_id',i.encryption_key_id,
      'nonce',replace(encode(i.nonce,'base64'),chr(10),''),'ciphertext',replace(encode(i.ciphertext,'base64'),chr(10),'')),
    'search',jsonb_build_object('key_id',i.search_key_id,'normalization_version',i.normalization_version,
      'hash',replace(encode(i.search_hash,'base64'),chr(10),''))) order by i.request_id),'[]'::jsonb)
    into identities from orl_private.request_identity i;
  result:=jsonb_set(result,'{requests}',(select coalesce(jsonb_agg(x||jsonb_build_object('ic_protected',
    exists(select 1 from orl_private.request_identity i where i.request_id=(x->>'id')::uuid),
    'creation_tracked',exists(select 1 from orl_private.c1_creation_receipts c where c.request_id=(x->>'id')::uuid))),'[]'::jsonb)
    from jsonb_array_elements(result->'requests') x));
  select coalesce(jsonb_agg(to_jsonb(c) order by c.request_id),'[]'::jsonb) into receipts
    from orl_private.c1_creation_receipts c;
  return result||jsonb_build_object('version',2,'identity_format','ORL_IC_SHADOW_V1','identities',identities,
    'creation_receipt_format','ORL_CREATE_RECEIPTS_V1','creation_receipts',receipts);
end $$;
revoke all on function public.orl_ic_c1_export(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_c1_export(uuid,text) to service_role;

-- Backend must decrypt-and-compare + verify HMACs BEFORE calling this service-only RPC.
-- SQL alone cannot authenticate AES ciphertext; no client-controlled 'verified' flag.
create function public.orl_ic_c1_import(p_session_token uuid,p_password text,p_backup jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype; item jsonb; result jsonb; raw text; mapped_owner uuid;
begin
  u:=public.orl_require_webmaster_password(p_session_token,p_password);
  if not pg_try_advisory_xact_lock(hashtext('orl_db_import')) then raise exception 'Restore already running.'; end if;
  if not pg_try_advisory_xact_lock(hashtextextended('orl_ic_restore_generation',0))
    then raise exception 'Creation still running. Restore not started.'; end if;
  if jsonb_typeof(p_backup) is distinct from 'object' or p_backup->>'format' is distinct from 'ORLOMS_BACKUP'
    or p_backup->'version' is distinct from '2'::jsonb or p_backup->>'identity_format' is distinct from 'ORL_IC_SHADOW_V1'
    or p_backup->>'creation_receipt_format' is distinct from 'ORL_CREATE_RECEIPTS_V1'
    or jsonb_typeof(p_backup->'creation_receipts') is distinct from 'array'
    or jsonb_typeof(p_backup->'requests') is distinct from 'array' or jsonb_typeof(p_backup->'identities') is distinct from 'array'
    or length(p_backup::text)>104857600 then raise exception 'Compatible version-2 backup required.'; end if;
  if exists(select 1 from jsonb_array_elements(p_backup->'requests') x where jsonb_typeof(x) is distinct from 'object'
    or jsonb_typeof(x->'ic_protected') is distinct from 'boolean')
    or exists(select 1 from jsonb_array_elements(p_backup->'identities') x where jsonb_typeof(x) is distinct from 'object'
      or x->>'request_id' is null)
    or exists(select 1 from jsonb_array_elements(p_backup->'identities') x group by x->>'request_id' having count(*)>1)
    or exists(select 1 from jsonb_array_elements(p_backup->'requests') x group by x->>'id' having count(*)>1) then
    raise exception 'Invalid identity manifest.';
  end if;
  if exists(select 1 from jsonb_array_elements(p_backup->'requests') r
       where jsonb_typeof(r->'creation_tracked') is distinct from 'boolean'
       or (r->'creation_tracked'='true'::jsonb) is distinct from exists(
         select 1 from jsonb_array_elements(p_backup->'creation_receipts') c where c->>'request_id'=r->>'id'))
    or exists(select 1 from jsonb_array_elements(p_backup->'creation_receipts') c
       where jsonb_typeof(c) is distinct from 'object'
       or c->>'request_id' is null or c->>'owner_id' is null or c->>'created_at' is null
       or c->>'outcome' is null or c->>'outcome' not in ('CREATED','CANCELLED'))
    or exists(select 1 from jsonb_array_elements(p_backup->'creation_receipts') c
       group by (c->>'request_id')::uuid having count(*)>1)
    or exists(select 1 from jsonb_array_elements(p_backup->'requests') r
       join jsonb_array_elements(p_backup->'creation_receipts') c on c->>'request_id'=r->>'id'
       where c->>'outcome'<>'CREATED' or (r->>'created_by' is not null and r->>'created_by'<>c->>'owner_id'))
    then raise exception 'Invalid creation recovery manifest.'; end if;
  if exists(select 1 from jsonb_array_elements(p_backup->'requests') r
      where (r->'ic_protected'='true'::jsonb) is distinct from exists(
        select 1 from jsonb_array_elements(p_backup->'identities') i where i->>'request_id'=r->>'id'))
    or exists(select 1 from jsonb_array_elements(p_backup->'identities') i
      where not exists(select 1 from jsonb_array_elements(p_backup->'requests') r where r->>'id'=i->>'request_id'
        and coalesce(r->>'patient_ic','')<>'')) then raise exception 'Incomplete identity backup.'; end if;
  lock table public.orl_users,public.orl_sessions,public.orl_settings,public.orl_holidays,public.orl_ot_sessions,
    public.orl_requests,public.orl_ot_slots,public.orl_audit_log,orl_private.request_identity,
    orl_private.c1_creation_receipts in access exclusive mode nowait;
  delete from orl_private.request_identity;
  -- Existing restore validates all operational sections and links. Any failure undoes
  -- identity deletion too. No production Restore is invoked by the local test runner.
  result:=public.orl_db_import_locked(p_session_token,p_password,jsonb_set(p_backup,'{version}','1'::jsonb));
  for item in select * from jsonb_array_elements(p_backup->'identities') loop
    select patient_ic into raw from public.orl_requests where id=(item->>'request_id')::uuid;
    perform orl_private.c1_store_identity((item->>'request_id')::uuid,raw,item->'envelope',item->'search');
  end loop;
  -- Merge, never replace: markers created after an older backup must survive Restore.
  for item in select * from jsonb_array_elements(p_backup->'creation_receipts') loop
    select (select cu.id from public.orl_users cu
      join jsonb_array_elements(p_backup->'users') bu on lower(bu->>'username')=lower(cu.username)
      where bu->>'id'=item->>'owner_id') into mapped_owner;
    mapped_owner:=coalesce(mapped_owner,(item->>'owner_id')::uuid);
    if exists(select 1 from orl_private.c1_creation_receipts c
      where c.request_id=(item->>'request_id')::uuid and c.owner_id<>mapped_owner) then
      raise exception 'Creation recovery owner conflict. No data changed.';
    end if;
    insert into orl_private.c1_creation_receipts(request_id,owner_id,outcome,created_at)
      values((item->>'request_id')::uuid,mapped_owner,item->>'outcome',(item->>'created_at')::timestamptz)
      on conflict(request_id) do nothing;
  end loop;
  -- A restored request can supersede a cancellation marker, but remains fenced by its PK.
  if exists(select 1 from orl_private.c1_creation_receipts c join public.orl_requests r on r.id=c.request_id
    where r.created_by is not null and r.created_by<>c.owner_id) then
    raise exception 'Restored creation owner conflict. No data changed.';
  end if;
  update orl_private.c1_creation_receipts c set outcome='CREATED'
    where exists(select 1 from public.orl_requests r where r.id=c.request_id);
  update orl_private.c1_restore_generation set generation=gen_random_uuid() where singleton;
  return result||jsonb_build_object('identities',jsonb_array_length(p_backup->'identities'),
    'creation_receipts',(select count(*) from orl_private.c1_creation_receipts));
end $$;
revoke all on function public.orl_ic_c1_import(uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_c1_import(uuid,text,jsonb) to service_role;


-- Reviewed release body derived from reads.sql.
create function orl_private.c1_mask_ic(p_raw text)
returns text language sql immutable set search_path='' as $$
 select case when p_raw is null then null when trim(p_raw)='' then ''
   when p_raw ~ '^(\*{6}-\*{2}-[0-9]{4}|\*{4,8}[A-Za-z0-9]{4}|\*{4})$' then p_raw
   when trim(p_raw) ~ '^[0-9]{6}-?[0-9]{2}-?[0-9]{4}$' then '******-**-'||right(trim(p_raw),4)
   when length(regexp_replace(p_raw,'\s','','g'))<=4 then '****'
   else '********'||right(regexp_replace(p_raw,'\s','','g'),4) end
$$;
revoke all on function orl_private.c1_mask_ic(text) from public,anon,authenticated,service_role;

create function orl_private.c1_mask_json(p_value jsonb,p_date date default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; k text; v jsonb; at_date date:=coalesce(p_date,current_date); parts jsonb;
begin
 if jsonb_typeof(p_value)='array' then
   select coalesce(jsonb_agg(orl_private.c1_mask_json(value,at_date) order by ord),'[]'::jsonb) into result
   from jsonb_array_elements(p_value) with ordinality x(value,ord); return result;
 elsif jsonb_typeof(p_value)='object' then
   if nullif(p_value->>'ot_date','') is not null then at_date:=(p_value->>'ot_date')::date; end if;
   result:='{}'::jsonb;
   for k,v in select * from jsonb_each(p_value) loop
     result:=result||jsonb_build_object(k,orl_private.c1_mask_json(v,at_date));
   end loop;
   if p_value ? 'patient_ic' then
     parts:=public.orl_age_parts(p_value->>'patient_ic',at_date);
     result:=result||jsonb_build_object('patient_ic',orl_private.c1_mask_ic(p_value->>'patient_ic'),
       'patient_ic_masked',true,'patient_ic_present',coalesce(p_value->>'patient_ic','')<>'');
     if parts is not null then result:=result||jsonb_build_object('age',parts->'years','age_months',parts->'months','age_source','IC');
     elsif not (result ? 'age_source') then result:=result||jsonb_build_object('age_source','MANUAL'); end if;
   end if;
   if p_value->>'match_type'='PATIENT IC' then
     result:=jsonb_set(result,'{match_value}',to_jsonb(orl_private.c1_mask_ic(p_value->>'match_value')));
   end if;
   -- Schedule slot objects carry request_id. Attach the exact database revision
   -- while still inside the masked server boundary; no plaintext IC is exposed.
   if p_value ? 'request_id' and coalesce(p_value->>'request_id','')<>''
      and (p_value->>'request_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
     result:=result||coalesce((select jsonb_build_object('_ic_edit_version',r.updated_at)
       from public.orl_requests r where r.id=(p_value->>'request_id')::uuid),'{}'::jsonb);
   end if;
   return result;
 end if;
 return p_value;
end $$;
revoke all on function orl_private.c1_mask_json(jsonb,date) from public,anon,authenticated,service_role;

-- Preserve original filters/session checks in private cores. No client can call them.
-- Wrapper replaces the SAME public signature, so old direct RPC URLs also mask.
do $wrap$
declare signature text; oid_ oid; name_ text; def text; args text; names text; types text;
begin
 foreach signature in array array[
   'orl_get_postponed(uuid)','orl_get_deletions(uuid)','orl_find_patient_search(uuid,text)',
   'orl_subspecialty_statistics(uuid,date,date,text,text,text,text,integer)',
   'orl_db_cancelled(uuid)','orl_db_find_patient(uuid,text)','orl_db_duplicates(uuid)',
   'orl_get_requests(uuid)','orl_get_dashboard(uuid)'] loop
   oid_:=to_regprocedure('public.'||signature);
   select proname,pg_get_functiondef(oid),pg_get_function_arguments(oid),
     array_to_string(proargnames,','),oidvectortypes(proargtypes)
     into name_,def,args,names,types from pg_proc where oid=oid_;
   if def is null then raise exception 'Read baseline missing: %',signature; end if;
   execute replace(def,'FUNCTION public.'||name_||'(', 'FUNCTION orl_private.c1_read_'||name_||'(');
   execute format('revoke all on function orl_private.c1_read_%s(%s) from public,anon,authenticated,service_role',name_,types);
   execute format('create or replace function public.%s(%s) returns jsonb language sql security definer set search_path='''' as %L',
     name_,args,'select orl_private.c1_mask_json(orl_private.c1_read_'||name_||'('||names||'),null)');
 end loop;
 -- Schedule is a set of table rows instead of one JSON document.
 def:=pg_get_functiondef('public.orl_get_schedule(uuid,integer,integer)'::regprocedure);
 execute replace(def,'FUNCTION public.orl_get_schedule(', 'FUNCTION orl_private.c1_read_schedule(');
end $wrap$;
revoke all on function orl_private.c1_read_schedule(uuid,integer,integer) from public,anon,authenticated,service_role;
create or replace function public.orl_get_schedule(p_session_token uuid,p_year integer,p_month integer)
returns table(session_id uuid,ot_date date,day_name text,status text,note text,special_title text,holiday_name text,slots jsonb)
language sql security definer set search_path='' as $$
 select s.session_id,s.ot_date,s.day_name,s.status,s.note,s.special_title,s.holiday_name,
   orl_private.c1_mask_json(s.slots,s.ot_date) from orl_private.c1_read_schedule(p_session_token,p_year,p_month) s
$$;

-- Preserve each existing scoped/masked result and add an exact, unrounded
-- cancellation snapshot. A reject/re-request cycle invalidates the old version.
create or replace function public.orl_get_requests(p_session_token uuid)
returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(x.value||jsonb_build_object('assigned_slot_id',r.assigned_slot_id,
   '_ic_delete_version',r.updated_at) order by x.n),'[]'::jsonb)
 from jsonb_array_elements(orl_private.c1_mask_json(orl_private.c1_read_orl_get_requests(p_session_token),null)) with ordinality x(value,n)
 join public.orl_requests r on r.id=(x.value->>'id')::uuid
$$;
create or replace function public.orl_get_deletions(p_session_token uuid)
returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(x.value||jsonb_build_object('assigned_slot_id',r.assigned_slot_id,
   '_ic_delete_version',r.updated_at) order by x.n),'[]'::jsonb)
 from jsonb_array_elements(orl_private.c1_mask_json(orl_private.c1_read_orl_get_deletions(p_session_token),null)) with ordinality x(value,n)
 join public.orl_requests r on r.id=(x.value->>'id')::uuid
$$;

-- The superseded MRN-only API must not bypass modern Staff ownership filtering.
create or replace function public.orl_find_patient(p_session_token uuid,p_mrn text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 return (select coalesce(jsonb_agg(x),'[]'::jsonb) from jsonb_array_elements(
   public.orl_find_patient_search(p_session_token,p_mrn)) x where lower(trim(x->>'mrn'))=lower(trim(p_mrn)));
end $$;


-- Reviewed release body derived from gateway.sql.
create function public.orl_ic_c1_authorize(p_session_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype;
begin
 u:=public.orl_require_session(p_session_token);
 return jsonb_build_object('role',u.role);
end $$;
create function public.orl_ic_c1_check_password(p_session_token uuid,p_password text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 perform public.orl_require_webmaster_password(p_session_token,p_password);
 return true;
end $$;
revoke all on function public.orl_ic_c1_authorize(uuid),public.orl_ic_c1_check_password(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_c1_authorize(uuid),public.orl_ic_c1_check_password(uuid,text) to service_role;


-- Reviewed release body derived from controls.sql.
-- No patient/request clinical fields or keys are selected. Calendar/title free
-- text still needs the separate step-9 exposure review.
create function orl_private.c1_control_snapshot(p_scope text,p_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v jsonb; sid uuid;
begin
 if p_scope='SETTINGS' and p_id is null then
   select coalesce(jsonb_object_agg(setting_key,setting_value),'{}') into v from public.orl_settings;
 elsif p_scope='HOLIDAYS' and p_id is null then
   select jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(h) order by id) from public.orl_holidays h),'[]'),
     'overrides',coalesce((select jsonb_agg(jsonb_build_array(id,ot_date,holiday_override) order by id) from public.orl_ot_sessions),'[]')) into v;
 elsif p_scope in('SESSION','SLOT') and p_id is not null then
   if p_scope='SESSION' then sid:=p_id;
   else select session_id into sid from public.orl_ot_slots where id=p_id; end if;
   select jsonb_build_object('session',to_jsonb(s),'slots',coalesce((select jsonb_agg(to_jsonb(sl) order by sl.id)
     from public.orl_ot_slots sl where sl.session_id=s.id and (p_scope='SESSION' or sl.id=p_id)),'[]'),
     'holiday',coalesce((select to_jsonb(h) from public.orl_holidays h where h.holiday_date=s.ot_date and h.is_active),'null'))
     into v from public.orl_ot_sessions s where s.id=sid;
 else raise exception 'Invalid control scope'; end if;
 if v is null then raise exception 'Control target missing'; end if;
 return v;
end $$;
revoke all on function orl_private.c1_control_snapshot(text,uuid) from public,anon,authenticated,service_role;

create function public.orl_ic_c1_control_view(p_session_token uuid,p_scope text,p_id uuid,p_generation uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype; g uuid; v jsonb;
begin
 u:=public.orl_require_session(p_session_token);
 -- Staff can read the holiday/settings lists already exposed by the application,
 -- but cannot prepare an administrative session or slot action.
 if p_scope in('SESSION','SLOT') and u.role not in('ADMIN','WEBMASTER') then raise exception 'Admin access required'; end if;
 select generation into g from orl_private.c1_restore_generation where singleton;
 if p_scope in('SESSION','SLOT') and p_generation is null then raise exception 'Reload the schedule'; end if;
 perform orl_private.c1_check_generation(coalesce(p_generation,g));
 lock table public.orl_settings,public.orl_holidays,public.orl_ot_sessions,public.orl_ot_slots in share mode nowait;
 v:=orl_private.c1_control_snapshot(p_scope,p_id);
 return jsonb_build_object('generation',g,'revision',md5(v::text),'data',v);
end $$;
revoke all on function public.orl_ic_c1_control_view(uuid,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.orl_ic_c1_control_view(uuid,text,uuid,uuid) to service_role;

create function public.orl_ic_c1_control(p_session_token uuid,p_action text,p_id uuid,p_data jsonb,p_generation uuid,p_revision text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype; scope text; v jsonb; k text; merged jsonb; result jsonb:='null';
begin
 u:=public.orl_require_session(p_session_token);
 if u.role not in('ADMIN','WEBMASTER') then raise exception 'Admin access required'; end if;
 scope:=case when p_action in('SESSION_STATUS','SESSION_TITLE') then 'SESSION' when p_action='SLOT_CLOSED' then 'SLOT'
   when p_action in('HOLIDAY_SAVE','HOLIDAY_DELETE','HOLIDAY_GENERATE','HOLIDAY_CLEAR') then 'HOLIDAYS'
   when p_action='SETTINGS' then 'SETTINGS' else null end;
 if scope is null or jsonb_typeof(p_data) is distinct from 'object' or octet_length(p_data::text)>16384 then raise exception 'Invalid control'; end if;
 perform orl_private.c1_check_generation(p_generation);
 -- NOWAIT refuses contention instead of taking a partial multi-table operation.
 -- Existing booking writers cannot change slots during validation/commit.
 lock table public.orl_settings,public.orl_holidays,public.orl_ot_sessions,public.orl_ot_slots in share row exclusive mode nowait;
 v:=orl_private.c1_control_snapshot(scope,case when scope in('SESSION','SLOT') then p_id else null end);
 if p_revision is null or p_revision is distinct from md5(v::text) then raise exception 'Controls changed. Reload and review again'; end if;
 if p_action='SESSION_STATUS' then
   if p_data- 'status'<>'{}' or coalesce(p_data->>'status','') not in('ACTIVE','CANCELLED') then raise exception 'Invalid status'; end if;
   perform public.orl_set_session(p_session_token,p_id,p_data->>'status',null);
 elsif p_action='SESSION_TITLE' then
   if p_data-'title'<>'{}' or jsonb_typeof(p_data->'title') is distinct from 'string' or length(p_data->>'title')>240 then raise exception 'Invalid title'; end if;
   perform public.orl_set_session(p_session_token,p_id,null,p_data->>'title');
 elsif p_action='SLOT_CLOSED' then
   if p_data-'closed'<>'{}' or jsonb_typeof(p_data->'closed') is distinct from 'boolean' then raise exception 'Invalid slot state'; end if;
   if v#>>'{session,status}'<>'ACTIVE' or (v->'holiday'<>'null' and not (v#>>'{session,holiday_override}')::boolean) then raise exception 'OT date unavailable'; end if;
   result:=to_jsonb(public.orl_set_slot_closed(p_session_token,p_id,(p_data->>'closed')::boolean));
 elsif p_action='HOLIDAY_SAVE' then
   if p_data-array['date','title','description']<>'{}' or jsonb_typeof(p_data->'title') is distinct from 'string'
     or length(trim(p_data->>'title')) not between 1 and 240 or jsonb_typeof(p_data->'description') is distinct from 'string'
     or length(p_data->>'description')>4096 or coalesce(p_data->>'date','')!~'^\d{4}-\d{2}-\d{2}$' then raise exception 'Invalid holiday'; end if;
   if extract(year from (p_data->>'date')::date) not between 2026 and 2100 then raise exception 'Invalid year'; end if;
   if p_id is not null and not exists(select 1 from public.orl_holidays where id=p_id) then raise exception 'Holiday missing'; end if;
   result:=to_jsonb(public.orl_save_holiday(p_session_token,p_id,(p_data->>'date')::date,p_data->>'title',p_data->>'description'));
 elsif p_action='HOLIDAY_DELETE' then
   if p_data<>'{}' or p_id is null or not exists(select 1 from public.orl_holidays where id=p_id) then raise exception 'Holiday missing'; end if;
   perform public.orl_delete_holiday(p_session_token,p_id);
 elsif p_action='HOLIDAY_GENERATE' then
   if p_id is not null or p_data-'year'<>'{}' or coalesce(p_data->>'year','')!~'^\d{4}$'
     or (p_data->>'year')::integer not between 2026 and 2100 then raise exception 'Invalid year'; end if;
   result:=public.orl_generate_public_holidays(p_session_token,(p_data->>'year')::integer);
 elsif p_action='HOLIDAY_CLEAR' then
   if p_id is not null or p_data-'password'<>'{}' or jsonb_typeof(p_data->'password') is distinct from 'string'
     or length(p_data->>'password') not between 1 and 1024 then raise exception 'Password required'; end if;
   -- Existing core requires Webmaster AND verifies password. Never audit it.
   result:=to_jsonb(public.orl_clear_all_holidays(p_session_token,p_data->>'password'));
 elsif p_action='SETTINGS' then
   if p_id is not null or p_data='{}' then raise exception 'Invalid settings'; end if;
   for k in select jsonb_object_keys(p_data) loop
     if k not in('SYSTEM_NAME','START_YEAR','END_YEAR','OT_DAYS','MAIN_SLOTS','SPECIAL_SLOTS')
       or jsonb_typeof(p_data->k) is distinct from 'string' then raise exception 'Invalid setting'; end if;
   end loop;
   merged:=v||p_data;
   if length(trim(merged->>'SYSTEM_NAME')) not between 1 and 200
     or coalesce(merged->>'START_YEAR','')!~'^\d{4}$' or coalesce(merged->>'END_YEAR','')!~'^\d{4}$'
     or (merged->>'START_YEAR')::integer<2026 or (merged->>'END_YEAR')::integer>2100
     or (merged->>'END_YEAR')::integer<(merged->>'START_YEAR')::integer
     or coalesce(merged->>'SPECIAL_SLOTS','')!~'^\d{1,3}$' or (merged->>'SPECIAL_SLOTS')::integer>100
     or coalesce(merged->>'MAIN_SLOTS','')!~'^\d{1,3}$' or (merged->>'MAIN_SLOTS')::integer not between 1 and 100
     or coalesce(merged->>'OT_DAYS','')!~'^[0-6](,[0-6]){0,6}$' then raise exception 'Invalid setting values'; end if;
   perform public.orl_save_settings(p_session_token,p_data);
 end if;
 return jsonb_build_object('result',result,'action',p_action);
end $$;
revoke all on function public.orl_ic_c1_control(uuid,text,uuid,jsonb,uuid,text) from public,anon,authenticated;
grant execute on function public.orl_ic_c1_control(uuid,text,uuid,jsonb,uuid,text) to service_role;

-- Schedule reads can lazily create sessions/slots. They also join the Restore
-- fence; retain 020's existing fixed Main capacity and Sunday/Wednesday rules.
do $$ declare def text; begin
 def:=pg_get_functiondef('public.orl_prepare_schedule(uuid,integer,integer)'::regprocedure);
 execute replace(def,'FUNCTION public.orl_prepare_schedule(', 'FUNCTION orl_private.c1_prepare_schedule(');
end $$;
revoke all on function orl_private.c1_prepare_schedule(uuid,integer,integer) from public,anon,authenticated,service_role;
create or replace function public.orl_prepare_schedule(p_session_token uuid,p_year integer,p_month integer)
returns void language plpgsql security definer set search_path='' as $$
declare g uuid;
begin
 perform public.orl_require_session(p_session_token);
 select generation into g from orl_private.c1_restore_generation where singleton;
 perform orl_private.c1_check_generation(g);
 perform orl_private.c1_prepare_schedule(p_session_token,p_year,p_month);
end $$;


-- Reviewed release body derived from repair-exposure.sql.
-- Exact repair revision: counts alone cannot identify a changed patient/slot set.
create function orl_private.c1_repair_snapshot() returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
   'requests',coalesce((select jsonb_agg(jsonb_build_array(id,status,assigned_slot_id,updated_at) order by id)
     from public.orl_requests),'[]'::jsonb),
   'slots',coalesce((select jsonb_agg(jsonb_build_array(id,session_id,slot_type,slot_number,status,request_id,updated_at) order by id)
     from public.orl_ot_slots),'[]'::jsonb))
$$;
revoke all on function orl_private.c1_repair_snapshot() from public,anon,authenticated,service_role;

create function public.orl_ic_c1_repair_view(p_session_token uuid,p_generation uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype; health jsonb; snapshot jsonb;
begin
 u:=public.orl_require_session(p_session_token);
 if u.role<>'WEBMASTER' then raise exception 'Webmaster access required'; end if;
 perform orl_private.c1_check_generation(p_generation);
 lock table public.orl_requests,public.orl_ot_sessions,public.orl_ot_slots in share mode nowait;
 snapshot:=orl_private.c1_repair_snapshot();
 health:=public.orl_db_health(p_session_token);
 return jsonb_build_object('health',health,'generation',p_generation,'revision',md5(snapshot::text));
end $$;
revoke all on function public.orl_ic_c1_repair_view(uuid,uuid) from public,anon,authenticated;
grant execute on function public.orl_ic_c1_repair_view(uuid,uuid) to service_role;

create function public.orl_ic_c1_repair(p_session_token uuid,p_password text,p_generation uuid,p_revision text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype; result jsonb;
begin
 u:=public.orl_require_webmaster_password(p_session_token,p_password);
 perform orl_private.c1_check_generation(p_generation);
 if p_revision is null or p_revision!~'^[a-f0-9]{32}$' then raise exception 'Reload Database Repair'; end if;
 lock table public.orl_requests,public.orl_ot_sessions,public.orl_ot_slots in share row exclusive mode nowait;
 if p_revision is distinct from md5(orl_private.c1_repair_snapshot()::text) then
   raise exception 'Database state changed. Reload and review Repair again';
 end if;
 result:=public.orl_db_repair(p_session_token,p_password);
 if result->>'status'<>'COMPLETED' then raise exception 'Repair result not confirmed'; end if;
 return result;
end $$;
revoke all on function public.orl_ic_c1_repair(uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.orl_ic_c1_repair(uuid,text,uuid,text) to service_role;

-- Redact exact known IC/passport values and Malaysian IC-shaped text. This is
-- used only on free-text fields; structured patient_ic continues through mask_ic.
create function orl_private.c1_redact_text(p_text text) returns text
language plpgsql stable security definer set search_path='' as $$
declare result text:=p_text; raw text;
begin
 if result is null or result='' then return result; end if;
 for raw in select distinct trim(patient_ic) from public.orl_requests
   where length(trim(coalesce(patient_ic,'')))>3 and position(trim(patient_ic) in result)>0 loop
   result:=replace(result,raw,orl_private.c1_mask_ic(raw));
 end loop;
 return regexp_replace(result,'(^|[^0-9])([0-9]{6})-?([0-9]{2})-?([0-9]{4})([^0-9]|$)',
   E'\\1******-**-\\4\\5','g');
end $$;
revoke all on function orl_private.c1_redact_text(text) from public,anon,authenticated,service_role;

-- Replace the earlier local masker with free-text-aware behavior.
create or replace function orl_private.c1_mask_json(p_value jsonb,p_date date default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; k text; v jsonb; at_date date:=coalesce(p_date,current_date); parts jsonb;
  sensitive constant text[]:=array['remark','reason','details','record_id','review_note','deletion_reason','note','description'];
begin
 if jsonb_typeof(p_value)='array' then
   select coalesce(jsonb_agg(orl_private.c1_mask_json(value,at_date) order by ord),'[]'::jsonb) into result
   from jsonb_array_elements(p_value) with ordinality x(value,ord); return result;
 elsif jsonb_typeof(p_value)='object' then
   if nullif(p_value->>'ot_date','') is not null then at_date:=(p_value->>'ot_date')::date; end if;
   result:='{}'::jsonb;
   for k,v in select * from jsonb_each(p_value) loop
     if k=any(sensitive) and jsonb_typeof(v)='string' then
       result:=result||jsonb_build_object(k,orl_private.c1_redact_text(v#>>'{}'));
     else result:=result||jsonb_build_object(k,orl_private.c1_mask_json(v,at_date)); end if;
   end loop;
   if p_value ? 'patient_ic' then
     parts:=public.orl_age_parts(p_value->>'patient_ic',at_date);
     result:=result||jsonb_build_object('patient_ic',orl_private.c1_mask_ic(p_value->>'patient_ic'),
       'patient_ic_masked',true,'patient_ic_present',coalesce(p_value->>'patient_ic','')<>'');
     if parts is not null then result:=result||jsonb_build_object('age',parts->'years','age_months',parts->'months','age_source','IC');
     elsif not (result ? 'age_source') then result:=result||jsonb_build_object('age_source','MANUAL'); end if;
   end if;
   if p_value->>'match_type'='PATIENT IC' then
     result:=jsonb_set(result,'{match_value}',to_jsonb(orl_private.c1_mask_ic(p_value->>'match_value')));
   end if;
   return result;
 end if;
 return p_value;
end $$;

-- Audit had not been included in the original read-cutover list.
do $$ declare def text; begin
 def:=pg_get_functiondef('public.orl_get_audit(uuid,text)'::regprocedure);
 execute replace(def,'FUNCTION public.orl_get_audit(', 'FUNCTION orl_private.c1_read_orl_get_audit(');
end $$;
revoke all on function orl_private.c1_read_orl_get_audit(uuid,text) from public,anon,authenticated,service_role;
create or replace function public.orl_get_audit(p_session_token uuid,p_search text default '')
returns jsonb language sql security definer set search_path='' as $$
 select orl_private.c1_mask_json(orl_private.c1_read_orl_get_audit(p_session_token,p_search),null)
$$;


-- Reviewed release body derived from ux.sql.
-- Scheduled records already save manual counts atomically through protected Edit.
-- This narrow path exists only for a request that currently has no OT slot.
create function public.orl_ic_c1_unscheduled_count(p_session_token uuid,p_request_id uuid,p_count integer,
  p_expected_version timestamptz,p_generation uuid)
returns integer language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype; r public.orl_requests%rowtype;
begin
 u:=public.orl_require_session(p_session_token);
 if u.role<>'WEBMASTER' then raise exception 'Webmaster access required'; end if;
 if p_count is null or p_count not between 0 and 999 then raise exception 'Invalid postpone count'; end if;
 perform orl_private.c1_check_generation(p_generation);
 select * into r from public.orl_requests where id=p_request_id for update;
 if not found or r.updated_at is distinct from p_expected_version then
   raise exception 'Request changed. Reload before editing the count';
 end if;
 if r.assigned_slot_id is not null then raise exception 'Use scheduled-patient Edit for this count'; end if;
 if r.status in('CANCELLED','COMPLETED') then raise exception 'Closed request count cannot be changed'; end if;
 perform public.orl_set_postpone_count(p_session_token,p_request_id,p_count);
 insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
 values(u.id,u.display_name,u.role,'POSTPONE_COUNT_UPDATED','REQUEST',p_request_id::text,
   'Unscheduled manual count: '||coalesce(r.postpone_count,0)||' to '||p_count);
 return p_count;
end $$;
revoke all on function public.orl_ic_c1_unscheduled_count(uuid,uuid,integer,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.orl_ic_c1_unscheduled_count(uuid,uuid,integer,timestamptz,uuid) to service_role;


-- Reviewed release body derived from legacy-gates.sql.
-- Owners retain execution for SECURITY DEFINER service wrappers. Neither a
-- browser session nor a direct service-role call may bypass the new boundary.
revoke all on function
  public.orl_create_request(uuid,jsonb),
  public.orl_edit_scheduled_request(uuid,uuid,jsonb,text),
  public.orl_edit_scheduled_request_checked(uuid,uuid,jsonb,text,uuid),
  public.orl_move_postponed(uuid,uuid,uuid,jsonb,text),
  public.orl_move_postponed_checked(uuid,uuid,uuid,jsonb,text,uuid),
  public.orl_db_remove_patient(uuid,text,text,text),
  public.orl_delete_request(uuid,uuid),
  public.orl_db_export(uuid,text),
  public.orl_db_import(uuid,text,jsonb),
  public.orl_db_import_locked(uuid,text,jsonb),
  public.orl_set_postpone_count(uuid,uuid,integer),
  public.orl_swap_slots(uuid,uuid,uuid),
  public.orl_swap_slots_checked(uuid,uuid,uuid,uuid,uuid),
  public.orl_confirm_request(uuid,uuid),
  public.orl_assign_slot(uuid,uuid,uuid),
  public.orl_review_request(uuid,uuid,text,text),
  public.orl_clear_slot(uuid,uuid),
  public.orl_clear_slot_checked(uuid,uuid,uuid),
  public.orl_request_deletion(uuid,uuid,text),
  public.orl_resolve_deletion(uuid,uuid,text),
  public.orl_set_session(uuid,uuid,text,text),
  public.orl_set_slot_closed(uuid,uuid,boolean),
  public.orl_save_holiday(uuid,uuid,date,text,text),
  public.orl_delete_holiday(uuid,uuid),
  public.orl_generate_public_holidays(uuid,integer),
  public.orl_clear_all_holidays(uuid,text),
  public.orl_save_settings(uuid,jsonb),
  public.orl_prepare_schedule(uuid,integer,integer)
  ,public.orl_db_repair(uuid,text)
  ,public.orl_postpone_slot(uuid,uuid,text)
  ,public.orl_update_slot_request(uuid,uuid,jsonb)
from public,anon,authenticated,service_role;

-- Fail closed if another overload or inherited privilege was missed. This is
-- deliberately scoped: unrelated operational RPCs are NOT declared protected.
do $verify$
declare fn regprocedure; client text;
begin
  for fn in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=any(array[
      'orl_create_request','orl_edit_scheduled_request','orl_edit_scheduled_request_checked',
      'orl_move_postponed','orl_move_postponed_checked','orl_db_remove_patient',
      'orl_delete_request','orl_db_export','orl_db_import','orl_db_import_locked','orl_set_postpone_count',
      'orl_swap_slots','orl_swap_slots_checked','orl_confirm_request','orl_assign_slot','orl_review_request',
      'orl_clear_slot','orl_clear_slot_checked','orl_request_deletion','orl_resolve_deletion',
      'orl_set_session','orl_set_slot_closed','orl_save_holiday','orl_delete_holiday',
      'orl_generate_public_holidays','orl_clear_all_holidays','orl_save_settings','orl_prepare_schedule','orl_db_repair',
      'orl_postpone_slot','orl_update_slot_request']) loop
    foreach client in array array['anon','authenticated','service_role'] loop
      if has_function_privilege(client,fn,'EXECUTE') then
        raise exception 'Legacy overload or inherited grant remains; review before gating.';
      end if;
    end loop;
  end loop;
end $verify$;


-- Reviewed release body derived from full-dump-recovery.sql.
-- A dump copies this source identity. Restoring it into a different database or
-- cluster therefore leaves the target closed until an offline owner finalizes it.
create table orl_private.c1_database_identity (
  singleton boolean primary key default true check(singleton),
  system_identifier text not null,
  database_oid oid not null,
  database_name name not null,
  recovered_at timestamptz not null default now()
);
insert into orl_private.c1_database_identity(singleton,system_identifier,database_oid,database_name)
select true,(select system_identifier::text from pg_control_system()),d.oid,d.datname
from pg_database d where d.datname=current_database();
alter table orl_private.c1_database_identity enable row level security;
alter table orl_private.c1_database_identity force row level security;
revoke all on orl_private.c1_database_identity from public,anon,authenticated,service_role;

create function orl_private.c1_recovery_ready()
returns boolean language sql stable security definer set search_path='' as $$
  select count(*)=1 and bool_and(i.system_identifier=(select system_identifier::text from pg_control_system())
    and i.database_oid=d.oid and i.database_name=d.datname)
  from orl_private.c1_database_identity i
  cross join pg_database d where i.singleton and d.datname=current_database()
$$;
revoke all on function orl_private.c1_recovery_ready() from public,anon,authenticated,service_role;

-- Preserve the reviewed session core, then put the recovery gate in the common
-- session boundary used by both legacy cores and protected wrappers.
do $wrap$
declare def text;
begin
  def:=pg_get_functiondef('public.orl_require_session(uuid)'::regprocedure);
  if def is null then raise exception 'Session baseline missing.'; end if;
  def:=replace(def,'FUNCTION public.orl_require_session(', 'FUNCTION orl_private.c1_require_session_core(');
  if def not like '%FUNCTION orl_private.c1_require_session_core(%' then raise exception 'Session core adaptation failed.'; end if;
  execute def;
end $wrap$;
revoke all on function orl_private.c1_require_session_core(uuid) from public,anon,authenticated,service_role;
create or replace function public.orl_require_session(p_session_token uuid)
returns public.orl_users language plpgsql security definer set search_path='' as $$
begin
  if not orl_private.c1_recovery_ready() then
    raise exception 'Full-dump recovery is required before access reopens.' using errcode='55000';
  end if;
  return orl_private.c1_require_session_core(p_session_token);
end $$;

-- Do not allow a fresh login to create a usable session before finalization.
create function orl_private.c1_guard_session_write()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if not orl_private.c1_recovery_ready() then
    raise exception 'Full-dump recovery is required before sign-in.' using errcode='55000';
  end if;
  return new;
end $$;
revoke all on function orl_private.c1_guard_session_write() from public,anon,authenticated,service_role;
create trigger orl_c1_recovery_session_guard before insert or update on public.orl_sessions
for each row execute function orl_private.c1_guard_session_write();

-- Offline database-owner procedure. It is intentionally not granted to service_role
-- and is not present in the HTTP/backend allowlists. Same-target recovery needs an
-- additional explicit boolean because a dump restored in place cannot be auto-detected.
create function public.orl_ic_c1_finalize_full_dump_recovery(p_expected_generation uuid,p_confirmation text,p_allow_same_target boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare old_generation uuid; has_generation boolean; invalid_identities bigint; invalid_receipts bigint;
  sessions_removed bigint; identities_count bigint; receipts_count bigint;
begin
  if p_confirmation is distinct from 'ROTATE C1 GENERATION AND INVALIDATE SESSIONS' then
    raise exception 'Exact recovery confirmation required.';
  end if;
  if orl_private.c1_recovery_ready() and p_allow_same_target is distinct from true then
    raise exception 'Target identity is unchanged; same-target recovery was not explicitly allowed.';
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended('orl_ic_restore_generation',0)) then
    raise exception 'Protected work is still running. Recovery not started.';
  end if;
  lock table public.orl_users,public.orl_sessions,public.orl_settings,public.orl_holidays,public.orl_ot_sessions,
    public.orl_requests,public.orl_ot_slots,public.orl_audit_log,orl_private.request_identity,
    orl_private.c1_creation_receipts,orl_private.c1_restore_generation,
    orl_private.c1_database_identity in access exclusive mode nowait;
  select generation into old_generation from orl_private.c1_restore_generation where singleton;
  has_generation:=found;
  if has_generation and p_expected_generation is distinct from old_generation then
    raise exception 'Restored generation does not match the reviewed dump.';
  elsif not has_generation and p_expected_generation is not null then
    raise exception 'Generation is missing; review the dump and confirm the missing value explicitly.';
  end if;
  select count(*) into invalid_identities from orl_private.request_identity i
    left join public.orl_requests r on r.id=i.request_id
    where r.id is null or coalesce(r.patient_ic,'')='';
  select count(*) into invalid_receipts from orl_private.c1_creation_receipts c
    left join public.orl_users u on u.id=c.owner_id
    left join public.orl_requests r on r.id=c.request_id
    where u.id is null or (r.id is not null and (c.outcome<>'CREATED' or r.created_by is distinct from c.owner_id));
  if invalid_identities<>0 or invalid_receipts<>0 then
    raise exception 'Recovered private references are inconsistent. No recovery changes were made.';
  end if;
  delete from public.orl_sessions;
  get diagnostics sessions_removed=row_count;
  insert into orl_private.c1_restore_generation(singleton,generation) values(true,gen_random_uuid())
    on conflict(singleton) do update set generation=excluded.generation;
  insert into orl_private.c1_database_identity(singleton,system_identifier,database_oid,database_name,recovered_at)
    select true,(select system_identifier::text from pg_control_system()),d.oid,d.datname,clock_timestamp()
    from pg_database d where d.datname=current_database()
    on conflict(singleton) do update set system_identifier=excluded.system_identifier,
      database_oid=excluded.database_oid,database_name=excluded.database_name,recovered_at=excluded.recovered_at;
  select count(*) into identities_count from orl_private.request_identity;
  select count(*) into receipts_count from orl_private.c1_creation_receipts;
  return jsonb_build_object('status','READY','sessions_invalidated',sessions_removed,
    'identities',identities_count,'creation_receipts',receipts_count,
    'generation_rotated',true,'previous_generation_present',has_generation);
end $$;
revoke all on function public.orl_ic_c1_finalize_full_dump_recovery(uuid,text,boolean) from public,anon,authenticated,service_role;

-- Shared PostgreSQL rate store. This is intentionally not isolate-local.
create table orl_private.c1_rate_windows(
  session_hash bytea not null,
  window_started_at timestamptz not null,
  request_count smallint not null check(request_count between 1 and 30),
  primary key(session_hash,window_started_at)
);
alter table orl_private.c1_rate_windows enable row level security;
alter table orl_private.c1_rate_windows force row level security;
revoke all on orl_private.c1_rate_windows from public,anon,authenticated,service_role;

create function public.orl_ic_c1_rate_limit(p_session_token uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare token_hash bytea; bucket timestamptz; accepted boolean;
begin
  perform public.orl_require_session(p_session_token);
  token_hash:=extensions.digest(p_session_token::text,'sha256');
  bucket:=date_trunc('minute',clock_timestamp());
  delete from orl_private.c1_rate_windows where session_hash=token_hash and window_started_at<bucket;
  insert into orl_private.c1_rate_windows(session_hash,window_started_at,request_count)
  values(token_hash,bucket,1)
  on conflict(session_hash,window_started_at) do update
    set request_count=orl_private.c1_rate_windows.request_count+1
    where orl_private.c1_rate_windows.request_count<30
  returning true into accepted;
  return coalesce(accepted,false);
end $$;
revoke all on function public.orl_ic_c1_rate_limit(uuid) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_c1_rate_limit(uuid) to service_role;

comment on table orl_private.c1_rate_windows is 'Shared C1 Edge rate decisions; SHA-256 session references only, fixed 30 requests per minute.';
comment on table orl_private.c1_database_identity is 'Full-dump recovery fence. A restored target remains closed until the offline owner finalizer rotates generation and invalidates sessions.';
notify pgrst,'reload schema';
commit;
