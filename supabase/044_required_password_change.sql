-- Require selected users to set a compliant password at their next login.
-- Adds no patient-data changes. Existing accounts remain unchanged by default.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $guard$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='orl_users' and column_name='must_change_password'
  ) then
    raise exception 'STOP: migration 044 appears to be installed already. No changes applied.';
  end if;
  if to_regprocedure('public.orl_login(text,text)') is null
     or position('is distinct from crypt' in replace((select prosrc from pg_proc where oid='public.orl_login(text,text)'::regprocedure),chr(13),''))=0 then
    raise exception 'STOP: login function differs from the tested migration-030 baseline. No changes applied.';
  end if;
  if to_regprocedure('public.orl_get_year_month_counts(uuid,integer)') is null
     or position('main_available' in (select prosrc from pg_proc where oid='public.orl_get_year_month_counts(uuid,integer)'::regprocedure))=0 then
    raise exception 'STOP: production does not appear to include migration 043. No changes applied.';
  end if;
end;
$guard$;

alter table public.orl_users
  add column if not exists must_change_password boolean not null default false;

create or replace function public.orl_password_policy_error(p_password text)
returns text
language plpgsql
immutable
set search_path = public, extensions
as $$
begin
  if p_password is null or char_length(p_password) < 8 or char_length(p_password) > 14 then
    return 'Password must contain 8 to 14 characters.';
  elsif p_password !~ '[A-Z]' then
    return 'Password must include at least one uppercase letter.';
  elsif p_password !~ '[a-z]' then
    return 'Password must include at least one lowercase letter.';
  elsif p_password !~ '[0-9]' then
    return 'Password must include at least one number.';
  end if;
  return null;
end;
$$;

create or replace function public.orl_require_session(p_session_token uuid)
returns public.orl_users
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user public.orl_users%rowtype;
begin
  select u.* into v_user
  from public.orl_sessions s
  join public.orl_users u on u.id = s.user_id
  where s.token_hash = encode(digest(p_session_token::text, 'sha256'), 'hex')
    and s.expires_at > now()
    and u.is_active = true;

  if not found then
    raise exception 'Your session has expired. Please sign in again.' using errcode = '28000';
  end if;
  if v_user.must_change_password then
    raise exception 'Password change required before accessing the system.' using errcode = 'P0001';
  end if;
  return v_user;
end;
$$;

drop function if exists public.orl_login(text, text);
create function public.orl_login(p_username text, p_password text)
returns table (
  session_token uuid,
  user_id uuid,
  username text,
  display_name text,
  role text,
  must_change_password boolean
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user public.orl_users%rowtype;
  v_token uuid := gen_random_uuid();
begin
  if p_username is null or btrim(p_username) = ''
     or p_password is null or p_password = '' then
    return;
  end if;

  select u.* into v_user
  from public.orl_users u
  where lower(u.username) = lower(btrim(p_username))
    and u.is_active = true
  limit 1;

  if not found or v_user.password_hash is distinct from crypt(p_password, v_user.password_hash) then
    return;
  end if;

  delete from public.orl_sessions s
  where s.expires_at < now() or s.user_id = v_user.id;

  insert into public.orl_sessions (user_id, token_hash, expires_at)
  values (v_user.id, encode(digest(v_token::text, 'sha256'), 'hex'), now() + interval '8 hours');

  insert into public.orl_audit_log (user_id, user_name, user_role, action, record_type, record_id, details)
  values (v_user.id, v_user.display_name, v_user.role, 'LOGIN', 'USER', v_user.id::text,
          case when v_user.must_change_password then 'Login pending required password change' else 'Custom username login' end);

  return query
  select v_token, v_user.id, v_user.username, v_user.display_name, v_user.role, v_user.must_change_password;
end;
$$;

drop function if exists public.orl_current_user(uuid);
create function public.orl_current_user(p_session_token uuid)
returns table (
  user_id uuid,
  username text,
  display_name text,
  role text,
  must_change_password boolean
)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  return query
  select u.id, u.username, u.display_name, u.role, u.must_change_password
  from public.orl_sessions s
  join public.orl_users u on u.id = s.user_id
  where s.token_hash = encode(digest(p_session_token::text, 'sha256'), 'hex')
    and s.expires_at > now()
    and u.is_active = true;

  update public.orl_sessions
  set last_seen_at = now()
  where token_hash = encode(digest(p_session_token::text, 'sha256'), 'hex')
    and expires_at > now();
end;
$$;

create or replace function public.orl_list_users(p_session_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user public.orl_users%rowtype;
begin
  v_user := public.orl_require_session(p_session_token);
  if v_user.role not in ('ADMIN','WEBMASTER') then
    raise exception 'Admin access required.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', u.id,
      'username', u.username,
      'display_name', u.display_name,
      'role', u.role,
      'is_active', u.is_active,
      'must_change_password', u.must_change_password,
      'created_at', u.created_at
    ) order by u.display_name)
    from public.orl_users u
  ), '[]'::jsonb);
end;
$$;

create or replace function public.orl_save_user_v2(
  p_session_token uuid,
  p_id uuid,
  p_username text,
  p_display_name text,
  p_role text,
  p_password text default '',
  p_active boolean default true,
  p_require_password_change boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user public.orl_users%rowtype;
  v_target public.orl_users%rowtype;
  v_id uuid;
  v_error text;
  v_has_password boolean := coalesce(p_password, '') <> '';
begin
  v_user := public.orl_require_session(p_session_token);
  if v_user.role not in ('ADMIN','WEBMASTER') then
    raise exception 'Admin access required.';
  end if;
  if p_role not in ('WEBMASTER','ADMIN','STAFF') then
    raise exception 'Invalid role.';
  end if;
  if v_user.role = 'ADMIN' and p_role = 'WEBMASTER' then
    raise exception 'Only Webmaster can manage Webmaster accounts.';
  end if;

  if p_id is null then
    if not v_has_password or char_length(p_password) < 6 then
      raise exception 'A temporary password must contain at least 6 characters.';
    end if;
    if not coalesce(p_require_password_change, false) then
      v_error := public.orl_password_policy_error(p_password);
      if v_error is not null then raise exception '%', v_error; end if;
    end if;
    insert into public.orl_users
      (username, password_hash, display_name, role, is_active, must_change_password)
    values
      (btrim(p_username), crypt(p_password, gen_salt('bf',12)), btrim(p_display_name), p_role,
       coalesce(p_active,true), coalesce(p_require_password_change,false))
    returning id into v_id;
  else
    select * into v_target from public.orl_users where id = p_id for update;
    if not found then raise exception 'User not found.'; end if;
    if v_target.role = 'WEBMASTER' and v_user.role <> 'WEBMASTER' then
      raise exception 'Only Webmaster can edit this account.';
    end if;
    if v_has_password then
      if coalesce(p_require_password_change,false) then
        if char_length(p_password) < 6 then
          raise exception 'A temporary password must contain at least 6 characters.';
        end if;
      else
        v_error := public.orl_password_policy_error(p_password);
        if v_error is not null then raise exception '%', v_error; end if;
      end if;
    end if;

    update public.orl_users
    set username = btrim(p_username),
        display_name = btrim(p_display_name),
        role = p_role,
        is_active = coalesce(p_active,true),
        must_change_password = coalesce(p_require_password_change,false),
        password_hash = case when v_has_password then crypt(p_password,gen_salt('bf',12)) else password_hash end,
        updated_at = now()
    where id = p_id
    returning id into v_id;

    if v_has_password or coalesce(p_require_password_change,false) or not coalesce(p_active,true) then
      delete from public.orl_sessions where user_id = p_id;
    end if;
  end if;

  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
  values(v_user.id,v_user.display_name,v_user.role,
         case when p_id is null then 'USER_CREATED' else 'USER_UPDATED' end,
         'USER',v_id::text,
         btrim(p_username)||' ('||p_role||')' ||
         case when coalesce(p_require_password_change,false) then '; password change required' else '' end);
  return v_id;
end;
$$;

create or replace function public.orl_change_own_password(
  p_session_token uuid,
  p_current_password text,
  p_new_password text
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  u public.orl_users%rowtype;
  current_hash text;
  v_error text;
begin
  u := public.orl_require_session(p_session_token);
  select password_hash into current_hash from public.orl_users where id=u.id for update;
  if current_hash is distinct from crypt(coalesce(p_current_password,''),current_hash) then
    raise exception 'Current password is incorrect.';
  end if;
  v_error := public.orl_password_policy_error(p_new_password);
  if v_error is not null then raise exception '%', v_error; end if;
  if current_hash = crypt(p_new_password,current_hash) then
    raise exception 'New password must be different from the current password.';
  end if;
  update public.orl_users
  set password_hash=crypt(p_new_password,gen_salt('bf',12)),must_change_password=false,updated_at=now()
  where id=u.id;
  delete from public.orl_sessions
  where user_id=u.id and token_hash<>encode(digest(p_session_token::text,'sha256'),'hex');
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
  values(u.id,u.display_name,u.role,'ACCOUNT_PASSWORD_CHANGED','USER',u.id::text,'User changed own password');
end;
$$;

create or replace function public.orl_complete_required_password_change(
  p_session_token uuid,
  p_new_password text
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  u public.orl_users%rowtype;
  v_error text;
begin
  select usr.* into u
  from public.orl_sessions s
  join public.orl_users usr on usr.id=s.user_id
  where s.token_hash=encode(digest(p_session_token::text,'sha256'),'hex')
    and s.expires_at>now()
    and usr.is_active=true
  for update of usr;
  if not found then
    raise exception 'Your session has expired. Please sign in again.' using errcode='28000';
  end if;
  if not u.must_change_password then
    raise exception 'A required password change is not pending for this account.';
  end if;
  v_error := public.orl_password_policy_error(p_new_password);
  if v_error is not null then raise exception '%', v_error; end if;
  if u.password_hash = crypt(p_new_password,u.password_hash) then
    raise exception 'New password must be different from the temporary password.';
  end if;

  update public.orl_users
  set password_hash=crypt(p_new_password,gen_salt('bf',12)),must_change_password=false,updated_at=now()
  where id=u.id;
  delete from public.orl_sessions where user_id=u.id;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
  values(u.id,u.display_name,u.role,'REQUIRED_PASSWORD_CHANGED','USER',u.id::text,'Required password change completed');
end;
$$;

revoke all on function public.orl_password_policy_error(text) from public, anon, authenticated;
revoke all on function public.orl_login(text,text) from public, anon, authenticated;
revoke all on function public.orl_current_user(uuid) from public, anon, authenticated;
revoke all on function public.orl_list_users(uuid) from public, anon, authenticated;
revoke all on function public.orl_save_user_v2(uuid,uuid,text,text,text,text,boolean,boolean) from public, anon, authenticated;
revoke all on function public.orl_change_own_password(uuid,text,text) from public, anon, authenticated;
revoke all on function public.orl_complete_required_password_change(uuid,text) from public, anon, authenticated;

grant execute on function public.orl_login(text,text) to anon,authenticated;
grant execute on function public.orl_current_user(uuid) to anon,authenticated;
grant execute on function public.orl_list_users(uuid) to anon,authenticated;
grant execute on function public.orl_save_user_v2(uuid,uuid,text,text,text,text,boolean,boolean) to anon,authenticated;
grant execute on function public.orl_change_own_password(uuid,text,text) to anon,authenticated;
grant execute on function public.orl_complete_required_password_change(uuid,text) to anon,authenticated;

notify pgrst, 'reload schema';
commit;
