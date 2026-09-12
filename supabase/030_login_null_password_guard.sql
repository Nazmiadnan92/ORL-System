-- Phase 1 login hardening. Production installation confirmed by operator.
-- Phase 1: reject absent credentials without changing patient/operational data.
-- Requires 001-029. Preserve the existing RPC signature and successful-login flow.
begin;

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
  -- SQL comparisons against NULL do not evaluate to true. Reject it explicitly.
  -- Do not trim the password used for crypt(): spaces can be intentional.
  if p_username is null or btrim(p_username) = ''
     or p_password is null or p_password = '' then
    return;
  end if;

  select u.* into v_user
  from public.orl_users u
  where lower(u.username) = lower(trim(p_username))
    and u.is_active = true
  limit 1;

  if not found then
    return;
  end if;

  -- Fail closed even if the hashing result is unexpectedly NULL.
  if v_user.password_hash is distinct from crypt(p_password, v_user.password_hash) then
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

revoke all on function public.orl_login(text, text) from public, anon, authenticated;
grant execute on function public.orl_login(text, text) to anon, authenticated;

notify pgrst, 'reload schema';
commit;


