-- Candidate 040. Additive age precision; preserves previous booking and concurrency safeguards.
begin;
-- Additional precision; NULL means historical month precision was not recorded.
alter table public.orl_requests add column age_months integer
  check (age_months is null or age_months between 0 and 11);

create or replace function public.orl_age_parts(p_ic text,p_at date default current_date)
returns jsonb language plpgsql stable set search_path=public,extensions as $$
declare raw text:=trim(coalesce(p_ic,'')); digits text; born date; y integer; m integer; d integer; delta interval;
begin
 if raw !~ '^[0-9]{6}-?[0-9]{2}-?[0-9]{4}$' or p_at is null then return null; end if;
 digits:=replace(raw,'-',''); y:=2000+substring(digits,1,2)::integer;
 m:=substring(digits,3,2)::integer; d:=substring(digits,5,2)::integer;
 begin
  born:=make_date(y,m,d);
  -- Anchor century inference to today, not a future OT year.
  if born>current_date then born:=make_date(y-100,m,d); end if;
 exception when datetime_field_overflow then return null; end;
 if born>p_at then return null; end if;
 delta:=age(p_at,born);
 if extract(year from delta)>130 then return null; end if;
 return jsonb_build_object('years',extract(year from delta)::integer,'months',extract(month from delta)::integer);
end $$;
revoke all on function public.orl_age_parts(text,date) from public,anon,authenticated;

create or replace function public.orl_valid_age_months(p_value text)
returns integer language plpgsql immutable set search_path=public,extensions as $$
declare n integer;
begin
 if p_value is null or trim(p_value)='' then return null; end if;
 if trim(p_value) !~ '^[0-9]{1,2}$' then raise exception 'Age months must be a whole number from 0 to 11.'; end if;
 n:=trim(p_value)::integer;
 if n not between 0 and 11 then raise exception 'Age months must be between 0 and 11.'; end if;
 return n;
end $$;
revoke all on function public.orl_valid_age_months(text) from public,anon,authenticated;

create or replace function public.orl_create_request(p_session_token uuid,p_data jsonb)
returns uuid language plpgsql security definer set search_path=public,extensions as $$
declare
  v_user public.orl_users%rowtype;
  v_id uuid; v_number text; v_age integer; calculated_age integer; v_months integer; parts jsonb;
  ic text:=trim(coalesce(p_data->>'patient_ic',''));
  doctor_name text;
  v_mrn text:=lower(trim(coalesce(p_data->>'mrn','')));
  v_surgery text:=lower(regexp_replace(trim(coalesce(p_data->>'surgery','')),'\s+',' ','g'));
  v_allow_duplicate boolean:=lower(coalesce(p_data->>'allow_duplicate','false')) in('true','1','yes','on');
  v_override_reason text:=trim(coalesce(p_data->>'duplicate_reason',''));
  v_existing_id uuid; v_existing_number text;
begin
  v_user:=public.orl_require_session(p_session_token);
  begin v_age:=nullif(trim(p_data->>'age'),'')::integer;
  exception when invalid_text_representation then raise exception 'Age must be a whole number.';
  end;
  v_months:=public.orl_valid_age_months(p_data->>'age_months');
  parts:=public.orl_age_parts(ic,current_date);
  if parts is not null then v_age:=(parts->>'years')::integer; v_months:=(parts->>'months')::integer; end if;
  if v_age is null or v_age not between 0 and 130 then raise exception 'Enter an age between 0 and 130.'; end if;
  if v_mrn='' then raise exception 'MRN is required.'; end if;
  if nullif(trim(p_data->>'patient_name'),'') is null then raise exception 'Patient Name is required.'; end if;
  if v_surgery='' then raise exception 'Surgery is required.'; end if;
  if nullif(trim(p_data->>'diagnosis'),'') is null then raise exception 'Diagnosis is required.'; end if;
  if nullif(initcap(trim(p_data->>'specialist')),'') is null then raise exception 'Specialist is required.'; end if;
  if nullif(trim(p_data->>'sub_specialty'),'') is null then raise exception 'Sub-specialty is required.'; end if;
  if nullif(trim(p_data->>'phone'),'') is null then raise exception 'Phone is required.'; end if;

  -- Serialise equal MRN + procedure submissions so double-clicks cannot create two rows.
  perform pg_advisory_xact_lock(hashtextextended(v_mrn||chr(31)||v_surgery,0));
  select r.id,r.request_number into v_existing_id,v_existing_number
  from public.orl_requests r
  where lower(trim(r.mrn))=v_mrn
    and lower(regexp_replace(trim(r.surgery),'\s+',' ','g'))=v_surgery
    and r.status not in('CANCELLED','COMPLETED','REJECTED')
  order by r.created_at desc limit 1;

  if v_existing_id is not null then
    if v_user.role not in('ADMIN','WEBMASTER') or not v_allow_duplicate then
      raise exception 'Duplicate blocked: active request % already has the same MRN and procedure.',v_existing_number;
    end if;
    if v_override_reason='' then raise exception 'An override reason is required for a duplicate request.'; end if;
  end if;

  doctor_name:=coalesce(nullif(trim(p_data->>'doctor'),''),v_user.display_name);
  v_number:='REQ-'||to_char(current_date,'YYYY')||'-'||lpad(nextval('public.orl_request_number_seq')::text,6,'0');
  insert into public.orl_requests(
    request_number,patient_ic,age,age_months,mrn,patient_name,surgery,diagnosis,doctor,
    specialist,sub_specialty,phone,remark,created_by
  ) values(
    v_number,ic,v_age,v_months,trim(p_data->>'mrn'),trim(p_data->>'patient_name'),
    trim(p_data->>'surgery'),trim(p_data->>'diagnosis'),initcap(doctor_name),
    initcap(trim(p_data->>'specialist')),trim(p_data->>'sub_specialty'),trim(p_data->>'phone'),
    coalesce(p_data->>'remark',''),v_user.id
  ) returning id into v_id;

  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
  values(v_user.id,v_user.display_name,v_user.role,'REQUEST_CREATED','REQUEST',v_id::text,'Draft request created');
  if v_existing_id is not null then
    insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
    values(v_user.id,v_user.display_name,v_user.role,'DUPLICATE_OVERRIDE','REQUEST',v_id::text,
      'Override of '||v_existing_number||' | Reason: '||v_override_reason);
  end if;
  return v_id;
end $$;

create or replace function public.orl_edit_scheduled_request_checked(p_session_token uuid,p_slot_id uuid,p_data jsonb,p_action text,p_expected_request_id uuid)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare
  v_user public.orl_users%rowtype;
  v_slot public.orl_ot_slots%rowtype;
  v_req public.orl_requests%rowtype;
  act text:=upper(p_action); reason text; v_age integer; calculated_age integer; new_ic text; v_months integer; parts jsonb;
begin
  v_user:=public.orl_require_session(p_session_token);
  if act is null or act not in('CONFIRM','POSTPONE','CANCEL') then raise exception 'Invalid status action.'; end if;
  perform 1 from public.orl_ot_slots
  where session_id=(select session_id from public.orl_ot_slots where id=p_slot_id)
  order by id for update;
  select * into v_slot from public.orl_ot_slots where id=p_slot_id for update;
  if p_expected_request_id is null or v_slot.request_id is distinct from p_expected_request_id then
    raise exception 'The selected OT patient has changed. Refresh the schedule and select again.';
  end if;
  if not found or v_slot.request_id is null then raise exception 'Assigned request not found.'; end if;
  select * into v_req from public.orl_requests where id=v_slot.request_id for update;
  if not found then raise exception 'Assigned request not found.'; end if;
  if v_req.assigned_slot_id is distinct from v_slot.id or v_req.status='CANCELLED' then
    raise exception 'OT slot links are inconsistent. No changes applied; contact Admin.';
  end if;
  if v_user.role='STAFF' and v_req.created_by is distinct from v_user.id and act<>'CANCEL' then raise exception 'You do not have access.'; end if;

  if v_user.role='STAFF' then
    -- Cancellation requests must not double as edits to clinical details.
    if act<>'CANCEL' then
    update public.orl_requests set
      surgery=coalesce(nullif(trim(p_data->>'surgery'),''),surgery),
      diagnosis=coalesce(nullif(trim(p_data->>'diagnosis'),''),diagnosis),updated_at=now()
    where id=v_req.id;
    end if;
  else
    new_ic:=coalesce(p_data->>'patient_ic',v_req.patient_ic);
    begin v_age:=coalesce(nullif(trim(p_data->>'age'),'')::integer,v_req.age);
    exception when invalid_text_representation then raise exception 'Age must be a whole number.';
    end;
    v_months:=case when p_data ? 'age_months' then public.orl_valid_age_months(p_data->>'age_months') else v_req.age_months end;
    parts:=public.orl_age_parts(new_ic,current_date);
    if parts is not null then v_age:=(parts->>'years')::integer; v_months:=(parts->>'months')::integer; end if;
    if v_age is null or v_age not between 0 and 130 then raise exception 'Enter an age between 0 and 130.'; end if;
    update public.orl_requests set
      patient_ic=new_ic,age=v_age,age_months=v_months,mrn=coalesce(p_data->>'mrn',mrn),
      patient_name=coalesce(p_data->>'patient_name',patient_name),
      surgery=coalesce(p_data->>'surgery',surgery),diagnosis=coalesce(p_data->>'diagnosis',diagnosis),
      doctor=initcap(coalesce(p_data->>'doctor',doctor)),specialist=initcap(coalesce(p_data->>'specialist',specialist)),
      sub_specialty=coalesce(p_data->>'sub_specialty',sub_specialty),phone=coalesce(p_data->>'phone',phone),
      remark=coalesce(p_data->>'remark',remark),updated_at=now()
    where id=v_req.id;
  end if;

  if act='CANCEL' and v_user.role='STAFF' then
    if v_req.deletion_status='PENDING' then raise exception 'A cancellation request is already pending review.'; end if;
    reason:=coalesce(nullif(trim(p_data->>'cancel_reason'),''),'Cancellation requested by Staff');
    update public.orl_requests set deletion_status='PENDING',deletion_reason=reason,
      deletion_requested_by=v_user.id,deletion_requested_at=now(),updated_at=now()
    where id=v_req.id;
    insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
    values(v_user.id,v_user.display_name,v_user.role,'STAFF_CANCELLATION_REQUESTED','REQUEST',v_req.id::text,reason);
    return;
  end if;
  if act='CONFIRM' and v_user.role in('ADMIN','WEBMASTER') then
    update public.orl_requests set status='SCHEDULED',updated_at=now() where id=v_req.id;
    update public.orl_ot_slots set status='CONFIRMED',updated_by=v_user.id,updated_at=now() where id=p_slot_id;
  elsif act='CANCEL' then
    reason:=coalesce(nullif(trim(p_data->>'cancel_reason'),''),nullif(trim(p_data->>'remark'),''),'Cancelled by '||v_user.display_name);
    update public.orl_requests set status='CANCELLED',assigned_slot_id=null,
      deletion_status='APPROVED',deletion_reason=reason,deletion_requested_by=v_user.id,
      deletion_requested_at=now(),updated_at=now() where id=v_req.id;
    update public.orl_ot_slots set request_id=null,status='AVAILABLE',updated_by=v_user.id,updated_at=now() where id=p_slot_id;
    if v_slot.slot_type='MAIN' then perform public.orl_compact_main(v_slot.session_id,v_user.id); end if;
  end if;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
  values(v_user.id,v_user.display_name,v_user.role,'SLOT_EDIT_'||act,'REQUEST',v_req.id::text,
    case when act='CANCEL' then 'Patient cancelled by Admin/Webmaster; OT slot released; cancellation record retained'
         when v_user.role='STAFF' then 'Staff updated Surgery / Procedure and Diagnosis'
         else 'Patient details updated' end);
end $$;

create or replace function public.orl_move_postponed_checked(p_session_token uuid,p_from_slot_id uuid,p_to_slot_id uuid,p_data jsonb,p_reason text,p_expected_request_id uuid)
returns text language plpgsql security definer set search_path=public,extensions as $$
declare u public.orl_users%rowtype; a public.orl_ot_slots%rowtype; b public.orl_ot_slots%rowtype; r public.orl_requests%rowtype; old_date date; new_date date; new_status text; safe_data jsonb;
begin
  u:=public.orl_require_session(p_session_token);
  -- Lock both sessions' existing slots in one order before taking patient locks.
  perform 1 from public.orl_ot_slots
  where session_id in(select session_id from public.orl_ot_slots where id in(p_from_slot_id,p_to_slot_id))
  order by id for update;
  select * into a from public.orl_ot_slots where id=p_from_slot_id for update;
  select * into b from public.orl_ot_slots where id=p_to_slot_id for update;
  if p_expected_request_id is null or a.request_id is distinct from p_expected_request_id then
    raise exception 'The selected OT patient has changed. Refresh the schedule and select again.';
  end if;
  if a.id is null or a.request_id is null then raise exception 'Original patient slot not found.'; end if;
  if b.id is null or b.request_id is not null or b.status<>'AVAILABLE' then raise exception 'The selected slot is no longer available.'; end if;
  select * into r from public.orl_requests where id=a.request_id for update;
  if not found then raise exception 'Assigned request not found.'; end if;
  if r.assigned_slot_id is distinct from a.id or r.status='CANCELLED' then
    raise exception 'OT slot links are inconsistent. No changes applied; contact Admin.';
  end if;
  if u.role='STAFF' and r.created_by is distinct from u.id then raise exception 'You do not have access.'; end if;
  if u.role='STAFF' and b.slot_type='SPECIAL' then raise exception 'Special slots are available to Admin and Webmaster only.'; end if;
  safe_data:=coalesce(p_data,'{}'::jsonb);
  if u.role='STAFF' then
    safe_data:=jsonb_strip_nulls(jsonb_build_object(
      'surgery',nullif(trim(p_data->>'surgery'),''),
      'diagnosis',nullif(trim(p_data->>'diagnosis'),'')
    ));
  end if;
  select ot_date into old_date from public.orl_ot_sessions where id=a.session_id;
  select s.ot_date into new_date
  from public.orl_ot_sessions s
  where s.id=b.session_id and s.status='ACTIVE'
    and (s.holiday_override or not exists(
      select 1 from public.orl_holidays h where h.holiday_date=s.ot_date and h.is_active
    ));
  if not found then raise exception 'The selected OT date is closed or blocked by a holiday.'; end if;
  new_status:=case when u.role='STAFF' then 'RESERVED' else 'CONFIRMED' end;
  update public.orl_ot_slots set request_id=null,status='AVAILABLE',updated_by=u.id,updated_at=now() where id=a.id;
  update public.orl_ot_slots set request_id=r.id,status=new_status,updated_by=u.id,updated_at=now() where id=b.id;
  update public.orl_requests set
    age_months=case when safe_data ? 'age_months' then public.orl_valid_age_months(safe_data->>'age_months') else age_months end,
    age=coalesce(nullif(trim(safe_data->>'age'),'')::integer,age),
    patient_ic=coalesce(safe_data->>'patient_ic',patient_ic),mrn=coalesce(safe_data->>'mrn',mrn),
    patient_name=coalesce(safe_data->>'patient_name',patient_name),surgery=coalesce(safe_data->>'surgery',surgery),
    diagnosis=coalesce(safe_data->>'diagnosis',diagnosis),doctor=case when u.role='STAFF' then doctor else initcap(coalesce(safe_data->>'doctor',doctor)) end,
    specialist=case when u.role='STAFF' then specialist else initcap(coalesce(safe_data->>'specialist',specialist)) end,sub_specialty=coalesce(safe_data->>'sub_specialty',sub_specialty),
    phone=coalesce(safe_data->>'phone',phone),remark=coalesce(safe_data->>'remark',remark),assigned_slot_id=b.id,
    status=case when new_status='RESERVED' then 'CONFIRMED' else 'SCHEDULED' end,
    postpone_count=postpone_count+1,
    postpone_history=postpone_history||jsonb_build_array(jsonb_build_object(
      'date',now(),'by',u.display_name,
      'from',old_date||' '||a.slot_type||' Slot '||a.slot_number,
      'to',new_date||' '||b.slot_type||' Slot '||b.slot_number,
      'reason',coalesce(p_reason,''))),updated_at=now()
  where id=r.id;
  if a.slot_type='MAIN' then perform public.orl_compact_main(a.session_id,u.id); end if;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
  values(u.id,u.display_name,u.role,'PATIENT_POSTPONED','REQUEST',r.id::text,old_date||' to '||new_date||' | '||coalesce(p_reason,''));
  return new_status;
end $$;

create or replace function public.orl_get_schedule(
  p_session_token uuid,
  p_year integer,
  p_month integer
)
returns table(
  session_id uuid,ot_date date,day_name text,status text,note text,
  special_title text,holiday_name text,slots jsonb
)
language plpgsql security definer set search_path=public,extensions as $$
declare
  v_user public.orl_users%rowtype;
begin
  v_user:=public.orl_require_session(p_session_token);
  perform public.orl_prepare_schedule(p_session_token,p_year,p_month);

  return query
  select
    s.id,s.ot_date,s.day_name,
    case when h.id is not null and s.status='ACTIVE' and not s.holiday_override
      then 'HOLIDAY' else s.status end,
    s.note,s.special_title,coalesce(h.title,''),
    coalesce(jsonb_agg(jsonb_build_object(
      'id',sl.id,
      'type',sl.slot_type,
      'number',sl.slot_number,
      'status',sl.status,
      'request_id',sl.request_id,
      'request_status',r.status,
      'deletion_status',r.deletion_status,
      'created_by',r.created_by,
      'created_by_role',creator.role,
      'patient_name',r.patient_name,
      'patient_ic',r.patient_ic,
      'age',coalesce((public.orl_age_parts(r.patient_ic,s.ot_date)->>'years')::integer,r.age),
      'age_months',coalesce((public.orl_age_parts(r.patient_ic,s.ot_date)->>'months')::integer,r.age_months),
      'mrn',r.mrn,
      'surgery',r.surgery,
      'diagnosis',r.diagnosis,
      'doctor',initcap(r.doctor),
      'specialist',initcap(r.specialist),
      'sub_specialty',r.sub_specialty,
      'phone',r.phone,
      'remark',r.remark,
      'postpone_count',r.postpone_count
    ) order by case when sl.slot_type='MAIN' then 0 else 1 end,sl.slot_number),'[]'::jsonb)
  from public.orl_ot_sessions s
  left join public.orl_holidays h on h.holiday_date=s.ot_date and h.is_active
  left join public.orl_ot_slots sl
    on sl.session_id=s.id and (v_user.role<>'STAFF' or sl.slot_type='MAIN')
  left join public.orl_requests r on r.id=sl.request_id
  left join public.orl_users creator on creator.id=r.created_by
  where extract(year from s.ot_date)=p_year
    and extract(month from s.ot_date)=p_month
  group by s.id,h.id,h.title
  order by s.ot_date;
end $$;

create or replace function public.orl_find_patient_search(
  p_session_token uuid,
  p_search text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user public.orl_users%rowtype;
  v_query text := trim(coalesce(p_search, ''));
  v_compact text := regexp_replace(lower(trim(coalesce(p_search, ''))), '[^a-z0-9]', '', 'g');
begin
  v_user := public.orl_require_session(p_session_token);

  if length(v_query) < 2 then
    raise exception 'Enter at least 2 characters to search.';
  end if;

  return coalesce((
    with matches as (
      select
        r.*,
        s.ot_date,
        sl.slot_type,
        sl.slot_number,
        case
          when lower(trim(r.mrn)) = lower(v_query) then 0
          when v_compact <> '' and regexp_replace(lower(coalesce(r.patient_ic, '')), '[^a-z0-9]', '', 'g') = v_compact then 1
          when lower(trim(r.patient_name)) = lower(v_query) then 2
          when lower(r.patient_name) like lower(v_query) || '%' then 3
          else 4
        end as match_rank
      from public.orl_requests r
      left join public.orl_ot_slots sl on sl.id = r.assigned_slot_id
      left join public.orl_ot_sessions s on s.id = sl.session_id
      where (v_user.role in ('ADMIN', 'WEBMASTER') or r.created_by = v_user.id)
        and (
          lower(trim(r.mrn)) = lower(v_query)
          or (
            v_compact <> ''
            and regexp_replace(lower(coalesce(r.patient_ic, '')), '[^a-z0-9]', '', 'g') = v_compact
          )
          or (
            length(v_query) >= 3
            and lower(r.patient_name) like '%' || lower(v_query) || '%'
          )
        )
      order by match_rank, r.updated_at desc
      limit 100
    )
    select jsonb_agg(
      jsonb_build_object(
        'id', m.id,
        'request_number', m.request_number,
        'booked_by_name', m.booked_by_name,
        'patient_name', m.patient_name,
        'patient_ic', m.patient_ic,
        'age', coalesce((public.orl_age_parts(m.patient_ic,coalesce(m.ot_date,current_date))->>'years')::integer,m.age),
        'age_months', coalesce((public.orl_age_parts(m.patient_ic,coalesce(m.ot_date,current_date))->>'months')::integer,m.age_months),
        'mrn', m.mrn,
        'surgery', m.surgery,
        'diagnosis', m.diagnosis,
        'doctor', initcap(m.doctor),
        'specialist', initcap(m.specialist),
        'sub_specialty', m.sub_specialty,
        'phone', m.phone,
        'remark', m.remark,
        'status', m.status,
        'postpone_count', m.postpone_count,
        'created_at', m.created_at,
        'ot_date', m.ot_date,
        'slot_type', m.slot_type,
        'slot_number', m.slot_number
      )
      order by m.match_rank, m.updated_at desc
    )
    from matches m
  ), '[]'::jsonb);
end;
$$;

create or replace function public.orl_db_import_locked(p_session_token uuid,p_password text,p_backup jsonb)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare
  u public.orl_users%rowtype; item jsonb; mapped_user uuid; mapped_reviewer uuid; mapped_deleter uuid; booking_name text; section_name text;
  h public.orl_holidays%rowtype; s public.orl_ot_sessions%rowtype;
  r public.orl_requests%rowtype; sl public.orl_ot_slots%rowtype; a public.orl_audit_log%rowtype;
  request_total integer:=0; slot_total integer:=0; audit_total integer:=0; max_seq bigint:=0;
begin
  if not pg_try_advisory_xact_lock(hashtext('orl_db_import')) then
    raise exception 'Restore is already running. Do not queue another Restore.';
  end if;
  u:=public.orl_require_webmaster_password(p_session_token,p_password);
  if jsonb_typeof(p_backup) is distinct from 'object'
     or (p_backup->>'format') is distinct from 'ORLOMS_BACKUP'
     or (p_backup->'version') is distinct from '1'::jsonb then
    raise exception 'Invalid or unsupported ORL backup file.';
  end if;
  -- Every section emitted by the version-1 exporter must be present.
  -- Missing JSON keys yield SQL NULL, so use IS DISTINCT FROM (not <>).
  foreach section_name in array array['users','settings','holidays','ot_sessions','requests','ot_slots','audit_log'] loop
    if jsonb_typeof(p_backup->section_name) is distinct from 'array' then
      raise exception 'Backup file is incomplete: % must be an array.',section_name;
    end if;
    if exists(select 1 from jsonb_array_elements(p_backup->section_name) entry
              where jsonb_typeof(entry) is distinct from 'object') then
      raise exception 'Backup file is invalid: % entries must be objects.',section_name;
    end if;
  end loop;
  if length(p_backup::text)>104857600 then raise exception 'Backup exceeds the 100 MB restore limit.'; end if;
  -- Refuse to overlap any active transaction touching operational tables.
  begin
    lock table public.orl_users,public.orl_sessions,public.orl_settings,public.orl_holidays,
      public.orl_ot_sessions,public.orl_requests,public.orl_ot_slots,public.orl_audit_log
      in access exclusive mode nowait;
  exception when lock_not_available then
    raise exception 'System is busy. Restore was not started. Ask users to finish their actions first.';
  end;
  if exists (
    select 1 from jsonb_to_recordset(p_backup->'requests') as br(id uuid,assigned_slot_id uuid)
    left join jsonb_to_recordset(p_backup->'ot_slots') as bs(id uuid,request_id uuid) on bs.id=br.assigned_slot_id
    where br.assigned_slot_id is not null and (bs.id is null or bs.request_id is distinct from br.id)
  ) or exists (
    select 1 from jsonb_to_recordset(p_backup->'ot_slots') as bs(id uuid,request_id uuid)
    left join jsonb_to_recordset(p_backup->'requests') as br(id uuid,assigned_slot_id uuid) on br.id=bs.request_id
    where bs.request_id is not null and (br.id is null or br.assigned_slot_id is distinct from bs.id)
  ) then raise exception 'Backup slot/request links are inconsistent. No data changed.'; end if;

  delete from public.orl_ot_slots where true;
  delete from public.orl_requests where true;
  delete from public.orl_holidays where true;
  delete from public.orl_ot_sessions where true;
  delete from public.orl_audit_log where true;
  delete from public.orl_settings where true;

  for item in select * from jsonb_array_elements(coalesce(p_backup->'settings','[]'::jsonb)) loop
    insert into public.orl_settings(setting_key,setting_value,updated_at)
    values(item->>'setting_key',item->>'setting_value',coalesce((item->>'updated_at')::timestamptz,now()));
  end loop;

  for item in select * from jsonb_array_elements(coalesce(p_backup->'holidays','[]'::jsonb)) loop
    h:=jsonb_populate_record(null::public.orl_holidays,item);
    select current_user_row.id into mapped_user from public.orl_users current_user_row
      join jsonb_array_elements(coalesce(p_backup->'users','[]'::jsonb)) old_user on lower(old_user->>'username')=lower(current_user_row.username)
      where (old_user->>'id')::uuid=h.created_by limit 1;
    insert into public.orl_holidays(id,holiday_date,title,description,is_active,created_by,created_at,updated_at)
    values(h.id,h.holiday_date,h.title,h.description,h.is_active,mapped_user,h.created_at,h.updated_at);
  end loop;

  for item in select * from jsonb_array_elements(coalesce(p_backup->'ot_sessions','[]'::jsonb)) loop
    s:=jsonb_populate_record(null::public.orl_ot_sessions,item);
    select current_user_row.id into mapped_user from public.orl_users current_user_row
      join jsonb_array_elements(coalesce(p_backup->'users','[]'::jsonb)) old_user on lower(old_user->>'username')=lower(current_user_row.username)
      where (old_user->>'id')::uuid=s.updated_by limit 1;
    insert into public.orl_ot_sessions(id,ot_date,day_name,status,note,special_title,holiday_override,updated_by,created_at,updated_at)
    values(s.id,s.ot_date,s.day_name,s.status,s.note,s.special_title,coalesce(s.holiday_override,false),mapped_user,s.created_at,s.updated_at);
  end loop;

  for item in select * from jsonb_array_elements(p_backup->'requests') loop
    r:=jsonb_populate_record(null::public.orl_requests,item);
    select current_user_row.id into mapped_user from public.orl_users current_user_row
      join jsonb_array_elements(coalesce(p_backup->'users','[]'::jsonb)) old_user on lower(old_user->>'username')=lower(current_user_row.username)
      where (old_user->>'id')::uuid=r.created_by limit 1;
    select cu.id into mapped_reviewer from public.orl_users cu
      join jsonb_array_elements(p_backup->'users') bu on lower(bu->>'username')=lower(cu.username)
      where (bu->>'id')::uuid=r.reviewed_by limit 1;
    select cu.id into mapped_deleter from public.orl_users cu
      join jsonb_array_elements(p_backup->'users') bu on lower(bu->>'username')=lower(cu.username)
      where (bu->>'id')::uuid=r.deletion_requested_by limit 1;
    -- Never substitute the editable Doctor field for the original submitter.
    booking_name:=coalesce(nullif(trim(item->>'booked_by_name'),''),
      (select nullif(trim(ba->>'user_name'),'') from jsonb_array_elements(p_backup->'audit_log') ba
       where ba->>'record_type'='REQUEST' and ba->>'record_id'=r.id::text and ba->>'action'='REQUEST_CREATED'
         and nullif(trim(ba->>'user_name'),'') is not null
       order by (ba->>'occurred_at')::timestamptz limit 1),
      (select nullif(trim(bu->>'display_name'),'') from jsonb_array_elements(p_backup->'users') bu
       where bu->>'id'=r.created_by::text limit 1),'');
    insert into public.orl_requests(booked_by_name,id,request_number,patient_ic,age,age_months,mrn,patient_name,surgery,diagnosis,doctor,specialist,sub_specialty,phone,remark,status,confirmed_at,reviewed_by,reviewed_at,review_note,requested_year,requested_month,postpone_count,postpone_history,deletion_status,deletion_reason,deletion_requested_by,deletion_requested_at,created_by,created_at,updated_at,assigned_slot_id)
    values(booking_name,r.id,r.request_number,r.patient_ic,r.age,r.age_months,r.mrn,r.patient_name,r.surgery,r.diagnosis,r.doctor,r.specialist,r.sub_specialty,r.phone,r.remark,r.status,r.confirmed_at,mapped_reviewer,r.reviewed_at,r.review_note,r.requested_year,r.requested_month,r.postpone_count,r.postpone_history,r.deletion_status,r.deletion_reason,mapped_deleter,r.deletion_requested_at,mapped_user,r.created_at,r.updated_at,null);
    request_total:=request_total+1;
  end loop;

  for item in select * from jsonb_array_elements(p_backup->'ot_slots') loop
    sl:=jsonb_populate_record(null::public.orl_ot_slots,item);
    select current_user_row.id into mapped_user from public.orl_users current_user_row
      join jsonb_array_elements(coalesce(p_backup->'users','[]'::jsonb)) old_user on lower(old_user->>'username')=lower(current_user_row.username)
      where (old_user->>'id')::uuid=sl.updated_by limit 1;
    insert into public.orl_ot_slots(id,session_id,slot_type,slot_number,request_id,status,updated_by,created_at,updated_at)
    values(sl.id,sl.session_id,sl.slot_type,sl.slot_number,sl.request_id,sl.status,mapped_user,sl.created_at,sl.updated_at);
    slot_total:=slot_total+1;
  end loop;

  for item in select * from jsonb_array_elements(p_backup->'requests') loop
    r:=jsonb_populate_record(null::public.orl_requests,item);
    update public.orl_requests set assigned_slot_id=r.assigned_slot_id where id=r.id;
  end loop;

  for item in select * from jsonb_array_elements(coalesce(p_backup->'audit_log','[]'::jsonb)) loop
    a:=jsonb_populate_record(null::public.orl_audit_log,item);
    select current_user_row.id into mapped_user from public.orl_users current_user_row
      join jsonb_array_elements(coalesce(p_backup->'users','[]'::jsonb)) old_user on lower(old_user->>'username')=lower(current_user_row.username)
      where (old_user->>'id')::uuid=a.user_id limit 1;
    insert into public.orl_audit_log(occurred_at,user_id,user_name,user_role,action,record_type,record_id,details)
    values(a.occurred_at,mapped_user,a.user_name,a.user_role,a.action,a.record_type,a.record_id,a.details);
    audit_total:=audit_total+1;
  end loop;

  select coalesce(max((regexp_match(request_number,'([0-9]+)$'))[1]::bigint),0) into max_seq from public.orl_requests;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,details)
  values(u.id,u.display_name,u.role,'DATABASE_BACKUP_IMPORTED','DATABASE',request_total||' requests and '||slot_total||' slots restored');
  -- Never rewind: setval itself does not roll back. A harmless gap is safer.
  perform setval('public.orl_request_number_seq',greatest(max_seq,(select last_value from public.orl_request_number_seq),1),true);
  return jsonb_build_object('status','COMPLETED','requests',request_total,'slots',slot_total,'audit',audit_total);
end $$;
revoke all on function public.orl_create_request(uuid,jsonb) from public;
grant execute on function public.orl_create_request(uuid,jsonb) to anon,authenticated;
revoke all on function public.orl_get_schedule(uuid,integer,integer) from public;
grant execute on function public.orl_get_schedule(uuid,integer,integer) to anon,authenticated;
notify pgrst,'reload schema';
commit;
