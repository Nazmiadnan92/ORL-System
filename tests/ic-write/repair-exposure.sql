-- LOCAL ONLY: C1 steps 7-9. Never install this file in production.
begin;
do $$ begin
 if session_user<>'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet
   or to_regprocedure('public.orl_ic_c1_control(uuid,text,uuid,jsonb,uuid,text)') is null
   or to_regprocedure('orl_private.c1_mask_json(jsonb,date)') is null then
   raise exception 'Local complete C1 runner required';
 end if;
end $$;

-- Exact repair revision: counts alone cannot identify a changed patient/slot set.
create function orl_private.c1_repair_snapshot() returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
   'requests',coalesce((select jsonb_agg(jsonb_build_array(id,status,assigned_slot_id,updated_at) order by id)
     from public.orl_requests),'[]'::jsonb),
   'slots',coalesce((select jsonb_agg(jsonb_build_array(id,session_id,slot_type,slot_number,status,request_id,updated_at) order by id)
     from public.orl_ot_slots),'[]'::jsonb))
$$;
revoke all on function orl_private.c1_repair_snapshot() from public,anon,authenticated,service_role;

create function public.orl_ic_c1_repair_view(p_session_token uuid,p_generation uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype; health jsonb; snapshot jsonb;
begin
 u:=public.orl_require_session(p_session_token);
 if u.role<>'WEBMASTER' then raise exception 'Webmaster access required'; end if;
 perform orl_private.c1_check_generation(p_generation);
 lock table public.orl_requests,public.orl_ot_sessions,public.orl_ot_slots in share mode nowait;
 snapshot:=orl_private.c1_repair_snapshot();
 health:=public.orl_db_health(p_session_token);
 return jsonb_build_object('health',health,'generation',p_generation,'revision',md5(snapshot::text));
end $$;
revoke all on function public.orl_ic_c1_repair_view(uuid,uuid) from public,anon,authenticated;
grant execute on function public.orl_ic_c1_repair_view(uuid,uuid) to service_role;

create function public.orl_ic_c1_repair(p_session_token uuid,p_password text,p_generation uuid,p_revision text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype; result jsonb;
begin
 u:=public.orl_require_webmaster_password(p_session_token,p_password);
 perform orl_private.c1_check_generation(p_generation);
 if p_revision is null or p_revision!~'^[a-f0-9]{32}$' then raise exception 'Reload Database Repair'; end if;
 lock table public.orl_requests,public.orl_ot_sessions,public.orl_ot_slots in share row exclusive mode nowait;
 if p_revision is distinct from md5(orl_private.c1_repair_snapshot()::text) then
   raise exception 'Database state changed. Reload and review Repair again';
 end if;
 result:=public.orl_db_repair(p_session_token,p_password);
 if result->>'status'<>'COMPLETED' then raise exception 'Repair result not confirmed'; end if;
 return result;
end $$;
revoke all on function public.orl_ic_c1_repair(uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.orl_ic_c1_repair(uuid,text,uuid,text) to service_role;

-- Redact exact known IC/passport values and Malaysian IC-shaped text. This is
-- used only on free-text fields; structured patient_ic continues through mask_ic.
create function orl_private.c1_redact_text(p_text text) returns text
language plpgsql stable security definer set search_path='' as $$
declare result text:=p_text; raw text;
begin
 if result is null or result='' then return result; end if;
 for raw in select distinct trim(patient_ic) from public.orl_requests
   where length(trim(coalesce(patient_ic,'')))>3 and position(trim(patient_ic) in result)>0 loop
   result:=replace(result,raw,orl_private.c1_mask_ic(raw));
 end loop;
 return regexp_replace(result,'(^|[^0-9])([0-9]{6})-?([0-9]{2})-?([0-9]{4})([^0-9]|$)',
   E'\\1\\2-**-****\\5','g');
end $$;
revoke all on function orl_private.c1_redact_text(text) from public,anon,authenticated,service_role;

-- Replace the earlier local masker with free-text-aware behavior.
create or replace function orl_private.c1_mask_json(p_value jsonb,p_date date default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; k text; v jsonb; at_date date:=coalesce(p_date,current_date); parts jsonb;
  sensitive constant text[]:=array['remark','reason','details','record_id','review_note','deletion_reason','note','description'];
begin
 if jsonb_typeof(p_value)='array' then
   select coalesce(jsonb_agg(orl_private.c1_mask_json(value,at_date) order by ord),'[]'::jsonb) into result
   from jsonb_array_elements(p_value) with ordinality x(value,ord); return result;
 elsif jsonb_typeof(p_value)='object' then
   if nullif(p_value->>'ot_date','') is not null then at_date:=(p_value->>'ot_date')::date; end if;
   result:='{}'::jsonb;
   for k,v in select * from jsonb_each(p_value) loop
     if k=any(sensitive) and jsonb_typeof(v)='string' then
       result:=result||jsonb_build_object(k,orl_private.c1_redact_text(v#>>'{}'));
     else result:=result||jsonb_build_object(k,orl_private.c1_mask_json(v,at_date)); end if;
   end loop;
   if p_value ? 'patient_ic' then
     parts:=public.orl_age_parts(p_value->>'patient_ic',at_date);
     result:=result||jsonb_build_object('patient_ic',orl_private.c1_mask_ic(p_value->>'patient_ic'),
       'patient_ic_masked',true,'patient_ic_present',coalesce(p_value->>'patient_ic','')<>'');
     if parts is not null then result:=result||jsonb_build_object('age',parts->'years','age_months',parts->'months','age_source','IC');
     elsif not (result ? 'age_source') then result:=result||jsonb_build_object('age_source','MANUAL'); end if;
   end if;
   if p_value->>'match_type'='PATIENT IC' then
     result:=jsonb_set(result,'{match_value}',to_jsonb(orl_private.c1_mask_ic(p_value->>'match_value')));
   end if;
   return result;
 end if;
 return p_value;
end $$;

-- Audit had not been included in the original read-cutover list.
do $$ declare def text; begin
 def:=pg_get_functiondef('public.orl_get_audit(uuid,text)'::regprocedure);
 execute replace(def,'FUNCTION public.orl_get_audit(', 'FUNCTION orl_private.c1_read_orl_get_audit(');
end $$;
revoke all on function orl_private.c1_read_orl_get_audit(uuid,text) from public,anon,authenticated,service_role;
create or replace function public.orl_get_audit(p_session_token uuid,p_search text default '')
returns jsonb language sql security definer set search_path='' as $$
 select orl_private.c1_mask_json(orl_private.c1_read_orl_get_audit(p_session_token,p_search),null)
$$;
commit;
