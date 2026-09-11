-- ORL OT Management System: custom username/password login
-- Creates short-lived server sessions. The first Webmaster must be created
-- manually by the database owner; no default credential is stored in Git.
-- Passwords are only stored as bcrypt hashes.

begin;

create extension if not exists pgcrypto;

create table if not exists public.orl_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.orl_users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists orl_sessions_token_hash_idx
  on public.orl_sessions(token_hash);

create or replace function public.orl_login(p_username text, p_password text)
returns table (
  session_token uuid,
  user_id uuid,
  username text,
  display_name text,
  role text
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user public.orl_users%rowtype;
  v_token uuid := gen_random_uuid();
begin
  select u.* into v_user
  from public.orl_users u
  where lower(u.username) = lower(trim(p_username))
    and u.is_active = true
  limit 1;

  if not found or v_user.password_hash <> crypt(p_password, v_user.password_hash) then
    return;
  end if;

  delete from public.orl_sessions s
  where s.expires_at < now() or s.user_id = v_user.id;

  insert into public.orl_sessions (user_id, token_hash, expires_at)
  values (
    v_user.id,
    encode(digest(v_token::text, 'sha256'), 'hex'),
    now() + interval '8 hours'
  );

  insert into public.orl_audit_log (user_id, user_name, user_role, action, record_type, record_id, details)
  values (v_user.id, v_user.display_name, v_user.role, 'LOGIN', 'USER', v_user.id::text, 'Custom username login');

  return query
  select v_token, v_user.id, v_user.username, v_user.display_name, v_user.role;
end;
$$;

create or replace function public.orl_current_user(p_session_token uuid)
returns table (
  user_id uuid,
  username text,
  display_name text,
  role text
)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  return query
  select u.id, u.username, u.display_name, u.role
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

create or replace function public.orl_logout(p_session_token uuid)
returns void
language sql
security definer
set search_path = public, extensions
as $$
  delete from public.orl_sessions
  where token_hash = encode(digest(p_session_token::text, 'sha256'), 'hex');
$$;

revoke all on table public.orl_sessions from anon, authenticated;
revoke all on function public.orl_login(text, text) from public;
revoke all on function public.orl_current_user(uuid) from public;
revoke all on function public.orl_logout(uuid) from public;
grant execute on function public.orl_login(text, text) to anon, authenticated;
grant execute on function public.orl_current_user(uuid) to anon, authenticated;
grant execute on function public.orl_logout(uuid) to anon, authenticated;

alter table public.orl_sessions enable row level security;

commit;
