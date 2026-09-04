-- ORL OT Management System: portable backup export and atomic restore
begin;

create or replace function public.orl_db_export(p_session_token uuid,p_password text)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare u public.orl_users%rowtype;
begin
  u:=public.orl_require_webmaster_password(p_session_token,p_password);
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,details)
  values(u.id,u.display_name,u.role,'DATABASE_BACKUP_EXPORTED','DATABASE','Encrypted portable backup exported');
  return jsonb_build_object(
    'format','ORLOMS_BACKUP','version',1,'exported_at',now(),'exported_by',u.display_name,
    'users',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'username',username,'display_name',display_name,'role',role)),'[]'::jsonb) from public.orl_users),
    'settings',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.orl_settings x),
    'holidays',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.orl_holidays x),
    'ot_sessions',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.orl_ot_sessions x),
    'requests',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.orl_requests x),
    'ot_slots',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.orl_ot_slots x),
    'audit_log',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.orl_audit_log x)
  );
end $$;

create or replace function public.orl_db_import(p_session_token uuid,p_password text,p_backup jsonb)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare
  u public.orl_users%rowtype; item jsonb; mapped_user uuid;
  h public.orl_holidays%rowtype; s public.orl_ot_sessions%rowtype;
  r public.orl_requests%rowtype; sl public.orl_ot_slots%rowtype; a public.orl_audit_log%rowtype;
  request_total integer:=0; slot_total integer:=0; audit_total integer:=0; max_seq bigint:=0;
begin
  u:=public.orl_require_webmaster_password(p_session_token,p_password);
  if coalesce(p_backup->>'format','')<>'ORLOMS_BACKUP' or coalesce((p_backup->>'version')::integer,0)<>1 then
    raise exception 'Invalid or unsupported ORL backup file.';
  end if;
  if jsonb_typeof(p_backup->'requests')<>'array' or jsonb_typeof(p_backup->'ot_slots')<>'array' then
    raise exception 'Backup file is incomplete.';
  end if;
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
    insert into public.orl_requests(id,request_number,patient_ic,mrn,patient_name,surgery,diagnosis,doctor,specialist,sub_specialty,phone,remark,status,confirmed_at,reviewed_by,reviewed_at,review_note,requested_year,requested_month,postpone_count,postpone_history,deletion_status,deletion_reason,deletion_requested_by,deletion_requested_at,created_by,created_at,updated_at,assigned_slot_id)
    values(r.id,r.request_number,r.patient_ic,r.mrn,r.patient_name,r.surgery,r.diagnosis,r.doctor,r.specialist,r.sub_specialty,r.phone,r.remark,r.status,r.confirmed_at,null,r.reviewed_at,r.review_note,r.requested_year,r.requested_month,r.postpone_count,r.postpone_history,r.deletion_status,r.deletion_reason,null,r.deletion_requested_at,mapped_user,r.created_at,r.updated_at,null);
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
grant execute on function public.orl_db_export(uuid,text),public.orl_db_import(uuid,text,jsonb) to anon,authenticated;
commit;
