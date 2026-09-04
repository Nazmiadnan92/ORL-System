-- ORL OT Management System: personal account settings and saved themes
begin;

alter table public.orl_users
  add column if not exists theme text not null default 'OCEAN';

alter table public.orl_users drop constraint if exists orl_users_theme_check;
alter table public.orl_users add constraint orl_users_theme_check
  check (theme in ('TAUPE','RUBY','ROSE','PURPLE','OCEAN'));

create or replace function public.orl_get_account_settings(p_session_token uuid)
returns table(user_id uuid,username text,display_name text,role text,theme text)
language plpgsql security definer set search_path=public,extensions as $$
declare u public.orl_users%rowtype;
begin
  u:=public.orl_require_session(p_session_token);
  return query select u.id,u.username,u.display_name,u.role,u.theme;
end $$;

create or replace function public.orl_update_theme(p_session_token uuid,p_theme text)
returns text language plpgsql security definer set search_path=public,extensions as $$
declare u public.orl_users%rowtype; chosen text:=upper(trim(coalesce(p_theme,'')));
begin
  u:=public.orl_require_session(p_session_token);
  if chosen not in ('TAUPE','RUBY','ROSE','PURPLE','OCEAN') then raise exception 'Invalid theme selection.'; end if;
  update public.orl_users set theme=chosen,updated_at=now() where id=u.id;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
  values(u.id,u.display_name,u.role,'ACCOUNT_THEME_CHANGED','USER',u.id::text,'Theme changed to '||chosen);
  return chosen;
end $$;

create or replace function public.orl_change_own_password(p_session_token uuid,p_current_password text,p_new_password text)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare u public.orl_users%rowtype; current_hash text;
begin
  u:=public.orl_require_session(p_session_token);
  select password_hash into current_hash from public.orl_users where id=u.id for update;
  if current_hash<>crypt(coalesce(p_current_password,''),current_hash) then raise exception 'Current password is incorrect.'; end if;
  if length(coalesce(p_new_password,''))<8 then raise exception 'New password must contain at least 8 characters.'; end if;
  if p_current_password=p_new_password then raise exception 'New password must be different from the current password.'; end if;
  update public.orl_users set password_hash=crypt(p_new_password,gen_salt('bf',12)),updated_at=now() where id=u.id;
  delete from public.orl_sessions where user_id=u.id and token_hash<>encode(digest(p_session_token::text,'sha256'),'hex');
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
  values(u.id,u.display_name,u.role,'ACCOUNT_PASSWORD_CHANGED','USER',u.id::text,'User changed own password');
end $$;

revoke all on function public.orl_get_account_settings(uuid),public.orl_update_theme(uuid,text),public.orl_change_own_password(uuid,text,text) from public;
grant execute on function public.orl_get_account_settings(uuid),public.orl_update_theme(uuid,text),public.orl_change_own_password(uuid,text,text) to anon,authenticated;

commit;
