-- Historical clinical corrections are separate from ordinary booking.
-- Only a password-confirmed Webmaster may save. Existing lifecycle and slot
-- state are preserved; adding a missing case never marks its operation Done.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $baseline$
declare item record;
begin
 if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where (n.nspname='public' and p.proname in('orl_ic_past_case_view','orl_ic_past_case_save'))
    or (n.nspname='orl_private' and p.proname in('past_case_snapshot','past_case_record'))) then
  raise exception '065: historical correction functions already exist or installation is partial. Inspect before retrying.';
 end if;
 if orl_private.c1_recovery_ready() is distinct from true or (orl_private.c6_stats()->>'cutover_complete')::boolean is distinct from true then
  raise exception '065: completed protected recovery/cutover baseline required.';
 end if;
 for item in select * from (values
  ('public.orl_require_session(uuid)','ba9d29923e7269729c8025bf1e266208'),
  ('public.orl_require_webmaster_password(uuid,text)','db8fc906a57e43110f61b1a4c54bfeff'),
  ('orl_private.c1_check_generation(uuid)','5c654a99ad55c29ba66b9b74371c8239'),
  ('orl_private.c1_store_identity(uuid,text,jsonb,jsonb)','a6abf4407bc4d78bc39b2117a22c5449'),
  ('orl_private.c1_redact_text(text)','aea30f10772d86163fb1aa4e2362fac3'),
  ('orl_private.c6_redact_json(jsonb)','5bbe8c9f03d45b34baccadd7ca9e87a4'),
  ('orl_private.c1_mask_json(jsonb,date)','c0f13f6252204154dd0e860a1b1ba476'),
  ('public.orl_ic_ot_lifecycle(uuid,uuid,uuid,text,text,uuid,timestamptz)','23f48d226ea2fa298821f8cfe06c5ffa'),
  ('public.orl_ic_c1_mutate(uuid,text,uuid,uuid,uuid,jsonb,text,text,text,jsonb,jsonb,uuid,timestamptz)','9369627b09c1739c304e1c7256b3eaa7'),
  ('public.orl_assign_slot(uuid,uuid,uuid)','b924d46e7bcac41332c9470521a72080'),
  ('public.orl_move_postponed_checked(uuid,uuid,uuid,jsonb,text,uuid)','3589a9e866155d91641accafb59ce01d'),
  ('public.orl_booking_move_request(uuid,uuid,date,text,uuid,timestamptz,uuid)','1b4697c9e242cc5911696fc60c87ffa0'),
  ('public.orl_booking_move_review(uuid,uuid,text,uuid,timestamptz,timestamptz,uuid)','2473bcdf691eb5b613431772bb90c1e3'),
  ('public.orl_db_import_locked(uuid,text,jsonb)','097da3e68879e5e783e7cd2d6fbc2e8c')
 ) v(signature,expected_md5) loop
  if not coalesce((select prosecdef and md5(replace(prosrc,chr(13),''))=item.expected_md5
   from pg_proc where oid=to_regprocedure(item.signature)),false) then
   raise exception '065: protected baseline differs: %',item.signature;
  end if;
 end loop;
 for item in select * from (values
  ('orl_private.c1_mask_ic(text)','f8d715b3e456a34f9f5349ce7fdf91fb'),
  ('public.orl_age_parts(text,date)','cf5fa47be6838658a3775348d2da42da'),
  ('public.orl_valid_age_months(text)','8be7f7c23f8d09fe830f61b457239d87')
 ) v(signature,expected_md5) loop
  if not coalesce((select md5(replace(prosrc,chr(13),''))=item.expected_md5
   from pg_proc where oid=to_regprocedure(item.signature)),false) then
   raise exception '065: clinical validation baseline differs: %',item.signature;
  end if;
 end loop;
 if exists(select 1 from unnest(array['anon','authenticated','service_role']) role_name
  cross join unnest(array['public.orl_require_session(uuid)',
   'orl_private.c1_check_generation(uuid)','orl_private.c1_store_identity(uuid,text,jsonb,jsonb)',
   'orl_private.c1_mask_json(jsonb,date)','public.orl_db_import_locked(uuid,text,jsonb)']) signature
  where has_function_privilege(role_name,signature,'EXECUTE')) then raise exception '065: private helper permissions differ.'; end if;
 if exists(select 1 from unnest(array['anon','authenticated']) role_name
  where has_function_privilege(role_name,'public.orl_require_webmaster_password(uuid,text)','EXECUTE')) then
  raise exception '065: password helper browser permissions differ.';
 end if;
 if not exists(select 1 from pg_constraint where conrelid='public.orl_requests'::regclass
   and conname='orl_requests_completion_state' and convalidated)
  or not exists(select 1 from pg_constraint where conrelid='public.orl_requests'::regclass
   and conname='orl_requests_ot_hold_state' and convalidated) then raise exception '065: lifecycle constraints missing.'; end if;
end $baseline$;

-- Fingerprint never leaves clinical data, identity envelopes or search hashes
-- in the client. Complete rows also detect changes to links, closure and Hold.
create function orl_private.past_case_snapshot(p_slot_id uuid)
returns text language sql stable security definer set search_path='' as $$
 select encode(extensions.digest(convert_to(jsonb_build_object(
  'slot',to_jsonb(sl),'session',to_jsonb(s),'request',to_jsonb(r),'identity',to_jsonb(i))::text,'UTF8'),'sha256'),'hex')
 from public.orl_ot_slots sl join public.orl_ot_sessions s on s.id=sl.session_id
 left join public.orl_requests r on r.id=sl.request_id
 left join orl_private.request_identity i on i.request_id=r.id where sl.id=p_slot_id
$$;
revoke all on function orl_private.past_case_snapshot(uuid) from public,anon,authenticated,service_role;

create function orl_private.past_case_record(p_request_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
 select orl_private.c6_redact_json(jsonb_build_object(
  'patient_name',r.patient_name,'mrn',r.mrn,'patient_ic',orl_private.c1_mask_ic(r.patient_ic),
  'age',r.age,'age_months',r.age_months,'diagnosis',r.diagnosis,'surgery',r.surgery,
  'doctor',r.doctor,'specialist',r.specialist,'sub_specialty',r.sub_specialty,
  'phone',r.phone,'remark',r.remark)) from public.orl_requests r where r.id=p_request_id
$$;
revoke all on function orl_private.past_case_record(uuid) from public,anon,authenticated,service_role;

create function public.orl_ic_past_case_view(p_session_token uuid,p_slot_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype;sl public.orl_ot_slots%rowtype;s public.orl_ot_sessions%rowtype;
 r public.orl_requests%rowtype;g uuid;mode text;
begin
 u:=public.orl_require_session(p_session_token);
 if u.role<>'WEBMASTER' then raise exception 'Webmaster access required.' using errcode='42501'; end if;
 select generation into g from orl_private.c1_restore_generation where singleton;
 perform orl_private.c1_check_generation(g);
 select * into sl from public.orl_ot_slots where id=p_slot_id for share;
 if not found then raise exception 'Historical slot not found.'; end if;
 select * into r from public.orl_requests where id=sl.request_id for share;
 select * into s from public.orl_ot_sessions where id=sl.session_id for share;
 if s.id is null or s.ot_date>=(clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date then
  raise exception 'Historical corrections are available only for past OT dates.' using errcode='22023';
 end if;
 if sl.request_id is null then
  if sl.status not in('AVAILABLE','CLOSED') then raise exception 'Historical slot state is inconsistent. Reload and review.'; end if;
  mode:='ADD';
 else
  if r.id is null or r.assigned_slot_id is distinct from sl.id or sl.status not in('RESERVED','CONFIRMED') then
   raise exception 'Historical patient links are inconsistent. Reload and review.';
  end if;
  mode:='EDIT';
 end if;
 return jsonb_build_object('mode',mode,'slot_id',sl.id,'session_id',s.id,'ot_date',s.ot_date,
  'slot_type',sl.slot_type,'slot_number',sl.slot_number,'slot_status',sl.status,'session_status',s.status,
  'request_id',r.id,'request_status',r.status,'ot_hold',coalesce(r.ot_hold,false),'postpone_count',coalesce(r.postpone_count,0),
  'generation',g,'expected_version',r.updated_at,'snapshot',orl_private.past_case_snapshot(sl.id),
  'patient',orl_private.past_case_record(r.id));
end $$;
revoke all on function public.orl_ic_past_case_view(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_past_case_view(uuid,uuid) to service_role;

create function public.orl_ic_past_case_save(p_session_token uuid,p_password text,p_mode text,p_slot_id uuid,
 p_request_id uuid,p_data jsonb,p_reason text,p_ic_mode text,p_envelope jsonb,p_search jsonb,
 p_generation uuid,p_snapshot text,p_expected_version timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype;sl public.orl_ot_slots%rowtype;s public.orl_ot_sessions%rowtype;
 r public.orl_requests%rowtype;clean jsonb;before_record jsonb;after_record jsonb;
 raw text;display text;parts jsonb;clean_reason text;revision timestamptz;k text;v jsonb;
 key_mrn text;key_surgery text;request_number text;
 allowed constant text[]:=array['patient_name','mrn','age','age_months','diagnosis','surgery','doctor','specialist','sub_specialty','phone','remark','patient_ic'];
begin
 u:=public.orl_require_session(p_session_token);
 if u.role<>'WEBMASTER' then raise exception 'Webmaster access required.' using errcode='42501'; end if;
 perform public.orl_require_webmaster_password(p_session_token,p_password);
 if p_mode is null or p_mode not in('EDIT','ADD') or p_slot_id is null or p_request_id is null
  or p_ic_mode is null or p_ic_mode not in('KEEP','SET') or jsonb_typeof(p_data) is distinct from 'object'
  or p_reason is null or p_reason !~ '[^[:space:]]' or length(p_reason)>2000
  or p_snapshot is null or p_snapshot !~ '^[0-9a-f]{64}$'
  or (p_mode='EDIT' and (p_expected_version is null or not isfinite(p_expected_version)))
  or (p_mode='ADD' and (p_expected_version is not null or p_ic_mode<>'SET')) then
  raise exception 'Invalid historical correction. Enter a reason and review a fresh snapshot.';
 end if;
 for k,v in select * from jsonb_each(p_data) loop
  if not k=any(allowed) or length(coalesce(v#>>'{}',''))>4096
   or (k not in('age','age_months') and jsonb_typeof(v) is distinct from 'string')
   or (k in('age','age_months') and jsonb_typeof(v) not in('string','number','null')) then
   raise exception 'Only clinical fields can be corrected in a historical record.';
  end if;
 end loop;
 if p_ic_mode='KEEP' then
  if p_data?'patient_ic' or p_envelope is not null or p_search is not null then raise exception 'KEEP cannot replace IC.'; end if;
 else
  if jsonb_typeof(p_data->'patient_ic') is distinct from 'string' then raise exception 'Explicit IC required.'; end if;
  raw:=btrim(p_data->>'patient_ic');
  if length(raw)>128 or raw~'[^ -~]' or (raw<>'' and raw!~'[A-Za-z0-9]') or raw~'[*]' then raise exception 'Invalid identity. Do not save a masked display value.'; end if;
  display:=orl_private.c1_mask_ic(raw);
 end if;
 perform orl_private.c1_check_generation(p_generation);
 -- Same order as normal movement: all affected session slots, request, then proposals.
 perform 1 from public.orl_ot_slots where session_id=(select session_id from public.orl_ot_slots where id=p_slot_id) order by id for update;
 select * into sl from public.orl_ot_slots where id=p_slot_id;
 if not found then raise exception 'Historical slot not found.'; end if;
 select * into r from public.orl_requests where id=sl.request_id for update;
 select * into s from public.orl_ot_sessions where id=sl.session_id for share;
 if s.id is null or s.ot_date>=(clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date then
  raise exception 'Historical corrections are available only for past OT dates.' using errcode='22023';
 end if;
 if orl_private.past_case_snapshot(sl.id) is distinct from p_snapshot then
  raise exception 'Historical record or slot changed. Reload and review before saving.';
 end if;
 if p_mode='EDIT' then
  if sl.request_id is distinct from p_request_id or r.id is null or r.assigned_slot_id is distinct from sl.id
   or sl.status not in('RESERVED','CONFIRMED') or r.updated_at is distinct from p_expected_version then
   raise exception 'Historical patient changed. Reload and review before saving.';
  end if;
  -- Audit stores actual previous values, not display-derived age calculations.
  before_record:=orl_private.c6_redact_json(to_jsonb(r)||jsonb_build_object('patient_ic',orl_private.c1_mask_ic(r.patient_ic)));
  clean:=jsonb_build_object('patient_name',r.patient_name,'mrn',r.mrn,'age',r.age,'age_months',r.age_months,
   'diagnosis',r.diagnosis,'surgery',r.surgery,'doctor',r.doctor,'specialist',r.specialist,
   'sub_specialty',r.sub_specialty,'phone',r.phone,'remark',r.remark)||p_data;
  if p_ic_mode='KEEP' then display:=r.patient_ic; end if;
 else
  if sl.request_id is not null or sl.status not in('AVAILABLE','CLOSED') then raise exception 'Historical slot is no longer empty.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('orl_ic_create:'||p_request_id::text,0));
  if exists(select 1 from public.orl_requests where id=p_request_id)
   or exists(select 1 from orl_private.c1_creation_receipts where request_id=p_request_id) then
   raise exception 'This historical creation attempt has already been used. Reload and review its result.';
  end if;
  clean:=jsonb_build_object('doctor',u.display_name,'specialist','','sub_specialty','','phone','','remark','','age_months',null)||p_data;
 end if;
 if p_ic_mode='SET' then
  parts:=public.orl_age_parts(raw,s.ot_date);
  if parts is not null then clean:=clean||jsonb_build_object('age',parts->'years','age_months',parts->'months'); end if;
 end if;
 clean:=clean-'patient_ic';
 clean_reason:=btrim(p_reason);
 -- Do not leak the new full IC/passport through free text or the audit trail.
 if p_ic_mode='SET' and raw<>'' then
  clean_reason:=replace(clean_reason,raw,display);
  for k,v in select * from jsonb_each(clean) loop
   if jsonb_typeof(v)='string' then clean:=jsonb_set(clean,array[k],to_jsonb(replace(v#>>'{}',raw,display))); end if;
  end loop;
 end if;
 clean_reason:=orl_private.c1_redact_text(clean_reason);
 clean:=orl_private.c6_redact_json(clean);
 -- Legacy unknown age can remain unknown during an unrelated correction.
 -- New entries, explicit age changes and IC-derived ages are always validated.
 if p_mode='ADD' or p_data?'age' or (p_ic_mode='SET' and parts is not null) then
  if clean->>'age' is null or clean->>'age' !~ '^[0-9]{1,3}$' or (clean->>'age')::integer not between 0 and 130 then
   raise exception 'Enter an age between 0 and 130.';
  end if;
 end if;
 clean:=clean||jsonb_build_object('age_months',public.orl_valid_age_months(clean->>'age_months'));
 foreach k in array array['patient_name','mrn','diagnosis','surgery','sub_specialty'] loop
  if nullif(btrim(clean->>k),'') is null then raise exception 'Historical patient details are incomplete.'; end if;
 end loop;
 key_mrn:=lower(btrim(clean->>'mrn'));key_surgery:=lower(regexp_replace(btrim(clean->>'surgery'),'\s+',' ','g'));
 -- An earlier/later episode is legitimate; the same case on this date is not.
 perform pg_advisory_xact_lock(hashtextextended('orl_past_case:'||s.ot_date::text||chr(31)||key_mrn||chr(31)||key_surgery,0));
 if exists(select 1 from public.orl_requests other join public.orl_ot_slots os on os.id=other.assigned_slot_id and os.request_id=other.id
  join public.orl_ot_sessions od on od.id=os.session_id where od.ot_date=s.ot_date and other.id<>p_request_id
   and lower(btrim(other.mrn))=key_mrn and lower(regexp_replace(btrim(other.surgery),'\s+',' ','g'))=key_surgery) then
  raise exception 'Duplicate rejected: this MRN and procedure are already recorded on the selected OT date.';
 end if;
 revision:=greatest(clock_timestamp(),coalesce(r.updated_at,clock_timestamp())+interval '1 microsecond');
 if p_mode='EDIT' then
  if p_ic_mode='SET' then insert into orl_private.c1_write_permit values(pg_current_xact_id(),r.id); end if;
  update public.orl_requests set patient_name=btrim(clean->>'patient_name'),mrn=btrim(clean->>'mrn'),
   age=(clean->>'age')::integer,age_months=(clean->>'age_months')::integer,
   diagnosis=btrim(clean->>'diagnosis'),surgery=btrim(clean->>'surgery'),doctor=btrim(clean->>'doctor'),
   specialist=btrim(clean->>'specialist'),sub_specialty=btrim(clean->>'sub_specialty'),phone=btrim(clean->>'phone'),
   remark=clean->>'remark',patient_ic=display,updated_at=revision where id=r.id;
 else
  insert into orl_private.c1_creation_receipts(request_id,owner_id,outcome) values(p_request_id,u.id,'CREATED');
  request_number:='REQ-'||to_char(current_date,'YYYY')||'-'||lpad(nextval('public.orl_request_number_seq')::text,6,'0');
  insert into public.orl_requests(id,request_number,patient_ic,patient_name,mrn,age,age_months,diagnosis,surgery,doctor,
   specialist,sub_specialty,phone,remark,created_by,booked_by_name,assigned_slot_id,status,confirmed_at,reviewed_by,reviewed_at,updated_at)
  values(p_request_id,request_number,display,btrim(clean->>'patient_name'),btrim(clean->>'mrn'),(clean->>'age')::integer,
   (clean->>'age_months')::integer,btrim(clean->>'diagnosis'),btrim(clean->>'surgery'),btrim(clean->>'doctor'),
   btrim(clean->>'specialist'),btrim(clean->>'sub_specialty'),btrim(clean->>'phone'),clean->>'remark',u.id,u.display_name,
   sl.id,'SCHEDULED',revision,u.id,revision,revision);
  update public.orl_ot_slots set request_id=p_request_id,status='CONFIRMED',updated_by=u.id,updated_at=revision where id=sl.id;
 end if;
 if p_ic_mode='SET' then
  perform orl_private.c1_store_identity(p_request_id,raw,p_envelope,p_search);
  delete from orl_private.c1_write_permit where transaction_id=pg_current_xact_id() and request_id=p_request_id;
 end if;
 -- Previously reviewed move proposals are now stale, not silently re-approved.
 update orl_private.booking_move_requests set status='INVALIDATED',updated_at=revision
  where request_id=p_request_id and generation=p_generation and status='PENDING';
 select orl_private.c6_redact_json(to_jsonb(saved)||jsonb_build_object('patient_ic',orl_private.c1_mask_ic(saved.patient_ic))) into after_record
  from public.orl_requests saved where saved.id=p_request_id;
 insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
 values(u.id,u.display_name,u.role,case when p_mode='ADD' then 'PAST_CASE_ADDED' else 'PAST_CASE_CORRECTED' end,
  'REQUEST',p_request_id::text,jsonb_build_object('reason',clean_reason,'ot_date',s.ot_date,'slot_id',sl.id,
   'slot_type',sl.slot_type,'slot_number',sl.slot_number,'session_status',s.status,
   'previous_slot_status',sl.status,'new_slot_status',case when p_mode='ADD' then 'CONFIRMED' else sl.status end,
   'before',before_record,'after',after_record,'identity_changed',p_ic_mode='SET')::text);
 return jsonb_build_object('request_id',p_request_id,'slot_id',sl.id,'ot_date',s.ot_date,
  'status',after_record->>'status','updated_at',revision,'mode',p_mode);
end $$;
revoke all on function public.orl_ic_past_case_save(uuid,text,text,uuid,uuid,jsonb,text,text,jsonb,jsonb,uuid,text,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_past_case_save(uuid,text,text,uuid,uuid,jsonb,text,text,jsonb,jsonb,uuid,text,timestamptz) to service_role;

-- Old clients must not bypass the reason/password/snapshot historical path.
-- Only EDIT is intercepted. Existing protected MOVE and future edits are unchanged.
do $guard_old_edit$
declare fn regprocedure:='public.orl_ic_c1_mutate(uuid,text,uuid,uuid,uuid,jsonb,text,text,text,jsonb,jsonb,uuid,timestamptz)'::regprocedure;
 source text;definition text;before_acl aclitem[];
 old_part constant text:=$old$  if p_ic_mode='SET' then insert into orl_private.c1_write_permit values(pg_current_xact_id(),r.id); end if;$old$;
 new_part constant text:=$new$  if p_operation='EDIT' and exists(select 1 from public.orl_ot_slots historical_slot
    join public.orl_ot_sessions historical_day on historical_day.id=historical_slot.session_id
    where historical_slot.id=p_from_slot and historical_day.ot_date<(clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date) then
    raise exception 'Use Webmaster Edit Past Record for historical corrections.' using errcode='42501';
  end if;
  if p_ic_mode='SET' then insert into orl_private.c1_write_permit values(pg_current_xact_id(),r.id); end if;$new$;
begin
 select replace(prosrc,chr(13),''),proacl into source,before_acl from pg_proc where oid=fn;
 if (length(source)-length(replace(source,old_part,'')))/length(old_part)<>1 then
  raise exception '065: reviewed edit guard target missing or duplicated.';
 end if;
 definition:=replace(replace(pg_get_functiondef(fn),chr(13),''),source,replace(source,old_part,new_part));
 execute definition;
 if not exists(select 1 from pg_proc where oid=fn and prosecdef and proacl is not distinct from before_acl) then
  raise exception '065: existing edit function permissions changed.';
 end if;
end $guard_old_edit$;

notify pgrst,'reload schema';
commit;
