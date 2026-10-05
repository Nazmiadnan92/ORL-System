-- Package C3: purpose-bound, password-verified, one-record IC Reveal.
-- No plaintext IC is stored here and the legacy plaintext column is retained for C6.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $$
begin
  if to_regprocedure('public.orl_ic_c2_finalize(uuid,text,uuid,uuid)') is null
     or to_regclass('orl_private.request_identity') is null
     or not orl_private.c1_recovery_ready() then
    raise exception 'STOP: completed C1/C2 foundation and recovery readiness are required';
  end if;
  if to_regclass('orl_private.c3_reveal_lease') is not null
     or to_regprocedure('public.orl_ic_c3_reveal_view(uuid,text,uuid,text,uuid)') is not null then
    raise exception 'STOP: migration 049 already exists or conflicts';
  end if;
end $$;

create table orl_private.c3_reveal_lease(
  lease_id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.orl_users(id) on delete restrict,
  request_id uuid not null references public.orl_requests(id) on delete restrict,
  purpose text not null check(purpose in('CLINICAL_VERIFICATION','PATIENT_IDENTIFICATION','DATA_CORRECTION')),
  generation uuid not null,
  identity_updated_at timestamptz not null,
  requested_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default clock_timestamp()+interval '2 minutes',
  committed_at timestamptz,
  display_expires_at timestamptz,
  check(expires_at>requested_at),
  check((committed_at is null and display_expires_at is null) or
        (committed_at is not null and display_expires_at is not null and display_expires_at>committed_at))
);
create index c3_reveal_lease_owner_idx on orl_private.c3_reveal_lease(owner_id,requested_at desc);
alter table orl_private.c3_reveal_lease enable row level security;
alter table orl_private.c3_reveal_lease force row level security;
revoke all on orl_private.c3_reveal_lease from public,anon,authenticated,service_role;

create function orl_private.c3_require_password(p_session_token uuid,p_password text)
returns public.orl_users language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype;
begin
  u:=public.orl_require_session(p_session_token);
  if u.role not in('ADMIN','WEBMASTER') then
    raise exception 'Admin or Webmaster access required' using errcode='42501';
  end if;
  if p_password is null or p_password='' or length(p_password)>1024
     or u.password_hash is distinct from extensions.crypt(p_password,u.password_hash) then
    raise exception 'Password verification failed' using errcode='42501';
  end if;
  return u;
end $$;
revoke all on function orl_private.c3_require_password(uuid,text) from public,anon,authenticated,service_role;

create function public.orl_ic_c3_reveal_view(
  p_session_token uuid,p_password text,p_request_id uuid,p_purpose text,p_generation uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype;i orl_private.request_identity%rowtype;lease uuid;lease_exp timestamptz;
begin
  u:=orl_private.c3_require_password(p_session_token,p_password);
  perform orl_private.c1_check_generation(p_generation);
  if p_request_id is null or p_purpose not in('CLINICAL_VERIFICATION','PATIENT_IDENTIFICATION','DATA_CORRECTION') then
    raise exception 'Invalid reveal request';
  end if;
  select * into i from orl_private.request_identity where request_id=p_request_id for share;
  if not found then raise exception 'Protected identity is not available'; end if;
  delete from orl_private.c3_reveal_lease where committed_at is null and expires_at<clock_timestamp()-interval '1 day';
  insert into orl_private.c3_reveal_lease(owner_id,request_id,purpose,generation,identity_updated_at)
    values(u.id,p_request_id,p_purpose,p_generation,i.updated_at)
    returning lease_id,expires_at into lease,lease_exp;
  return jsonb_build_object('lease_id',lease,'request_id',p_request_id,'generation',p_generation,
    'lease_expires_at',lease_exp,'identity_updated_at',i.updated_at,
    'envelope',jsonb_build_object('version',i.envelope_version,'key_id',i.encryption_key_id,
      'nonce',replace(encode(i.nonce,'base64'),chr(10),''),'ciphertext',replace(encode(i.ciphertext,'base64'),chr(10),'')),
    'search',jsonb_build_object('key_id',i.search_key_id,'normalization_version',i.normalization_version,
      'hash',replace(encode(i.search_hash,'base64'),chr(10),'')));
end $$;
revoke all on function public.orl_ic_c3_reveal_view(uuid,text,uuid,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_c3_reveal_view(uuid,text,uuid,text,uuid) to service_role;

create function public.orl_ic_c3_reveal_commit(
  p_session_token uuid,p_password text,p_lease_id uuid,p_request_id uuid,p_generation uuid,p_identity_updated_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype;l orl_private.c3_reveal_lease%rowtype;i_updated timestamptz;display_until timestamptz;
begin
  u:=orl_private.c3_require_password(p_session_token,p_password);
  perform orl_private.c1_check_generation(p_generation);
  select * into l from orl_private.c3_reveal_lease where lease_id=p_lease_id for update;
  if not found or l.owner_id<>u.id or l.request_id<>p_request_id or l.generation<>p_generation
     or l.identity_updated_at is distinct from p_identity_updated_at or l.committed_at is not null
     or l.expires_at<=clock_timestamp() then raise exception 'Reveal authorization expired or changed'; end if;
  select updated_at into i_updated from orl_private.request_identity where request_id=p_request_id for share;
  if not found or i_updated is distinct from l.identity_updated_at then raise exception 'Protected identity changed'; end if;
  display_until:=clock_timestamp()+interval '60 seconds';
  update orl_private.c3_reveal_lease set committed_at=clock_timestamp(),display_expires_at=display_until where lease_id=p_lease_id;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
    values(u.id,u.display_name,u.role,'IC_FULL_REVEAL','REQUEST',p_request_id::text,
      'Authorized full IC access. Purpose: '||l.purpose||'. Display expiry: 60 seconds.');
  return jsonb_build_object('lease_id',p_lease_id,'request_id',p_request_id,'generation',p_generation,
    'purpose',l.purpose,'expires_at',display_until);
end $$;
revoke all on function public.orl_ic_c3_reveal_commit(uuid,text,uuid,uuid,uuid,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_c3_reveal_commit(uuid,text,uuid,uuid,uuid,timestamptz) to service_role;

notify pgrst,'reload schema';
commit;
