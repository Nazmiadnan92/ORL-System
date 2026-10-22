-- Approve a pending, unassigned request only when its selected OT slot can also
-- be assigned. No patient, slot, identity, setting or audit row changes on install.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- Catalog-only preflight, also extracted by the operator installer before backup.
do $baseline$
declare item record;
begin
 for item in select * from (values
  ('public.orl_booking_assign_view(uuid,uuid)','060a6404455ba9f9ddbc78a2a19bfac4','search_path=""'),
  ('public.orl_booking_assign_existing(uuid,uuid,uuid,timestamptz,uuid)','e54fa0d43ffd4b4e4d4178b2a814609a','search_path=""'),
  ('public.orl_review_request(uuid,uuid,text,text)','eb02cd973d9cd40b054d6b00795a1508','search_path=public, extensions'),
  ('public.orl_assign_slot(uuid,uuid,uuid)','b924d46e7bcac41332c9470521a72080','search_path=public, extensions'),
  ('public.orl_require_session(uuid)','ba9d29923e7269729c8025bf1e266208','search_path=""'),
  ('orl_private.c1_check_generation(uuid)','5c654a99ad55c29ba66b9b74371c8239','search_path=""'),
  ('orl_private.c1_redact_text(text)','aea30f10772d86163fb1aa4e2362fac3','search_path=""'),
  ('orl_private.booking_same_date_guard()','30be1c5fe983f12238591fd2f3661b44','search_path=""')
 ) v(signature,body_md5,configuration) loop
  if not coalesce((select prosecdef and md5(replace(prosrc,chr(13),''))=item.body_md5
   and proconfig=array[item.configuration]
   and proowner=(select proowner from pg_proc where oid='public.orl_require_session(uuid)'::regprocedure)
   from pg_proc where oid=to_regprocedure(item.signature)),false) then
   raise exception '071: reviewed assignment baseline differs: %. Nothing installed.',item.signature;
  end if;
 end loop;
 if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in('orl_booking_assign_view','orl_booking_assign_existing'))<>2 then
  raise exception '071: assignment overloads differ. Nothing installed.';
 end if;
 if exists(select 1 from unnest(array['anon','authenticated','service_role']) client
  cross join unnest(array['public.orl_review_request(uuid,uuid,text,text)','public.orl_assign_slot(uuid,uuid,uuid)',
   'public.orl_require_session(uuid)','orl_private.c1_check_generation(uuid)',
   'orl_private.c1_redact_text(text)','orl_private.booking_same_date_guard()']) signature
  where has_function_privilege(client,signature,'EXECUTE'))
  or exists(select 1 from unnest(array['public.orl_booking_assign_view(uuid,uuid)',
   'public.orl_booking_assign_existing(uuid,uuid,uuid,timestamptz,uuid)']) signature
   where has_function_privilege('service_role',signature,'EXECUTE')
    or not has_function_privilege('anon',signature,'EXECUTE')
    or not has_function_privilege('authenticated',signature,'EXECUTE'))
  or exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   where p.oid=any(array[
    'public.orl_booking_assign_view(uuid,uuid)'::regprocedure,
    'public.orl_booking_assign_existing(uuid,uuid,uuid,timestamptz,uuid)'::regprocedure,
    'public.orl_review_request(uuid,uuid,text,text)'::regprocedure,'public.orl_assign_slot(uuid,uuid,uuid)'::regprocedure,
    'public.orl_require_session(uuid)'::regprocedure,'orl_private.c1_check_generation(uuid)'::regprocedure,
    'orl_private.c1_redact_text(text)'::regprocedure,'orl_private.booking_same_date_guard()'::regprocedure])
   and (a.grantee=0 or (a.grantee<>p.proowner and a.is_grantable))) then
  raise exception '071: protected assignment permissions differ. Nothing installed.';
 end if;
 if exists(select 1 from unnest(array['anon','authenticated']) client
  cross join unnest(array['public.orl_requests','public.orl_ot_slots','public.orl_ot_sessions','public.orl_audit_log',
   'public.orl_settings','public.orl_holidays']) relation
  where has_table_privilege(client,relation,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
  or exists(select 1 from unnest(array['anon','authenticated','service_role']) client
   where has_table_privilege(client,'orl_private.request_identity','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
  or exists(select 1 from unnest(array['public.orl_requests','public.orl_ot_slots','public.orl_ot_sessions']) relation
   where not coalesce((select relrowsecurity from pg_class where oid=to_regclass(relation)),false))
  or not coalesce((select relrowsecurity and relforcerowsecurity from pg_class
   where oid='orl_private.request_identity'::regclass),false)
  or not exists(select 1 from pg_trigger where tgrelid='public.orl_ot_slots'::regclass
   and tgname='orl_booking_same_date_guard' and tgfoid='orl_private.booking_same_date_guard()'::regprocedure
   and tgtype=23 and tgenabled in('O','A') and not tgisinternal) then
  raise exception '071: protected tables or duplicate-date guard differ. Nothing installed.';
 end if;
end $baseline$;

create or replace function public.orl_booking_assign_view(p_session_token uuid,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype;r public.orl_requests%rowtype;g uuid;
begin
 u:=public.orl_require_session(p_session_token);
 if u.role not in('ADMIN','WEBMASTER') then raise exception 'Admin or Webmaster access required.'; end if;
 select generation into g from orl_private.c1_restore_generation where singleton;
 perform orl_private.c1_check_generation(g);
 select * into r from public.orl_requests where id=p_request_id;
 if not found or r.status not in('CONFIRMED','APPROVED') or r.assigned_slot_id is not null
  or r.deletion_status<>'' or r.ot_hold
  or exists(select 1 from public.orl_ot_slots where request_id=r.id) then
  raise exception 'Only a pending or approved, unassigned request without OT Hold can be selected.';
 end if;
 return jsonb_build_object('generation',g,'request_version',r.updated_at,'request_id',r.id,
  'patient_name',orl_private.c1_redact_text(r.patient_name),'mrn',orl_private.c1_redact_text(r.mrn),
  'surgery',orl_private.c1_redact_text(r.surgery),'request_number',r.request_number,'status',r.status);
end $$;

create or replace function public.orl_booking_assign_existing(p_session_token uuid,p_request_id uuid,p_target_slot uuid,p_expected_version timestamptz,p_generation uuid)
returns text language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype;r public.orl_requests%rowtype;
begin
 u:=public.orl_require_session(p_session_token);
 if u.role not in('ADMIN','WEBMASTER') then raise exception 'Admin or Webmaster access required.'; end if;
 perform orl_private.c1_check_generation(p_generation);
 -- Retain the existing control/holiday fence and destination-before-request order.
 lock table public.orl_settings,public.orl_holidays,public.orl_ot_sessions,public.orl_ot_slots in row exclusive mode nowait;
 perform 1 from public.orl_ot_slots where id=p_target_slot for update;
 select * into r from public.orl_requests where id=p_request_id for update;
 if not found or r.status not in('CONFIRMED','APPROVED') or r.assigned_slot_id is not null
  or r.deletion_status<>'' or r.ot_hold
  or p_expected_version is null or r.updated_at is distinct from p_expected_version
  or exists(select 1 from public.orl_ot_slots where request_id=r.id) then
  raise exception 'This request changed, is on OT Hold, or already has a slot. Reload before assigning it.';
 end if;
 if r.status='CONFIRMED' then
  -- Preserve the established reviewer metadata and REQUEST_APPROVE audit. Any
  -- destination/audit failure below rolls this approval back in the same RPC.
  perform public.orl_review_request(p_session_token,p_request_id,'APPROVE','Approved while assigning an OT slot');
 end if;
 -- Existing core enforces active date, holiday override, available destination,
 -- same-date duplicate checks and assignment audit. Clinical/identity data stays.
 return public.orl_assign_slot(p_session_token,p_request_id,p_target_slot);
end $$;

-- CREATE OR REPLACE preserves the reviewed owner and ACLs; do not broaden grants.
notify pgrst,'reload schema';
commit;
