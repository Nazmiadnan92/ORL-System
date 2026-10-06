-- Maintenance is OFF on installation. No patient or encryption data changes.
begin;
set local lock_timeout='10s';
set local statement_timeout='30s';
do $$
begin
 if to_regclass('orl_private.site_maintenance') is not null then raise exception '056 already installed; inspect status, do not repeat.'; end if;
 if not orl_private.c1_recovery_ready() or not (orl_private.c6_stats()->>'cutover_complete')::boolean then raise exception 'Protected baseline missing'; end if;
 if (select md5(replace(prosrc,chr(13),'')) from pg_proc where oid='public.orl_require_session(uuid)'::regprocedure) is distinct from 'e7412ffba464e9c480f461a2839a35ec' then raise exception 'Session guard differs'; end if;
 if exists(select 1 from unnest(array['anon','authenticated','service_role']) r where has_function_privilege(r,'public.orl_require_session(uuid)','EXECUTE')) then raise exception 'Private session access must be closed'; end if;
end $$;

create table orl_private.site_maintenance(
 singleton boolean primary key default true check(singleton),
 enabled boolean not null default false,
 message text not null default 'Sistem sedang diselenggara. Sila cuba semula sebentar lagi.' check(length(message)<=500),
 expected_end timestamptz,
 revision bigint not null default 0 check(revision>=0),
 updated_at timestamptz not null default now()
);
insert into orl_private.site_maintenance(singleton) values(true);
alter table orl_private.site_maintenance enable row level security;
revoke all on orl_private.site_maintenance from public,anon,authenticated,service_role;

-- Shared row lock makes ON wait for already-authorized non-Webmaster
-- transactions to finish. New transactions see ON after the toggle commits.
create or replace function public.orl_require_session(p_session_token uuid)
returns public.orl_users language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype; active boolean;
begin
 if not orl_private.c1_recovery_ready() then
  raise exception 'Full-dump recovery is required before access reopens.' using errcode='55000';
 end if;
 u:=orl_private.c1_require_session_core(p_session_token);
 if u.role<>'WEBMASTER' then
  select enabled into active from orl_private.site_maintenance where singleton for share;
  if active is distinct from false then raise exception 'ORL_MAINTENANCE: Sistem sedang diselenggara.' using errcode='55000'; end if;
 end if;
 return u;
end $$;
revoke all on function public.orl_require_session(uuid) from public,anon,authenticated,service_role;

-- Public notice only: no users, sessions, credentials, or patient data.
create function public.orl_maintenance_status()
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('enabled',enabled,'message',message,'expected_end',expected_end,'revision',revision)
 from orl_private.site_maintenance where singleton
$$;
revoke all on function public.orl_maintenance_status() from public,anon,authenticated,service_role;
grant execute on function public.orl_maintenance_status() to anon,authenticated;

create function public.orl_set_maintenance(p_session_token uuid,p_password text,p_enabled boolean,p_message text,p_expected_end timestamptz,p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype; current_state orl_private.site_maintenance%rowtype; clean_message text;
begin
 u:=public.orl_require_session(p_session_token);
 if u.role<>'WEBMASTER' then raise exception 'Webmaster access required.'; end if;
 perform public.orl_require_webmaster_password(p_session_token,p_password);
 if p_enabled is null or p_message is null or length(p_message)>500 or p_expected_revision is null then raise exception 'Invalid maintenance settings.'; end if;
 clean_message:=btrim(p_message);
 if clean_message='' then raise exception 'Maintenance message is required.'; end if;
 if p_enabled and p_expected_end is not null and (not isfinite(p_expected_end) or p_expected_end<=now()) then raise exception 'Estimated completion must be a future time.'; end if;
 select * into current_state from orl_private.site_maintenance where singleton for update;
 if not found or current_state.revision<>p_expected_revision then raise exception 'Maintenance settings changed. Reload and review again.'; end if;
 update orl_private.site_maintenance set enabled=p_enabled,message=clean_message,
  expected_end=case when p_enabled then p_expected_end else null end,revision=revision+1,updated_at=now() where singleton;
 insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
 values(u.id,u.display_name,u.role,case when p_enabled then 'MAINTENANCE_ON' else 'MAINTENANCE_OFF' end,
 'SYSTEM','MAINTENANCE',jsonb_build_object('previous_enabled',current_state.enabled,'enabled',p_enabled,
 'message',clean_message,'expected_end',case when p_enabled then p_expected_end else null end)::text);
 return public.orl_maintenance_status();
end $$;
revoke all on function public.orl_set_maintenance(uuid,text,boolean,text,timestamptz,bigint) from public,anon,authenticated,service_role;
grant execute on function public.orl_set_maintenance(uuid,text,boolean,text,timestamptz,bigint) to anon,authenticated;
notify pgrst,'reload schema';
commit;
