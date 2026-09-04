-- ORL OT Management System: complete administration and slot management API
-- Run after 001-005. All browser access remains behind SECURITY DEFINER RPCs.

begin;

create or replace function public.orl_list_holidays(p_session_token uuid)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype;
begin
  v_user:=public.orl_require_session(p_session_token);
  return coalesce((select jsonb_agg(to_jsonb(h) order by h.holiday_date desc) from public.orl_holidays h),'[]'::jsonb);
end $$;

create or replace function public.orl_save_holiday(p_session_token uuid,p_id uuid,p_date date,p_title text,p_description text default '')
returns uuid language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype; v_id uuid;
begin
  v_user:=public.orl_require_session(p_session_token);
  if v_user.role not in ('ADMIN','WEBMASTER') then raise exception 'Admin access required.'; end if;
  if p_id is null then
    insert into public.orl_holidays(holiday_date,title,description,created_by) values(p_date,trim(p_title),coalesce(p_description,''),v_user.id) returning id into v_id;
  else
    update public.orl_holidays set holiday_date=p_date,title=trim(p_title),description=coalesce(p_description,''),updated_at=now() where id=p_id returning id into v_id;
  end if;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details) values(v_user.id,v_user.display_name,v_user.role,'HOLIDAY_SAVED','HOLIDAY',v_id::text,p_date::text||' '||p_title);
  return v_id;
end $$;

create or replace function public.orl_delete_holiday(p_session_token uuid,p_id uuid)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype;
begin
  v_user:=public.orl_require_session(p_session_token);
  if v_user.role not in ('ADMIN','WEBMASTER') then raise exception 'Admin access required.'; end if;
  delete from public.orl_holidays where id=p_id;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details) values(v_user.id,v_user.display_name,v_user.role,'HOLIDAY_DELETED','HOLIDAY',p_id::text,'Holiday/block removed');
end $$;

create or replace function public.orl_get_settings(p_session_token uuid)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype;
begin
  v_user:=public.orl_require_session(p_session_token);
  return coalesce((select jsonb_object_agg(setting_key,setting_value) from public.orl_settings),'{}'::jsonb);
end $$;

create or replace function public.orl_save_settings(p_session_token uuid,p_data jsonb)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype; k text; val text;
begin
  v_user:=public.orl_require_session(p_session_token);
  if v_user.role not in ('ADMIN','WEBMASTER') then raise exception 'Admin access required.'; end if;
  for k,val in select key,value from jsonb_each_text(p_data) loop
    if k not in ('SYSTEM_NAME','START_YEAR','END_YEAR','OT_DAYS','MAIN_SLOTS','SPECIAL_SLOTS') then raise exception 'Invalid setting: %',k; end if;
    insert into public.orl_settings(setting_key,setting_value,updated_at) values(k,val,now()) on conflict(setting_key) do update set setting_value=excluded.setting_value,updated_at=now();
  end loop;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,details) values(v_user.id,v_user.display_name,v_user.role,'SETTINGS_UPDATED','SETTINGS',p_data::text);
end $$;

create or replace function public.orl_list_users(p_session_token uuid)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype;
begin
  v_user:=public.orl_require_session(p_session_token);
  if v_user.role not in ('ADMIN','WEBMASTER') then raise exception 'Admin access required.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',u.id,'username',u.username,'display_name',u.display_name,'role',u.role,'is_active',u.is_active,'created_at',u.created_at) order by u.display_name) from public.orl_users u),'[]'::jsonb);
end $$;

create or replace function public.orl_save_user(p_session_token uuid,p_id uuid,p_username text,p_display_name text,p_role text,p_password text default '',p_active boolean default true)
returns uuid language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype; v_target public.orl_users%rowtype; v_id uuid;
begin
  v_user:=public.orl_require_session(p_session_token);
  if v_user.role not in ('ADMIN','WEBMASTER') then raise exception 'Admin access required.'; end if;
  if p_role not in ('WEBMASTER','ADMIN','STAFF') then raise exception 'Invalid role.'; end if;
  if v_user.role='ADMIN' and p_role='WEBMASTER' then raise exception 'Only Webmaster can manage Webmaster accounts.'; end if;
  if p_id is null then
    if length(coalesce(p_password,''))<6 then raise exception 'Password must contain at least 6 characters.'; end if;
    insert into public.orl_users(username,password_hash,display_name,role,is_active) values(trim(p_username),crypt(p_password,gen_salt('bf',12)),trim(p_display_name),p_role,p_active) returning id into v_id;
  else
    select * into v_target from public.orl_users where id=p_id;
    if not found then raise exception 'User not found.'; end if;
    if v_target.role='WEBMASTER' and v_user.role<>'WEBMASTER' then raise exception 'Only Webmaster can edit this account.'; end if;
    update public.orl_users set username=trim(p_username),display_name=trim(p_display_name),role=p_role,is_active=p_active,password_hash=case when coalesce(p_password,'')='' then password_hash else crypt(p_password,gen_salt('bf',12)) end,updated_at=now() where id=p_id returning id into v_id;
  end if;
  return v_id;
end $$;

create or replace function public.orl_delete_user(p_session_token uuid,p_id uuid)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype; v_target public.orl_users%rowtype;
begin
  v_user:=public.orl_require_session(p_session_token);
  if v_user.role<>'WEBMASTER' then raise exception 'Webmaster access required.'; end if;
  select * into v_target from public.orl_users where id=p_id for update;
  if not found then raise exception 'User not found.'; end if;
  if p_id=v_user.id then raise exception 'You cannot delete the account currently signed in.'; end if;
  if v_target.role='WEBMASTER' and (select count(*) from public.orl_users where role='WEBMASTER' and is_active)=1 then raise exception 'The final active Webmaster account cannot be deleted.'; end if;
  delete from public.orl_users where id=p_id;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details) values(v_user.id,v_user.display_name,v_user.role,'USER_DELETED','USER',p_id::text,v_target.username||' ('||v_target.role||')');
end $$;

create or replace function public.orl_get_audit(p_session_token uuid,p_search text default '')
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype;
begin
  v_user:=public.orl_require_session(p_session_token);
  if v_user.role not in ('ADMIN','WEBMASTER') then raise exception 'Admin access required.'; end if;
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.occurred_at desc) from (select * from public.orl_audit_log a where coalesce(p_search,'')='' or concat_ws(' ',a.user_name,a.action,a.record_type,a.record_id,a.details) ilike '%'||p_search||'%' order by a.occurred_at desc limit 500) x),'[]'::jsonb);
end $$;

create or replace function public.orl_delete_request(p_session_token uuid,p_request_id uuid)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype;
begin
  v_user:=public.orl_require_session(p_session_token);
  if v_user.role<>'WEBMASTER' then raise exception 'Webmaster access required.'; end if;
  update public.orl_ot_slots set request_id=null,status='AVAILABLE',updated_by=v_user.id,updated_at=now() where request_id=p_request_id;
  delete from public.orl_requests where id=p_request_id;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details) values(v_user.id,v_user.display_name,v_user.role,'REQUEST_PERMANENTLY_DELETED','REQUEST',p_request_id::text,'Permanent deletion by Webmaster');
end $$;

create or replace function public.orl_set_postpone_count(p_session_token uuid,p_request_id uuid,p_count integer)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype;
begin
  v_user:=public.orl_require_session(p_session_token);
  if v_user.role<>'WEBMASTER' then raise exception 'Webmaster access required.'; end if;
  if p_count not between 0 and 999 then raise exception 'Invalid postpone count.'; end if;
  update public.orl_requests set postpone_count=p_count,updated_at=now() where id=p_request_id;
end $$;

create or replace function public.orl_swap_slots(p_session_token uuid,p_from uuid,p_to uuid)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype; a public.orl_ot_slots%rowtype; b public.orl_ot_slots%rowtype;
begin
  v_user:=public.orl_require_session(p_session_token);
  if v_user.role not in ('ADMIN','WEBMASTER') then raise exception 'Admin access required.'; end if;
  select * into a from public.orl_ot_slots where id=p_from for update;
  select * into b from public.orl_ot_slots where id=p_to for update;
  if a.session_id<>b.session_id or a.slot_type<>'MAIN' or b.slot_type<>'MAIN' then raise exception 'Only Main slots on the same OT date can be swapped.'; end if;
  update public.orl_ot_slots set request_id=null,status='AVAILABLE' where id in(a.id,b.id);
  update public.orl_ot_slots set request_id=b.request_id,status=case when b.request_id is null then 'AVAILABLE' else b.status end,updated_by=v_user.id,updated_at=now() where id=a.id;
  update public.orl_ot_slots set request_id=a.request_id,status=case when a.request_id is null then 'AVAILABLE' else a.status end,updated_by=v_user.id,updated_at=now() where id=b.id;
  update public.orl_requests set assigned_slot_id=case when id=a.request_id then b.id when id=b.request_id then a.id else assigned_slot_id end,updated_at=now() where id in(a.request_id,b.request_id);
end $$;

grant execute on function public.orl_list_holidays(uuid),public.orl_save_holiday(uuid,uuid,date,text,text),public.orl_delete_holiday(uuid,uuid),public.orl_get_settings(uuid),public.orl_save_settings(uuid,jsonb),public.orl_list_users(uuid),public.orl_save_user(uuid,uuid,text,text,text,text,boolean),public.orl_delete_user(uuid,uuid),public.orl_get_audit(uuid,text),public.orl_delete_request(uuid,uuid),public.orl_set_postpone_count(uuid,uuid,integer),public.orl_swap_slots(uuid,uuid,uuid) to anon,authenticated;

commit;
