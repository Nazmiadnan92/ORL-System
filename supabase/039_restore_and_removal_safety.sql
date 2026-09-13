-- STAGED ONLY: Phase 9 Restore metadata/concurrency and permanent removal safety.
-- Apply after candidate 038. No Restore or deletion is executed by this migration.
begin;
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
    insert into public.orl_requests(booked_by_name,id,request_number,patient_ic,age,mrn,patient_name,surgery,diagnosis,doctor,specialist,sub_specialty,phone,remark,status,confirmed_at,reviewed_by,reviewed_at,review_note,requested_year,requested_month,postpone_count,postpone_history,deletion_status,deletion_reason,deletion_requested_by,deletion_requested_at,created_by,created_at,updated_at,assigned_slot_id)
    values(booking_name,r.id,r.request_number,r.patient_ic,r.age,r.mrn,r.patient_name,r.surgery,r.diagnosis,r.doctor,r.specialist,r.sub_specialty,r.phone,r.remark,r.status,r.confirmed_at,mapped_reviewer,r.reviewed_at,r.review_note,r.requested_year,r.requested_month,r.postpone_count,r.postpone_history,r.deletion_status,r.deletion_reason,mapped_deleter,r.deletion_requested_at,mapped_user,r.created_at,r.updated_at,null);
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

-- A small entry point avoids waiting on row-type compilation during another Restore.
create or replace function public.orl_db_import(p_session_token uuid,p_password text,p_backup jsonb)
returns jsonb language plpgsql security definer set search_path=public,extensions as $entry$
begin
 if not pg_try_advisory_xact_lock(hashtext('orl_db_import')) then
   raise exception 'Restore is already running. Do not queue another Restore.';
 end if;
 return public.orl_db_import_locked(p_session_token,p_password,p_backup);
end $entry$;
revoke all on function public.orl_db_import_locked(uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.orl_db_import(uuid,text,jsonb) from public;
grant execute on function public.orl_db_import(uuid,text,jsonb) to anon,authenticated;

create or replace function public.orl_db_remove_patient(p_session_token uuid,p_password text,p_mode text,p_value text)
returns integer language plpgsql security definer set search_path=public,extensions as $$
declare u public.orl_users%rowtype; rec record; ids uuid[]; removed integer;
begin
  u:=public.orl_require_webmaster_password(p_session_token,p_password);
  -- Rare destructive operation: fail instead of racing normal writers.
  begin
    lock table public.orl_requests,public.orl_ot_slots in access exclusive mode nowait;
  exception when lock_not_available then
    raise exception 'System is busy. No patient removed. Refresh and retry after other actions finish.';
  end;
  if upper(p_mode)='REQUEST' then select array_agg(id) into ids from public.orl_requests where id=p_value::uuid;
  elsif upper(p_mode)='MRN' then select array_agg(id) into ids from public.orl_requests where lower(trim(mrn))=lower(trim(p_value));
  else raise exception 'Invalid removal mode.'; end if;
  if ids is null then raise exception 'No matching patient records found.'; end if;
  update public.orl_requests set assigned_slot_id=null,updated_at=now() where id=any(ids);
  for rec in select distinct sl.session_id from public.orl_ot_slots sl where sl.request_id=any(ids) loop
    update public.orl_ot_slots set request_id=null,status='AVAILABLE',updated_by=u.id,updated_at=now() where request_id=any(ids) and session_id=rec.session_id;
    perform public.orl_compact_main(rec.session_id,u.id);
  end loop;
  delete from public.orl_requests where id=any(ids); get diagnostics removed=row_count;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details) values(u.id,u.display_name,u.role,'DATABASE_PATIENT_REMOVAL','DATABASE',upper(p_mode)||':'||p_value,removed||' patient request record(s) permanently removed');
  return removed;
end $$;

create or replace function public.orl_delete_request(p_session_token uuid,p_request_id uuid)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype;
begin
  v_user:=public.orl_require_session(p_session_token);
  if v_user.role<>'WEBMASTER' then raise exception 'Webmaster access required.'; end if;
  begin
    lock table public.orl_requests,public.orl_ot_slots in access exclusive mode nowait;
  exception when lock_not_available then
    raise exception 'System is busy. No patient removed. Refresh and retry after other actions finish.';
  end;
  if not exists(select 1 from public.orl_requests where id=p_request_id) then raise exception 'Request not found.'; end if;
  update public.orl_ot_slots set request_id=null,status='AVAILABLE',updated_by=v_user.id,updated_at=now() where request_id=p_request_id;
  delete from public.orl_requests where id=p_request_id;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details) values(v_user.id,v_user.display_name,v_user.role,'REQUEST_PERMANENTLY_DELETED','REQUEST',p_request_id::text,'Permanent deletion by Webmaster');
end $$;


revoke all on function public.orl_db_remove_patient(uuid,text,text,text), public.orl_delete_request(uuid,uuid) from public;
grant execute on function public.orl_db_remove_patient(uuid,text,text,text), public.orl_delete_request(uuid,uuid) to anon,authenticated;
notify pgrst,'reload schema';
commit;
