-- LOCAL read-cutover candidate only. Not migration 046; frontend is not switched.
begin;
do $$ begin
 if session_user<>'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet
   or to_regprocedure('public.orl_ic_c1_export(uuid,text)') is null then raise exception 'Local C1 runner required.'; end if;
end $$;

create function orl_private.c1_mask_ic(p_raw text)
returns text language sql immutable set search_path='' as $$
 select case when p_raw is null then null when trim(p_raw)='' then ''
   when p_raw ~ '^(\*{6}-\*{2}-[0-9]{4}|\*{4,8}[A-Za-z0-9]{4}|\*{4})$' then p_raw
   when trim(p_raw) ~ '^[0-9]{6}-?[0-9]{2}-?[0-9]{4}$' then '******-**-'||right(trim(p_raw),4)
   when length(regexp_replace(p_raw,'\s','','g'))<=4 then '****'
   else '********'||right(regexp_replace(p_raw,'\s','','g'),4) end
$$;
revoke all on function orl_private.c1_mask_ic(text) from public,anon,authenticated,service_role;

create function orl_private.c1_mask_json(p_value jsonb,p_date date default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; k text; v jsonb; at_date date:=coalesce(p_date,current_date); parts jsonb;
begin
 if jsonb_typeof(p_value)='array' then
   select coalesce(jsonb_agg(orl_private.c1_mask_json(value,at_date) order by ord),'[]'::jsonb) into result
   from jsonb_array_elements(p_value) with ordinality x(value,ord); return result;
 elsif jsonb_typeof(p_value)='object' then
   if nullif(p_value->>'ot_date','') is not null then at_date:=(p_value->>'ot_date')::date; end if;
   result:='{}'::jsonb;
   for k,v in select * from jsonb_each(p_value) loop
     result:=result||jsonb_build_object(k,orl_private.c1_mask_json(v,at_date));
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
   -- Schedule slot objects carry request_id. Attach the exact database revision
   -- while still inside the masked server boundary; no plaintext IC is exposed.
   if p_value ? 'request_id' and coalesce(p_value->>'request_id','')<>''
      and (p_value->>'request_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
     result:=result||coalesce((select jsonb_build_object('_ic_edit_version',r.updated_at)
       from public.orl_requests r where r.id=(p_value->>'request_id')::uuid),'{}'::jsonb);
   end if;
   return result;
 end if;
 return p_value;
end $$;
revoke all on function orl_private.c1_mask_json(jsonb,date) from public,anon,authenticated,service_role;

-- Preserve original filters/session checks in private cores. No client can call them.
-- Wrapper replaces the SAME public signature, so old direct RPC URLs also mask.
do $wrap$
declare signature text; oid_ oid; name_ text; def text; args text; names text; types text;
begin
 foreach signature in array array[
   'orl_get_postponed(uuid)','orl_get_deletions(uuid)','orl_find_patient_search(uuid,text)',
   'orl_subspecialty_statistics(uuid,date,date,text,text,text,text,integer)',
   'orl_db_cancelled(uuid)','orl_db_find_patient(uuid,text)','orl_db_duplicates(uuid)',
   'orl_get_requests(uuid)','orl_get_dashboard(uuid)'] loop
   oid_:=to_regprocedure('public.'||signature);
   select proname,pg_get_functiondef(oid),pg_get_function_arguments(oid),
     array_to_string(proargnames,','),oidvectortypes(proargtypes)
     into name_,def,args,names,types from pg_proc where oid=oid_;
   if def is null then raise exception 'Read baseline missing: %',signature; end if;
   execute replace(def,'FUNCTION public.'||name_||'(', 'FUNCTION orl_private.c1_read_'||name_||'(');
   execute format('revoke all on function orl_private.c1_read_%s(%s) from public,anon,authenticated,service_role',name_,types);
   execute format('create or replace function public.%s(%s) returns jsonb language sql security definer set search_path='''' as %L',
     name_,args,'select orl_private.c1_mask_json(orl_private.c1_read_'||name_||'('||names||'),null)');
 end loop;
 -- Schedule is a set of table rows instead of one JSON document.
 def:=pg_get_functiondef('public.orl_get_schedule(uuid,integer,integer)'::regprocedure);
 execute replace(def,'FUNCTION public.orl_get_schedule(', 'FUNCTION orl_private.c1_read_schedule(');
end $wrap$;
revoke all on function orl_private.c1_read_schedule(uuid,integer,integer) from public,anon,authenticated,service_role;
create or replace function public.orl_get_schedule(p_session_token uuid,p_year integer,p_month integer)
returns table(session_id uuid,ot_date date,day_name text,status text,note text,special_title text,holiday_name text,slots jsonb)
language sql security definer set search_path='' as $$
 select s.session_id,s.ot_date,s.day_name,s.status,s.note,s.special_title,s.holiday_name,
   orl_private.c1_mask_json(s.slots,s.ot_date) from orl_private.c1_read_schedule(p_session_token,p_year,p_month) s
$$;

-- Preserve each existing scoped/masked result and add an exact, unrounded
-- cancellation snapshot. A reject/re-request cycle invalidates the old version.
create or replace function public.orl_get_requests(p_session_token uuid)
returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(x.value||jsonb_build_object('assigned_slot_id',r.assigned_slot_id,
   '_ic_delete_version',r.updated_at) order by x.n),'[]'::jsonb)
 from jsonb_array_elements(orl_private.c1_mask_json(orl_private.c1_read_orl_get_requests(p_session_token),null)) with ordinality x(value,n)
 join public.orl_requests r on r.id=(x.value->>'id')::uuid
$$;
create or replace function public.orl_get_deletions(p_session_token uuid)
returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(x.value||jsonb_build_object('assigned_slot_id',r.assigned_slot_id,
   '_ic_delete_version',r.updated_at) order by x.n),'[]'::jsonb)
 from jsonb_array_elements(orl_private.c1_mask_json(orl_private.c1_read_orl_get_deletions(p_session_token),null)) with ordinality x(value,n)
 join public.orl_requests r on r.id=(x.value->>'id')::uuid
$$;

-- The superseded MRN-only API must not bypass modern Staff ownership filtering.
create or replace function public.orl_find_patient(p_session_token uuid,p_mrn text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 return (select coalesce(jsonb_agg(x),'[]'::jsonb) from jsonb_array_elements(
   public.orl_find_patient_search(p_session_token,p_mrn)) x where lower(trim(x->>'mrn'))=lower(trim(p_mrn)));
end $$;
commit;
