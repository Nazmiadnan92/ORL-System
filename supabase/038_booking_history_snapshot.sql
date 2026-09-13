-- STAGED ONLY: preserve booking attribution independently of account lifetime.
begin;
alter table public.orl_requests add column booked_by_name text;
-- Prefer the historical creation audit, then the currently linked account.
update public.orl_requests r set booked_by_name=coalesce(
 (select nullif(trim(a.user_name),'') from public.orl_audit_log a
  where a.record_type='REQUEST' and a.record_id=r.id::text and a.action='REQUEST_CREATED'
    and nullif(trim(a.user_name),'') is not null order by a.occurred_at,a.id limit 1),
 (select nullif(trim(u.display_name),'') from public.orl_users u where u.id=r.created_by),'')
where booked_by_name is null;
alter table public.orl_requests alter column booked_by_name set not null;
create or replace function public.orl_capture_booking_name()
returns trigger language plpgsql security definer set search_path=public,extensions as $capture$
begin
 if TG_OP='UPDATE' then
   new.booked_by_name:=old.booked_by_name;
 elsif new.booked_by_name is null then
   new.booked_by_name:=coalesce((select display_name from public.orl_users where id=new.created_by),'');
 end if;
 return new;
end $capture$;
revoke all on function public.orl_capture_booking_name() from public,anon,authenticated;
create trigger orl_booking_name_snapshot before insert or update on public.orl_requests
for each row execute function public.orl_capture_booking_name();

create or replace function public.orl_db_import(p_session_token uuid,p_password text,p_backup jsonb)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare
  u public.orl_users%rowtype; item jsonb; mapped_user uuid; booking_name text; section_name text;
  h public.orl_holidays%rowtype; s public.orl_ot_sessions%rowtype;
  r public.orl_requests%rowtype; sl public.orl_ot_slots%rowtype; a public.orl_audit_log%rowtype;
  request_total integer:=0; slot_total integer:=0; audit_total integer:=0; max_seq bigint:=0;
begin
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
  perform pg_advisory_xact_lock(hashtext('orl_db_import'));

  delete from public.orl_ot_slots;
  delete from public.orl_requests;
  delete from public.orl_holidays;
  delete from public.orl_ot_sessions;
  delete from public.orl_audit_log;
  delete from public.orl_settings;

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
    insert into public.orl_ot_sessions(id,ot_date,day_name,status,note,special_title,updated_by,created_at,updated_at)
    values(s.id,s.ot_date,s.day_name,s.status,s.note,s.special_title,mapped_user,s.created_at,s.updated_at);
  end loop;

  for item in select * from jsonb_array_elements(p_backup->'requests') loop
    r:=jsonb_populate_record(null::public.orl_requests,item);
    select current_user_row.id into mapped_user from public.orl_users current_user_row
      join jsonb_array_elements(coalesce(p_backup->'users','[]'::jsonb)) old_user on lower(old_user->>'username')=lower(current_user_row.username)
      where (old_user->>'id')::uuid=r.created_by limit 1;
    -- Never substitute the editable Doctor field for the original submitter.
    booking_name:=coalesce(nullif(trim(item->>'booked_by_name'),''),
      (select nullif(trim(ba->>'user_name'),'') from jsonb_array_elements(p_backup->'audit_log') ba
       where ba->>'record_type'='REQUEST' and ba->>'record_id'=r.id::text and ba->>'action'='REQUEST_CREATED'
         and nullif(trim(ba->>'user_name'),'') is not null
       order by (ba->>'occurred_at')::timestamptz limit 1),
      (select nullif(trim(bu->>'display_name'),'') from jsonb_array_elements(p_backup->'users') bu
       where bu->>'id'=r.created_by::text limit 1),'');
    insert into public.orl_requests(booked_by_name,id,request_number,patient_ic,age,mrn,patient_name,surgery,diagnosis,doctor,specialist,sub_specialty,phone,remark,status,confirmed_at,reviewed_by,reviewed_at,review_note,requested_year,requested_month,postpone_count,postpone_history,deletion_status,deletion_reason,deletion_requested_by,deletion_requested_at,created_by,created_at,updated_at,assigned_slot_id)
    values(booking_name,r.id,r.request_number,r.patient_ic,r.age,r.mrn,r.patient_name,r.surgery,r.diagnosis,r.doctor,r.specialist,r.sub_specialty,r.phone,r.remark,r.status,r.confirmed_at,null,r.reviewed_at,r.review_note,r.requested_year,r.requested_month,r.postpone_count,r.postpone_history,r.deletion_status,r.deletion_reason,null,r.deletion_requested_at,mapped_user,r.created_at,r.updated_at,null);
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
  perform setval('public.orl_request_number_seq',greatest(max_seq,1),true);
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,details)
  values(u.id,u.display_name,u.role,'DATABASE_BACKUP_IMPORTED','DATABASE',request_total||' requests and '||slot_total||' slots restored');
  return jsonb_build_object('status','COMPLETED','requests',request_total,'slots',slot_total,'audit',audit_total);
end $$;

revoke all on function public.orl_db_import(uuid,text,jsonb) from public;
grant execute on function public.orl_db_import(uuid,text,jsonb) to anon,authenticated;

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
        'age', m.age,
        'mrn', m.mrn,
        'surgery', m.surgery,
        'diagnosis', m.diagnosis,
        'doctor', m.doctor,
        'specialist', m.specialist,
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

revoke all on function public.orl_find_patient_search(uuid, text) from public;
grant execute on function public.orl_find_patient_search(uuid, text) to anon, authenticated;


notify pgrst,'reload schema';
commit;
