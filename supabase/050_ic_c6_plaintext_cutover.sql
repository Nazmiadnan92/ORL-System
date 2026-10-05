-- Package C6: remove full patient identity plaintext from operational storage.
-- The public patient_ic column retains only the approved display mask. Full values
-- remain solely in authenticated encrypted envelopes in orl_private.request_identity.
begin;
set local lock_timeout='5s';
set local statement_timeout='120s';

do $$
begin
  if to_regprocedure('public.orl_ic_c3_reveal_commit(uuid,text,uuid,uuid,uuid,timestamptz)') is null
     or to_regprocedure('public.orl_ic_c2_finalize(uuid,text,uuid,uuid)') is null
     or not orl_private.c1_recovery_ready() then
    raise exception 'STOP: completed C1-C4 foundation and recovery readiness are required';
  end if;
  if to_regclass('orl_private.c6_cutover_receipt') is not null
     or to_regprocedure('public.orl_ic_c6_cutover(uuid,text,uuid,uuid)') is not null then
    raise exception 'STOP: migration 050 already exists or conflicts';
  end if;
end $$;

create table orl_private.c6_cutover_receipt(
  singleton boolean primary key default true check(singleton),
  generation uuid not null,
  verification_run_id uuid not null references orl_private.c2_verification_runs(run_id) on delete restrict,
  protected_count integer not null check(protected_count>=0),
  blank_count integer not null check(blank_count>=0),
  completed_at timestamptz not null default clock_timestamp()
);
alter table orl_private.c6_cutover_receipt enable row level security;
alter table orl_private.c6_cutover_receipt force row level security;
revoke all on orl_private.c6_cutover_receipt from public,anon,authenticated,service_role;

create function orl_private.c6_stats() returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'total_requests',count(*),
    'protected_rows',count(*) filter(where i.request_id is not null),
    'blank_rows',count(*) filter(where trim(coalesce(r.patient_ic,''))=''),
    'plaintext_rows',count(*) filter(where trim(coalesce(r.patient_ic,''))<>''
      and r.patient_ic is distinct from orl_private.c1_mask_ic(r.patient_ic)),
    'masked_rows',count(*) filter(where trim(coalesce(r.patient_ic,''))<>''
      and r.patient_ic is not distinct from orl_private.c1_mask_ic(r.patient_ic)),
    'identity_mismatch',count(*) filter(where
      (trim(coalesce(r.patient_ic,''))='' and i.request_id is not null)
      or (trim(coalesce(r.patient_ic,''))<>'' and i.request_id is null)),
    'cutover_complete',exists(select 1 from orl_private.c6_cutover_receipt where singleton)
  ) from public.orl_requests r left join orl_private.request_identity i on i.request_id=r.id
$$;
revoke all on function orl_private.c6_stats() from public,anon,authenticated,service_role;

create function orl_private.c6_redact_json(p_value jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;k text;v jsonb;
begin
  if p_value is null then return null; end if;
  if jsonb_typeof(p_value)='array' then
    select coalesce(jsonb_agg(orl_private.c6_redact_json(value) order by ord),'[]'::jsonb) into result
      from jsonb_array_elements(p_value) with ordinality x(value,ord);return result;
  elsif jsonb_typeof(p_value)='object' then
    result:='{}'::jsonb;for k,v in select * from jsonb_each(p_value) loop
      result:=result||jsonb_build_object(k,orl_private.c6_redact_json(v));end loop;return result;
  elsif jsonb_typeof(p_value)='string' then return to_jsonb(orl_private.c1_redact_text(p_value#>>'{}'));
  end if;
  return p_value;
end $$;
revoke all on function orl_private.c6_redact_json(jsonb) from public,anon,authenticated,service_role;

create function public.orl_ic_c6_status(p_session_token uuid,p_password text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype;
begin
  u:=public.orl_require_webmaster_password(p_session_token,p_password);
  return orl_private.c6_stats()||jsonb_build_object(
    'generation',(select generation from orl_private.c1_restore_generation where singleton),
    'revision',orl_private.c2_revision(),
    'last_verified_run',(select run_id from orl_private.c2_verification_runs
      where completed_at is not null order by completed_at desc limit 1));
end $$;
revoke all on function public.orl_ic_c6_status(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_c6_status(uuid,text) to service_role;

-- Exact-IC search now uses only the keyed search hash. MRN/name behavior is retained.
create function public.orl_ic_c6_find_patient(p_session_token uuid,p_search text,p_search_key_id text,p_search_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype;q text:=trim(coalesce(p_search,''));h bytea;
begin
  u:=public.orl_require_session(p_session_token);
  if length(q)<2 or length(q)>128 or p_search_key_id!~'^[a-z0-9-]{1,40}$'
     or p_search_hash!~'^[A-Za-z0-9+/]+={0,2}$' then raise exception 'Invalid patient search'; end if;
  h:=decode(p_search_hash,'base64');
  if octet_length(h)<>32 then raise exception 'Invalid patient search'; end if;
  return orl_private.c1_mask_json(coalesce((
    with matches as(
      select r.*,s.ot_date,sl.slot_type,sl.slot_number,
        case when lower(trim(r.mrn))=lower(q) then 0
             when i.search_key_id=p_search_key_id and i.normalization_version=1 and i.search_hash=h then 1
             when lower(trim(r.patient_name))=lower(q) then 2
             when lower(r.patient_name) like lower(q)||'%' then 3 else 4 end match_rank
      from public.orl_requests r
      left join orl_private.request_identity i on i.request_id=r.id
      left join public.orl_ot_slots sl on sl.id=r.assigned_slot_id
      left join public.orl_ot_sessions s on s.id=sl.session_id
      where (u.role in('ADMIN','WEBMASTER') or r.created_by=u.id) and(
        lower(trim(r.mrn))=lower(q)
        or (i.search_key_id=p_search_key_id and i.normalization_version=1 and i.search_hash=h)
        or (length(q)>=3 and lower(r.patient_name) like '%'||lower(q)||'%'))
      order by match_rank,r.updated_at desc limit 100)
    select jsonb_agg(jsonb_build_object(
      'id',m.id,'request_number',m.request_number,'booked_by_name',m.booked_by_name,
      'patient_name',m.patient_name,'patient_ic',m.patient_ic,'age',m.age,'age_months',m.age_months,
      'mrn',m.mrn,'surgery',m.surgery,'diagnosis',m.diagnosis,'doctor',initcap(m.doctor),
      'specialist',initcap(m.specialist),'sub_specialty',m.sub_specialty,'phone',m.phone,'remark',m.remark,
      'status',m.status,'postpone_count',m.postpone_count,'created_at',m.created_at,'ot_date',m.ot_date,
      'slot_type',m.slot_type,'slot_number',m.slot_number) order by m.match_rank,m.updated_at desc) from matches m
  ),'[]'::jsonb),null);
end $$;
revoke all on function public.orl_ic_c6_find_patient(uuid,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_c6_find_patient(uuid,text,text,text) to service_role;

-- New writes use raw identity only inside this transaction to calculate age and
-- validate crypto. The operational row receives the display mask before commit.
create or replace function public.orl_ic_c1_create(p_session_token uuid,p_request_id uuid,p_data jsonb,p_envelope jsonb,p_search jsonb,p_generation uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype;raw text;display text;parts jsonb;result uuid;
begin
  u:=public.orl_require_session(p_session_token);
  if p_request_id is null or jsonb_typeof(p_data) is distinct from 'object' then raise exception 'Invalid input.'; end if;
  perform pg_advisory_xact_lock_shared(hashtextextended('orl_ic_restore_generation',0));
  if p_generation is distinct from(select generation from orl_private.c1_restore_generation where singleton)
    then raise exception 'Restore changed the save generation. Resolve the previous attempt.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('orl_ic_create:'||p_request_id::text,0));
  insert into orl_private.c1_creation_receipts(request_id,owner_id,outcome) values(p_request_id,u.id,'CREATED');
  raw:=trim(coalesce(p_data->>'patient_ic',''));
  if raw='' then
    if p_envelope is not null or p_search is not null then raise exception 'Unexpected identity.'; end if;
    display:='';
  else
    if length(raw)>128 or raw~'[^ -~]' or raw!~'[A-Za-z0-9]'
       or jsonb_typeof(p_envelope) is distinct from 'object' or jsonb_typeof(p_search) is distinct from 'object'
       or p_envelope->'version' is distinct from '1'::jsonb or p_search->'normalization_version' is distinct from '1'::jsonb
      then raise exception 'Invalid identity envelope.'; end if;
    display:=orl_private.c1_mask_ic(raw);parts:=public.orl_age_parts(raw,current_date);
    if parts is not null then p_data:=p_data||jsonb_build_object('age',parts->>'years','age_months',parts->>'months'); end if;
  end if;
  p_data:=jsonb_set(p_data,'{patient_ic}',to_jsonb(display));
  result:=orl_private.c1_create_core(p_session_token,p_request_id,p_data);
  if raw<>'' then perform orl_private.c1_store_identity(result,raw,p_envelope,p_search); end if;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
    values(u.id,u.display_name,u.role,'IC_ENCRYPTED_CREATED','REQUEST',result::text,
      case when raw='' then 'Optional IC absent' else 'Encrypted identity saved; operational value masked' end);
  return result;
end $$;
revoke all on function public.orl_ic_c1_create(uuid,uuid,jsonb,jsonb,jsonb,uuid) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_c1_create(uuid,uuid,jsonb,jsonb,jsonb,uuid) to service_role;

create or replace function public.orl_ic_c1_mutate(p_session_token uuid,p_operation text,p_from_slot uuid,p_to_slot uuid,
  p_expected_request uuid,p_data jsonb,p_action text,p_reason text,p_ic_mode text,p_envelope jsonb,p_search jsonb,
  p_generation uuid,p_expected_version timestamptz)
returns text language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype;r public.orl_requests%rowtype;result text;raw text;display text;parts jsonb;at_date date;
begin
  u:=public.orl_require_session(p_session_token);perform orl_private.c1_check_generation(p_generation);
  if p_operation not in('EDIT','MOVE') or p_ic_mode not in('KEEP','SET') or jsonb_typeof(p_data) is distinct from 'object'
    then raise exception 'Invalid operation.'; end if;
  if p_data?'postpone_count' and (u.role<>'WEBMASTER' or p_operation<>'EDIT'
    or jsonb_typeof(p_data->'postpone_count') is distinct from 'string' or (p_data->>'postpone_count')!~'^[0-9]{1,3}$')
    then raise exception 'Manual postpone count must be 0-999 and saved through Edit.'; end if;
  if p_ic_mode='KEEP' then
    if p_data?'patient_ic' or p_envelope is not null or p_search is not null then raise exception 'KEEP cannot replace IC.'; end if;
  else
    if u.role not in('ADMIN','WEBMASTER') then raise exception 'IC changes require Admin or Webmaster.' using errcode='42501'; end if;
    if jsonb_typeof(p_data->'patient_ic') is distinct from 'string' then raise exception 'Explicit IC required.'; end if;
    raw:=trim(p_data->>'patient_ic');display:=orl_private.c1_mask_ic(raw);
    select s.ot_date into at_date from public.orl_ot_slots sl join public.orl_ot_sessions s on s.id=sl.session_id
      where sl.id=case when p_operation='MOVE' then p_to_slot else p_from_slot end;
    parts:=public.orl_age_parts(raw,coalesce(at_date,current_date));
    if parts is not null then p_data:=p_data||jsonb_build_object('age',parts->>'years','age_months',parts->>'months'); end if;
    p_data:=jsonb_set(p_data,'{patient_ic}',to_jsonb(display));
  end if;
  if p_operation='EDIT' and p_to_slot is not null then raise exception 'Unexpected destination.'; end if;
  if p_operation='MOVE' and p_to_slot is null then raise exception 'Destination required.'; end if;
  perform 1 from public.orl_ot_slots where session_id in(select session_id from public.orl_ot_slots where id in(p_from_slot,p_to_slot)) order by id for update;
  if p_expected_request is null or not exists(select 1 from public.orl_ot_slots where id=p_from_slot and request_id=p_expected_request)
    then raise exception 'The selected OT patient has changed.'; end if;
  select * into r from public.orl_requests where id=p_expected_request for update;
  if not found or p_expected_version is null or r.updated_at is distinct from p_expected_version
    then raise exception 'The patient record changed. Reload and review it before saving.'; end if;
  if p_ic_mode='SET' then insert into orl_private.c1_write_permit values(pg_current_xact_id(),r.id); end if;
  if p_operation='EDIT' then
    perform public.orl_edit_scheduled_request_checked(p_session_token,p_from_slot,p_data-'postpone_count',p_action,p_expected_request);result:='UPDATED';
  else result:=public.orl_move_postponed_checked(p_session_token,p_from_slot,p_to_slot,p_data,p_reason,p_expected_request);end if;
  if p_ic_mode='SET' then
    if(select patient_ic from public.orl_requests where id=r.id) is distinct from display then raise exception 'IC mask write mismatch.'; end if;
    perform orl_private.c1_store_identity(r.id,raw,p_envelope,p_search);
    delete from orl_private.c1_write_permit where transaction_id=pg_current_xact_id() and request_id=r.id;
    insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
      values(u.id,u.display_name,u.role,'IC_ENCRYPTED_UPDATED','REQUEST',r.id::text,'Encrypted identity updated; operational value masked');
  end if;
  if p_data?'postpone_count' and(p_data->>'postpone_count')::integer is distinct from r.postpone_count then
    perform public.orl_set_postpone_count(p_session_token,r.id,(p_data->>'postpone_count')::integer);
  end if;
  return result;
end $$;
revoke all on function public.orl_ic_c1_mutate(uuid,text,uuid,uuid,uuid,jsonb,text,text,text,jsonb,jsonb,uuid,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_c1_mutate(uuid,text,uuid,uuid,uuid,jsonb,text,text,text,jsonb,jsonb,uuid,timestamptz) to service_role;

-- Version 3 backups never contain full IC in their request section.
create or replace function public.orl_ic_c1_export(p_session_token uuid,p_password text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype;result jsonb;identities jsonb;receipts jsonb;
begin
  u:=public.orl_require_webmaster_password(p_session_token,p_password);
  if not exists(select 1 from orl_private.c6_cutover_receipt where singleton) then raise exception 'C6 cutover incomplete'; end if;
  if not pg_try_advisory_xact_lock(hashtext('orl_ic_backup_export')) then raise exception 'Backup already running.'; end if;
  lock table public.orl_users,public.orl_sessions,public.orl_settings,public.orl_holidays,public.orl_ot_sessions,
    public.orl_requests,public.orl_ot_slots,public.orl_audit_log,orl_private.request_identity,orl_private.c1_creation_receipts in share mode nowait;
  result:=public.orl_db_export(p_session_token,p_password);
  select coalesce(jsonb_agg(jsonb_build_object('request_id',i.request_id,
    'envelope',jsonb_build_object('version',i.envelope_version,'key_id',i.encryption_key_id,
      'nonce',replace(encode(i.nonce,'base64'),chr(10),''),'ciphertext',replace(encode(i.ciphertext,'base64'),chr(10),'')),
    'search',jsonb_build_object('key_id',i.search_key_id,'normalization_version',i.normalization_version,
      'hash',replace(encode(i.search_hash,'base64'),chr(10),''))) order by i.request_id),'[]'::jsonb) into identities
    from orl_private.request_identity i;
  result:=jsonb_set(result,'{requests}',(select coalesce(jsonb_agg(x||jsonb_build_object('ic_protected',
    exists(select 1 from orl_private.request_identity i where i.request_id=(x->>'id')::uuid),
    'creation_tracked',exists(select 1 from orl_private.c1_creation_receipts c where c.request_id=(x->>'id')::uuid))),'[]'::jsonb)
    from jsonb_array_elements(result->'requests') x));
  select coalesce(jsonb_agg(to_jsonb(c) order by c.request_id),'[]'::jsonb) into receipts from orl_private.c1_creation_receipts c;
  return result||jsonb_build_object('version',3,'identity_format','ORL_IC_ENCRYPTED_V1','plaintext_removed',true,
    'identities',identities,'creation_receipt_format','ORL_CREATE_RECEIPTS_V1','creation_receipts',receipts);
end $$;
revoke all on function public.orl_ic_c1_export(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_c1_export(uuid,text) to service_role;

create or replace function public.orl_ic_c1_import(p_session_token uuid,p_password text,p_backup jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype;item jsonb;result jsonb;mapped_owner uuid;
begin
  u:=public.orl_require_webmaster_password(p_session_token,p_password);
  if not pg_try_advisory_xact_lock(hashtext('orl_db_import')) or not pg_try_advisory_xact_lock(hashtextextended('orl_ic_restore_generation',0))
    then raise exception 'Restore unavailable or creation still running'; end if;
  if jsonb_typeof(p_backup) is distinct from 'object' or p_backup->>'format'<>'ORLOMS_BACKUP'
    or p_backup->'version' is distinct from '3'::jsonb or p_backup->>'identity_format'<>'ORL_IC_ENCRYPTED_V1'
    or p_backup->'plaintext_removed' is distinct from 'true'::jsonb
    or jsonb_typeof(p_backup->'requests') is distinct from 'array' or jsonb_typeof(p_backup->'identities') is distinct from 'array'
    or jsonb_typeof(p_backup->'creation_receipts') is distinct from 'array' or length(p_backup::text)>104857600
    then raise exception 'Compatible version-3 backup required'; end if;
  if exists(select 1 from jsonb_array_elements(p_backup->'requests') r
      where jsonb_typeof(r) is distinct from 'object' or jsonb_typeof(r->'ic_protected') is distinct from 'boolean'
      or coalesce(r->>'patient_ic','') is distinct from orl_private.c1_mask_ic(coalesce(r->>'patient_ic','')))
    or exists(select 1 from jsonb_array_elements(p_backup->'requests') r
      where(r->'ic_protected'='true'::jsonb) is distinct from exists(select 1 from jsonb_array_elements(p_backup->'identities') i where i->>'request_id'=r->>'id'))
    then raise exception 'Invalid version-3 identity manifest'; end if;
  lock table public.orl_users,public.orl_sessions,public.orl_settings,public.orl_holidays,public.orl_ot_sessions,
    public.orl_requests,public.orl_ot_slots,public.orl_audit_log,orl_private.request_identity,orl_private.c1_creation_receipts in access exclusive mode nowait;
  delete from orl_private.request_identity;
  result:=public.orl_db_import_locked(p_session_token,p_password,jsonb_set(p_backup,'{version}','1'::jsonb));
  for item in select * from jsonb_array_elements(p_backup->'identities') loop
    perform orl_private.c1_store_identity((item->>'request_id')::uuid,
      (select patient_ic from public.orl_requests where id=(item->>'request_id')::uuid),item->'envelope',item->'search');
  end loop;
  for item in select * from jsonb_array_elements(p_backup->'creation_receipts') loop
    select(select cu.id from public.orl_users cu join jsonb_array_elements(p_backup->'users') bu
      on lower(bu->>'username')=lower(cu.username) where bu->>'id'=item->>'owner_id') into mapped_owner;
    mapped_owner:=coalesce(mapped_owner,(item->>'owner_id')::uuid);
    if exists(select 1 from orl_private.c1_creation_receipts where request_id=(item->>'request_id')::uuid and owner_id<>mapped_owner)
      then raise exception 'Creation recovery owner conflict'; end if;
    insert into orl_private.c1_creation_receipts(request_id,owner_id,outcome,created_at)
      values((item->>'request_id')::uuid,mapped_owner,item->>'outcome',(item->>'created_at')::timestamptz) on conflict(request_id) do nothing;
  end loop;
  if exists(select 1 from orl_private.c1_creation_receipts c join public.orl_requests r on r.id=c.request_id
    where r.created_by is not null and r.created_by<>c.owner_id) then raise exception 'Restored creation owner conflict'; end if;
  update orl_private.c1_creation_receipts c set outcome='CREATED' where exists(select 1 from public.orl_requests r where r.id=c.request_id);
  update orl_private.c1_restore_generation set generation=gen_random_uuid() where singleton;
  update orl_private.c6_cutover_receipt set generation=(select generation from orl_private.c1_restore_generation where singleton),
    protected_count=(select count(*) from orl_private.request_identity),blank_count=(select count(*) from public.orl_requests where patient_ic=''),
    completed_at=clock_timestamp() where singleton;
  return result||jsonb_build_object('identities',jsonb_array_length(p_backup->'identities'),
    'creation_receipts',(select count(*) from orl_private.c1_creation_receipts));
end $$;
revoke all on function public.orl_ic_c1_import(uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_c1_import(uuid,text,jsonb) to service_role;

create function public.orl_ic_c6_cutover(p_session_token uuid,p_password text,p_generation uuid,p_run_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype;run orl_private.c2_verification_runs%rowtype;before_stats jsonb;after_stats jsonb;protected integer;blank integer;
begin
  u:=public.orl_require_webmaster_password(p_session_token,p_password);perform orl_private.c1_check_generation(p_generation);
  if exists(select 1 from orl_private.c6_cutover_receipt where singleton) then raise exception 'C6 already completed'; end if;
  select * into run from orl_private.c2_verification_runs where run_id=p_run_id for update;
  if not found or run.completed_at is null or run.generation<>p_generation or run.revision is distinct from orl_private.c2_revision()
    then raise exception 'Fresh completed cryptographic verification required'; end if;
  lock table public.orl_requests,orl_private.request_identity,public.orl_audit_log in share row exclusive mode nowait;
  before_stats:=orl_private.c6_stats();
  if(before_stats->>'identity_mismatch')::integer<>0
    or exists(select 1 from public.orl_requests r join orl_private.request_identity i on i.request_id=r.id
      left join orl_private.c2_verified_identity v on v.run_id=p_run_id and v.request_id=r.id
        and v.request_updated_at=r.updated_at and v.identity_updated_at=i.updated_at where v.request_id is null)
    then raise exception 'C6 reconciliation changed or is incomplete'; end if;
  -- Permanently scrub known identities from free-text stores before losing the exact-value map.
  update public.orl_audit_log set details=orl_private.c1_redact_text(details),record_id=orl_private.c1_redact_text(record_id);
  update public.orl_requests set remark=orl_private.c1_redact_text(remark),
    deletion_reason=orl_private.c1_redact_text(deletion_reason),review_note=orl_private.c1_redact_text(review_note),
    postpone_history=orl_private.c6_redact_json(postpone_history);
  update public.orl_holidays set description=orl_private.c1_redact_text(description);
  update public.orl_ot_sessions set note=orl_private.c1_redact_text(note),special_title=orl_private.c1_redact_text(special_title);
  insert into orl_private.c1_write_permit(transaction_id,request_id)
    select pg_current_xact_id(),r.id from public.orl_requests r join orl_private.request_identity i on i.request_id=r.id;
  update public.orl_requests set patient_ic=orl_private.c1_mask_ic(patient_ic)
    where trim(coalesce(patient_ic,''))<>'' and patient_ic is distinct from orl_private.c1_mask_ic(patient_ic);
  delete from orl_private.c1_write_permit where transaction_id=pg_current_xact_id();
  select count(*) into protected from orl_private.request_identity;
  select count(*) into blank from public.orl_requests where trim(coalesce(patient_ic,''))='';
  insert into orl_private.c6_cutover_receipt(singleton,generation,verification_run_id,protected_count,blank_count)
    values(true,p_generation,p_run_id,protected,blank);
  after_stats:=orl_private.c6_stats();
  if(after_stats->>'plaintext_rows')::integer<>0 or(after_stats->>'identity_mismatch')::integer<>0
    then raise exception 'C6 post-cutover verification failed'; end if;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
    values(u.id,u.display_name,u.role,'IC_C6_PLAINTEXT_REMOVED','SYSTEM','C6',
      'Full operational IC plaintext removed after fresh cryptographic verification. Protected count: '||protected);
  execute 'revoke execute on function public.orl_ic_c2_status(uuid,text),public.orl_ic_c2_backfill_view(uuid,text,uuid,text),public.orl_ic_c2_backfill_commit(uuid,text,uuid,text,jsonb),public.orl_ic_c2_verify_start(uuid,text,uuid,text),public.orl_ic_c2_verify_view(uuid,text,uuid,uuid),public.orl_ic_c2_verify_commit(uuid,text,uuid,uuid,jsonb),public.orl_ic_c2_finalize(uuid,text,uuid,uuid) from service_role';
  return after_stats||jsonb_build_object('status','COMPLETED','generation',p_generation,'verification_run_id',p_run_id);
end $$;
revoke all on function public.orl_ic_c6_cutover(uuid,text,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_c6_cutover(uuid,text,uuid,uuid) to service_role;

-- C2 maintenance exposes legacy plaintext by design and must be closed after C6.
revoke all on function public.orl_ic_c2_status(uuid,text),public.orl_ic_c2_backfill_view(uuid,text,uuid,text),
  public.orl_ic_c2_backfill_commit(uuid,text,uuid,text,jsonb),public.orl_ic_c2_verify_start(uuid,text,uuid,text),
  public.orl_ic_c2_verify_view(uuid,text,uuid,uuid),public.orl_ic_c2_verify_commit(uuid,text,uuid,uuid,jsonb),
  public.orl_ic_c2_finalize(uuid,text,uuid,uuid) from public,anon,authenticated;

notify pgrst,'reload schema';
commit;
