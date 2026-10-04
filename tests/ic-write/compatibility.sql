-- LOCAL candidate only, NOT a production migration. Applied AFTER candidate.sql.
begin;
do $$ begin
  if session_user <> 'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet
    or to_regprocedure('public.orl_ic_c1_create(uuid,uuid,jsonb,jsonb,jsonb,uuid)') is null then
    raise exception 'Local C1 runner required.';
  end if;
end $$;

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
  if session_user <> 'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet then
    raise exception 'C1 local testing only.' using errcode='42501';
  end if;
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
  if session_user<>'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet then
    raise exception 'C1 local testing only.';
  end if;
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
  if session_user<>'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet then
    raise exception 'C1 local testing only.';
  end if;
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
  if session_user<>'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet then
    raise exception 'C1 local testing only.';
  end if;
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
  if session_user<>'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet then
    raise exception 'C1 local testing only.';
  end if;
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
  if session_user<>'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet then
    raise exception 'C1 local testing only.';
  end if;
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
  if session_user<>'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet then
    raise exception 'C1 local testing only.';
  end if;
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
  if session_user <> 'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet then raise exception 'C1 local testing only.'; end if;
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
  if session_user <> 'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet then raise exception 'C1 local testing only.'; end if;
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
  if session_user <> 'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet then raise exception 'C1 local testing only.'; end if;
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
commit;
