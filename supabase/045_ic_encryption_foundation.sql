-- Package B ONLY: empty private storage and Webmaster readiness check.
-- No patient encryption, backfill, plaintext removal, or changes to existing RPCs.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $guard$
begin
  if to_regnamespace('orl_private') is not null
     or to_regprocedure('public.orl_ic_foundation_probe(uuid)') is not null then
    raise exception 'STOP: IC foundation already exists or conflicts. No changes applied.';
  end if;
  if not exists (select 1 from information_schema.columns
    where table_schema='public' and table_name='orl_users' and column_name='must_change_password')
    or to_regprocedure('public.orl_complete_required_password_change(uuid,text)') is null
    or position('must_change_password' in coalesce((select prosrc from pg_proc
      where oid=to_regprocedure('public.orl_require_session(uuid)')),''))=0 then
    raise exception 'STOP: migration 044 session protection is required. No changes applied.';
  end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then
    raise exception 'STOP: backend service role is missing. No changes applied.';
  end if;
end;
$guard$;

-- Keep this schema OUT of Supabase exposed schemas. Do not add secrets to SQL.
create schema orl_private;
revoke all on schema orl_private from public, anon, authenticated, service_role;
alter default privileges in schema orl_private revoke all on tables from public, anon, authenticated, service_role;
alter default privileges in schema orl_private revoke execute on functions from public, anon, authenticated, service_role;

create table orl_private.request_identity (
  request_id uuid primary key references public.orl_requests(id) on delete restrict,
  envelope_version smallint not null check (envelope_version = 1),
  encryption_key_id text not null check (encryption_key_id ~ '^[a-z0-9-]{1,40}$'),
  nonce bytea not null check (octet_length(nonce) = 12),
  ciphertext bytea not null check (octet_length(ciphertext) between 17 and 144),
  search_key_id text not null check (search_key_id ~ '^[a-z0-9-]{1,40}$'),
  search_hash bytea not null check (octet_length(search_hash) = 32),
  normalization_version smallint not null check (normalization_version = 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (encryption_key_id, nonce)
);
-- Multiple requests may legitimately belong to one patient: NOT a unique index.
create index request_identity_search_idx
  on orl_private.request_identity(search_key_id, normalization_version, search_hash);
alter table orl_private.request_identity enable row level security;
alter table orl_private.request_identity force row level security;
revoke all on orl_private.request_identity from public, anon, authenticated, service_role;
comment on table orl_private.request_identity is
  'Package B empty foundation. Patient writes and backup/restore integration require Package C. No encryption keys stored here.';

-- Only the backend may invoke this; a valid unrestricted Webmaster session is
-- still required. Never return the orl_users row (it contains password_hash).
create function public.orl_ic_foundation_probe(p_session_token uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u public.orl_users%rowtype;
begin
  u := public.orl_require_session(p_session_token);
  if u.role is distinct from 'WEBMASTER' then
    raise exception 'Webmaster access required.' using errcode='42501';
  end if;
  return jsonb_build_object('phase','B','schema_version',1,'patient_encryption_active',false);
end;
$$;
revoke all on function public.orl_ic_foundation_probe(uuid) from public, anon, authenticated, service_role;
grant execute on function public.orl_ic_foundation_probe(uuid) to service_role;
notify pgrst, 'reload schema';
commit;
