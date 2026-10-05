-- Admin/Webmaster-only OT export. No patient values or encryption keys are changed.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
do $$ begin
  if orl_private.c1_recovery_ready() is distinct from true
    or not exists(select 1 from orl_private.c6_cutover_receipt where singleton)
    or (orl_private.c6_stats()->>'plaintext_rows')::int is distinct from 0
    or (orl_private.c6_stats()->>'identity_mismatch')::int is distinct from 0 then
    raise exception 'Completed encrypted-only rollout required';
  end if;
  if to_regclass('orl_private.ot_export_lease') is not null then
    raise exception '053 already installed; inspect before retrying';
  end if;
end $$;

-- Intentionally no FK to mutable application records: expired leases must not
-- block an authorized restore/removal. Generation and owner are checked on use.
create table orl_private.ot_export_lease(
  lease_id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  session_hash text not null,
  ot_session_id uuid not null,
  generation uuid not null,
  revision text not null,
  expires_at timestamptz not null default clock_timestamp()+interval '2 minutes',
  committed_at timestamptz
);
alter table orl_private.ot_export_lease enable row level security;
alter table orl_private.ot_export_lease force row level security;
revoke all on orl_private.ot_export_lease from public,anon,authenticated,service_role;

create function orl_private.ot_export_snapshot(p_ot_session_id uuid)
returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('session',jsonb_build_object('session_id',s.id,'ot_date',s.ot_date),
    'patients',coalesce((
      select jsonb_agg(jsonb_build_object(
        'request_id',r.id,'slot_id',sl.id,'slot_type',sl.slot_type,'slot_number',sl.slot_number,
        'request_updated_at',r.updated_at,'identity_updated_at',i.updated_at,
        'patient_name',r.patient_name,'patient_ic',coalesce(r.patient_ic,''),'mrn',r.mrn,
        'age',r.age,'age_months',r.age_months,'diagnosis',r.diagnosis,'surgery',r.surgery,'sub_specialty',r.sub_specialty,
        'envelope',case when i.request_id is null then null else jsonb_build_object(
          'version',i.envelope_version,'key_id',i.encryption_key_id,
          'nonce',replace(encode(i.nonce,'base64'),chr(10),''),
          'ciphertext',replace(encode(i.ciphertext,'base64'),chr(10),'')) end,
        'search',case when i.request_id is null then null else jsonb_build_object(
          'key_id',i.search_key_id,'normalization_version',i.normalization_version,
          'hash',replace(encode(i.search_hash,'base64'),chr(10),'')) end
      ) order by case when sl.slot_type='MAIN' then 0 else 1 end,sl.slot_number,sl.id)
      from public.orl_ot_slots sl join public.orl_requests r on r.id=sl.request_id
      left join orl_private.request_identity i on i.request_id=r.id
      where sl.session_id=s.id and sl.status not in('AVAILABLE','CLOSED')
        and r.status<>'CANCELLED' and coalesce(r.patient_name,'')<>''
    ),'[]'::jsonb)) from public.orl_ot_sessions s where s.id=p_ot_session_id
$$;
revoke all on function orl_private.ot_export_snapshot(uuid) from public,anon,authenticated,service_role;

create function public.orl_ic_ot_export_view(p_session_token uuid,p_password text,p_ot_session_id uuid,p_generation uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype; snapshot jsonb; revision text; lease uuid; expiry timestamptz;
begin
  u:=orl_private.c3_require_password(p_session_token,p_password);
  perform orl_private.c1_check_generation(p_generation);
  lock table public.orl_ot_sessions,public.orl_ot_slots,public.orl_requests,orl_private.request_identity in share mode nowait;
  snapshot:=orl_private.ot_export_snapshot(p_ot_session_id);
  if snapshot is null or jsonb_array_length(snapshot->'patients') not between 1 and 200 then
    raise exception 'No eligible OT patients or export too large';
  end if;
  if exists(select 1 from jsonb_array_elements(snapshot->'patients') p
    where ((p->>'patient_ic')<>'') is distinct from (p->'envelope'<>'null'::jsonb)) then
    raise exception 'Protected identity coverage inconsistent';
  end if;
  revision:=encode(extensions.digest(snapshot::text,'sha256'),'hex');
  delete from orl_private.ot_export_lease where expires_at<clock_timestamp()-interval '1 day';
  insert into orl_private.ot_export_lease(owner_id,session_hash,ot_session_id,generation,revision)
    values(u.id,encode(extensions.digest(p_session_token::text,'sha256'),'hex'),p_ot_session_id,p_generation,revision)
    returning lease_id,expires_at into lease,expiry;
  return jsonb_build_object('lease_id',lease,'generation',p_generation,'expires_at',expiry,'snapshot',snapshot);
end $$;
revoke all on function public.orl_ic_ot_export_view(uuid,text,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_ot_export_view(uuid,text,uuid,uuid) to service_role;

create function public.orl_ic_ot_export_commit(p_session_token uuid,p_password text,p_lease_id uuid,p_ot_session_id uuid,p_generation uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype; l orl_private.ot_export_lease%rowtype; snapshot jsonb; n integer;
begin
  u:=orl_private.c3_require_password(p_session_token,p_password);
  perform orl_private.c1_check_generation(p_generation);
  select * into l from orl_private.ot_export_lease where lease_id=p_lease_id for update;
  if not found or l.owner_id<>u.id or l.session_hash<>encode(extensions.digest(p_session_token::text,'sha256'),'hex')
    or l.ot_session_id<>p_ot_session_id or l.generation<>p_generation
    or l.committed_at is not null or l.expires_at<=clock_timestamp() then
    raise exception 'Export authorization expired or changed';
  end if;
  lock table public.orl_ot_sessions,public.orl_ot_slots,public.orl_requests,orl_private.request_identity in share mode nowait;
  snapshot:=orl_private.ot_export_snapshot(p_ot_session_id);
  if snapshot is null or encode(extensions.digest(snapshot::text,'sha256'),'hex') is distinct from l.revision then
    raise exception 'OT list changed; reopen and review';
  end if;
  n:=jsonb_array_length(snapshot->'patients');
  update orl_private.ot_export_lease set committed_at=clock_timestamp() where lease_id=p_lease_id;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
    values(u.id,u.display_name,u.role,'OT_LIST_FULL_IC_GENERATED','OT_SESSION',p_ot_session_id::text,
      'Authorized Excel OT list with full IC. OT date: '||(snapshot->'session'->>'ot_date')||
      '. Patient count: '||n||'. Purpose: OT list preparation. Export reference: '||p_lease_id||
      '. Access released; physical printing/download completion is not tracked.');
  return jsonb_build_object('lease_id',p_lease_id,'generation',p_generation,'session_id',p_ot_session_id,
    'patient_count',n,'expires_at',clock_timestamp()+interval '60 seconds');
end $$;
revoke all on function public.orl_ic_ot_export_commit(uuid,text,uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_ot_export_commit(uuid,text,uuid,uuid,uuid) to service_role;
notify pgrst,'reload schema';
commit;
