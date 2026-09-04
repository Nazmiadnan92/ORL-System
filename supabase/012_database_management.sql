-- ORL OT Management System: Webmaster-only Database Management
begin;

create or replace function public.orl_require_webmaster_password(p_session_token uuid,p_password text)
returns public.orl_users language plpgsql security definer set search_path=public,extensions as $$
declare u public.orl_users%rowtype;
begin
  u:=public.orl_require_session(p_session_token);
  if u.role<>'WEBMASTER' then raise exception 'Webmaster access required.'; end if;
  if u.password_hash<>crypt(coalesce(p_password,''),u.password_hash) then raise exception 'Incorrect Webmaster password.'; end if;
  return u;
end $$;
revoke all on function public.orl_require_webmaster_password(uuid,text) from public,anon,authenticated;

create or replace function public.orl_db_overview(p_session_token uuid)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare u public.orl_users%rowtype;
begin
  u:=public.orl_require_session(p_session_token); if u.role<>'WEBMASTER' then raise exception 'Webmaster access required.'; end if;
  return jsonb_build_object('patients',(select count(distinct nullif(trim(mrn),'')) from public.orl_requests),'requests',(select count(*) from public.orl_requests),'active_slots',(select count(*) from public.orl_ot_slots where request_id is not null),'cancelled',(select count(*) from public.orl_requests where status='CANCELLED'),'postponed',(select count(*) from public.orl_requests where postpone_count>0),'users',(select count(*) from public.orl_users),'audit',(select count(*) from public.orl_audit_log),'database_bytes',(select sum(pg_total_relation_size(format('%I.%I',schemaname,tablename)::regclass)) from pg_tables where schemaname='public' and tablename like 'orl_%'));
end $$;

create or replace function public.orl_db_cancelled(p_session_token uuid)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare u public.orl_users%rowtype;
begin
  u:=public.orl_require_session(p_session_token); if u.role<>'WEBMASTER' then raise exception 'Webmaster access required.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'request_number',r.request_number,'patient_name',r.patient_name,'patient_ic',r.patient_ic,'mrn',r.mrn,'surgery',r.surgery,'diagnosis',r.diagnosis,'cancelled_at',r.updated_at,'created_at',r.created_at,'postpone_count',r.postpone_count) order by r.updated_at desc) from public.orl_requests r where r.status='CANCELLED'),'[]'::jsonb);
end $$;

create or replace function public.orl_db_find_patient(p_session_token uuid,p_query text)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare u public.orl_users%rowtype; q text:=trim(coalesce(p_query,''));
begin
  u:=public.orl_require_session(p_session_token); if u.role<>'WEBMASTER' then raise exception 'Webmaster access required.'; end if;
  if length(q)<2 then raise exception 'Enter at least 2 characters.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'request_number',r.request_number,'patient_name',r.patient_name,'patient_ic',r.patient_ic,'mrn',r.mrn,'surgery',r.surgery,'diagnosis',r.diagnosis,'status',r.status,'postpone_count',r.postpone_count,'created_at',r.created_at,'ot_date',s.ot_date,'slot_type',sl.slot_type,'slot_number',sl.slot_number) order by r.created_at desc) from public.orl_requests r left join public.orl_ot_slots sl on sl.id=r.assigned_slot_id left join public.orl_ot_sessions s on s.id=sl.session_id where r.mrn ilike '%'||q||'%' or r.patient_ic ilike '%'||q||'%' or r.patient_name ilike '%'||q||'%' or r.request_number ilike '%'||q||'%'),'[]'::jsonb);
end $$;

create or replace function public.orl_db_duplicates(p_session_token uuid)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare u public.orl_users%rowtype;
begin
  u:=public.orl_require_session(p_session_token); if u.role<>'WEBMASTER' then raise exception 'Webmaster access required.'; end if;
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.record_count desc,x.match_value) from (
    select 'MRN' match_type,trim(mrn) match_value,count(*) record_count,jsonb_agg(jsonb_build_object('id',id,'request_number',request_number,'patient_name',patient_name,'patient_ic',patient_ic,'mrn',mrn,'surgery',surgery,'diagnosis',diagnosis,'status',status,'created_at',created_at) order by created_at) records from public.orl_requests where trim(mrn)<>'' group by trim(mrn) having count(*)>1
    union all
    select 'PATIENT IC',trim(patient_ic),count(*),jsonb_agg(jsonb_build_object('id',id,'request_number',request_number,'patient_name',patient_name,'patient_ic',patient_ic,'mrn',mrn,'surgery',surgery,'diagnosis',diagnosis,'status',status,'created_at',created_at) order by created_at) from public.orl_requests where trim(patient_ic)<>'' group by trim(patient_ic) having count(*)>1)x),'[]'::jsonb);
end $$;

create or replace function public.orl_db_health(p_session_token uuid)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare u public.orl_users%rowtype;
begin
  u:=public.orl_require_session(p_session_token); if u.role<>'WEBMASTER' then raise exception 'Webmaster access required.'; end if;
  return jsonb_build_object(
    'scheduled_without_slot',(select count(*) from public.orl_requests where status='SCHEDULED' and assigned_slot_id is null),
    'slot_request_mismatch',(select count(*) from public.orl_ot_slots sl join public.orl_requests r on r.id=sl.request_id where r.assigned_slot_id is distinct from sl.id),
    'available_with_patient',(select count(*) from public.orl_ot_slots where status='AVAILABLE' and request_id is not null),
    'occupied_marked_available',(select count(*) from public.orl_ot_slots where request_id is null and status<>'AVAILABLE'),
    'reserved_nonconfirmed_request',(select count(*) from public.orl_ot_slots sl join public.orl_requests r on r.id=sl.request_id where sl.status='RESERVED' and r.status<>'CONFIRMED'),
    'status',case when exists(select 1 from public.orl_requests where status='SCHEDULED' and assigned_slot_id is null) or exists(select 1 from public.orl_ot_slots sl join public.orl_requests r on r.id=sl.request_id where r.assigned_slot_id is distinct from sl.id) or exists(select 1 from public.orl_ot_slots where (status='AVAILABLE')<>(request_id is null)) then 'WARNING' else 'HEALTHY' end);
end $$;

create or replace function public.orl_db_remove_patient(p_session_token uuid,p_password text,p_mode text,p_value text)
returns integer language plpgsql security definer set search_path=public,extensions as $$
declare u public.orl_users%rowtype; rec record; ids uuid[]; removed integer;
begin
  u:=public.orl_require_webmaster_password(p_session_token,p_password);
  if upper(p_mode)='REQUEST' then select array_agg(id) into ids from public.orl_requests where id=p_value::uuid;
  elsif upper(p_mode)='MRN' then select array_agg(id) into ids from public.orl_requests where lower(trim(mrn))=lower(trim(p_value));
  else raise exception 'Invalid removal mode.'; end if;
  if ids is null then raise exception 'No matching patient records found.'; end if;
  for rec in select distinct sl.session_id from public.orl_ot_slots sl where sl.request_id=any(ids) loop
    update public.orl_ot_slots set request_id=null,status='AVAILABLE',updated_by=u.id,updated_at=now() where request_id=any(ids) and session_id=rec.session_id;
    perform public.orl_compact_main(rec.session_id,u.id);
  end loop;
  delete from public.orl_requests where id=any(ids); get diagnostics removed=row_count;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details) values(u.id,u.display_name,u.role,'DATABASE_PATIENT_REMOVAL','DATABASE',upper(p_mode)||':'||p_value,removed||' patient request record(s) permanently removed');
  return removed;
end $$;

create or replace function public.orl_db_repair(p_session_token uuid,p_password text)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare u public.orl_users%rowtype; fixed integer:=0; n integer; rec record;
begin
  u:=public.orl_require_webmaster_password(p_session_token,p_password);
  update public.orl_ot_slots set request_id=null,status='AVAILABLE',updated_by=u.id,updated_at=now() where request_id is null and status<>'AVAILABLE'; get diagnostics n=row_count; fixed:=fixed+n;
  update public.orl_ot_slots set status='CONFIRMED',updated_by=u.id,updated_at=now() where request_id is not null and status='AVAILABLE'; get diagnostics n=row_count; fixed:=fixed+n;
  update public.orl_requests r set assigned_slot_id=sl.id,updated_at=now() from public.orl_ot_slots sl where sl.request_id=r.id and r.assigned_slot_id is distinct from sl.id; get diagnostics n=row_count; fixed:=fixed+n;
  update public.orl_requests set status='APPROVED',updated_at=now() where status='SCHEDULED' and assigned_slot_id is null; get diagnostics n=row_count; fixed:=fixed+n;
  for rec in select distinct session_id from public.orl_ot_slots loop perform public.orl_compact_main(rec.session_id,u.id); end loop;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,details) values(u.id,u.display_name,u.role,'DATABASE_REPAIR','DATABASE',fixed||' inconsistency record(s) repaired; Main slots compacted');
  return jsonb_build_object('fixed',fixed,'status','COMPLETED');
end $$;

create or replace function public.orl_db_clean_audit(p_session_token uuid,p_password text,p_before date)
returns integer language plpgsql security definer set search_path=public,extensions as $$
declare u public.orl_users%rowtype; removed integer;
begin
  u:=public.orl_require_webmaster_password(p_session_token,p_password);
  delete from public.orl_audit_log where occurred_at<p_before::timestamptz; get diagnostics removed=row_count;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,details) values(u.id,u.display_name,u.role,'AUDIT_CLEANUP','DATABASE',removed||' audit record(s) before '||p_before||' removed');
  return removed;
end $$;

create or replace function public.orl_db_export(p_session_token uuid,p_password text)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare u public.orl_users%rowtype;
begin
  u:=public.orl_require_webmaster_password(p_session_token,p_password);
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,details) values(u.id,u.display_name,u.role,'DATABASE_BACKUP_EXPORTED','DATABASE','JSON backup exported');
  return jsonb_build_object('exported_at',now(),'exported_by',u.display_name,'users',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'username',username,'display_name',display_name,'role',role,'is_active',is_active,'created_at',created_at)),'[]'::jsonb) from public.orl_users),'settings',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.orl_settings x),'holidays',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.orl_holidays x),'ot_sessions',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.orl_ot_sessions x),'requests',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.orl_requests x),'ot_slots',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.orl_ot_slots x),'audit_log',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.orl_audit_log x));
end $$;

grant execute on function public.orl_db_overview(uuid),public.orl_db_find_patient(uuid,text),public.orl_db_cancelled(uuid),public.orl_db_duplicates(uuid),public.orl_db_health(uuid),public.orl_db_remove_patient(uuid,text,text,text),public.orl_db_repair(uuid,text),public.orl_db_clean_audit(uuid,text,date),public.orl_db_export(uuid,text) to anon,authenticated;
commit;
