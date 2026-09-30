do $$
begin
  if exists ((select * from public.orl_requests except select * from prior_requests)
    union all (select * from prior_requests except select * from public.orl_requests)) then
    raise exception 'FAIL: original patient data changed.';
  end if;
  if exists(select 1 from prior_functions old left join pg_proc p on p.oid=old.oid
    where p.oid is null or p.prosrc is distinct from old.prosrc or p.proacl is distinct from old.proacl
      or p.proconfig is distinct from old.proconfig) then
    raise exception 'FAIL: existing workflow changed.';
  end if;
end $$;
begin;
insert into public.orl_users(id,username,password_hash,display_name,role) values
 ('11111111-aaaa-4111-8111-111111111111','synthetic_wm','unused-test-hash','Synthetic WM','WEBMASTER'),
 ('22222222-aaaa-4222-8222-222222222222','synthetic_admin','unused-test-hash','Synthetic Admin','ADMIN'),
 ('33333333-aaaa-4333-8333-333333333333','synthetic_staff','unused-test-hash','Synthetic Staff','STAFF');
insert into public.orl_sessions(user_id,token_hash,expires_at)
 select id,encode(extensions.digest(id::text,'sha256'),'hex'),now()+interval '1 hour'
 from public.orl_users where username like 'synthetic_%';

do $$
declare r text; u uuid; payload jsonb;
begin
  foreach r in array array['anon','authenticated','service_role'] loop
    if has_schema_privilege(r,'orl_private','USAGE')
       or has_schema_privilege(r,'orl_private','CREATE')
       or has_table_privilege(r,'orl_private.request_identity','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      raise exception 'FAIL: private identity grants for %',r;
    end if;
  end loop;
  foreach r in array array['anon','authenticated'] loop
    if has_function_privilege(r,'public.orl_ic_foundation_probe(uuid)','EXECUTE') then
      raise exception 'FAIL: public probe permission for %',r;
    end if;
  end loop;
  if not (select relrowsecurity and relforcerowsecurity from pg_class where oid='orl_private.request_identity'::regclass) then
    raise exception 'FAIL: private RLS not enforced.';
  end if;
  if exists(select 1 from pg_policy where polrelid='orl_private.request_identity'::regclass) then
    raise exception 'FAIL: unexpected RLS policy.';
  end if;
end $$;

-- Execute as the actual backend database role, not just as table owner.
set local role service_role;
do $$
declare payload jsonb; u uuid;
begin
  payload:=public.orl_ic_foundation_probe('11111111-aaaa-4111-8111-111111111111');
  if payload is distinct from '{"phase":"B","schema_version":1,"patient_encryption_active":false}'::jsonb then
    raise exception 'FAIL: unexpected readiness response.';
  end if;
  foreach u in array array['22222222-aaaa-4222-8222-222222222222'::uuid,'33333333-aaaa-4333-8333-333333333333'::uuid] loop
    begin
      perform public.orl_ic_foundation_probe(u);
      raise exception 'FAIL: non-Webmaster accepted.';
    exception when insufficient_privilege then null;
    end;
  end loop;
  begin
    perform public.orl_ic_foundation_probe(null);
    raise exception 'FAIL: NULL session accepted.';
  exception when invalid_authorization_specification then null;
  end;
  begin
    perform public.orl_ic_foundation_probe('00000000-0000-4000-8000-000000000000');
    raise exception 'FAIL: unknown session accepted.';
  exception when invalid_authorization_specification then null;
  end;
end $$;
reset role;
update public.orl_users set must_change_password=true where username='synthetic_wm';
set local role service_role;
do $$
begin
  begin
    perform public.orl_ic_foundation_probe('11111111-aaaa-4111-8111-111111111111');
  exception when raise_exception then
    if sqlerrm='Password change required before accessing the system.' then return; end if;
    raise;
  end;
  raise exception 'FAIL: required password change bypassed.';
end $$;
reset role;
update public.orl_users set must_change_password=false,is_active=false where username='synthetic_wm';
set local role service_role;
do $$ begin
  begin perform public.orl_ic_foundation_probe('11111111-aaaa-4111-8111-111111111111');
    raise exception 'FAIL: disabled account accepted.';
  exception when invalid_authorization_specification then null; end;
end $$;
reset role;
update public.orl_users set is_active=true where username='synthetic_wm';
update public.orl_sessions set expires_at=now()-interval '1 second';
set local role service_role;
do $$ begin
  begin perform public.orl_ic_foundation_probe('11111111-aaaa-4111-8111-111111111111');
    raise exception 'FAIL: expired session accepted.';
  exception when invalid_authorization_specification then null; end;
end $$;
reset role;
set local role anon;
do $$ begin
  begin perform public.orl_ic_foundation_probe('11111111-aaaa-4111-8111-111111111111');
    raise exception 'FAIL: anonymous direct RPC accepted.';
  exception when insufficient_privilege then null; end;
  begin perform * from orl_private.request_identity;
    raise exception 'FAIL: anonymous table read accepted.';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
select 'PASS: original workflows/data preserved; private grants and session/role guards passed.';
