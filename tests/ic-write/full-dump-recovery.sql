-- LOCAL full-dump recovery candidate only. Not migration 046.
begin;
do $$ begin
  if session_user<>'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet
    or to_regprocedure('public.orl_ic_c1_import(uuid,text,jsonb)') is null then
    raise exception 'Local C1 runner required.';
  end if;
end $$;

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
  if session_user<>'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet then
    raise exception 'C1 local testing only.' using errcode='42501';
  end if;
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
commit;
