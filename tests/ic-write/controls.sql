-- LOCAL ONLY. Administrative metadata controls; never a production migration.
begin;
do $$ begin
 if session_user<>'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet
 or to_regprocedure('orl_private.c1_check_generation(uuid)') is null then raise exception 'Local C1 runner required'; end if;
end $$;

-- No patient/request clinical fields or keys are selected. Calendar/title free
-- text still needs the separate step-9 exposure review.
create function orl_private.c1_control_snapshot(p_scope text,p_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v jsonb; sid uuid;
begin
 if p_scope='SETTINGS' and p_id is null then
   select coalesce(jsonb_object_agg(setting_key,setting_value),'{}') into v from public.orl_settings;
 elsif p_scope='HOLIDAYS' and p_id is null then
   select jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(h) order by id) from public.orl_holidays h),'[]'),
     'overrides',coalesce((select jsonb_agg(jsonb_build_array(id,ot_date,holiday_override) order by id) from public.orl_ot_sessions),'[]')) into v;
 elsif p_scope in('SESSION','SLOT') and p_id is not null then
   if p_scope='SESSION' then sid:=p_id;
   else select session_id into sid from public.orl_ot_slots where id=p_id; end if;
   select jsonb_build_object('session',to_jsonb(s),'slots',coalesce((select jsonb_agg(to_jsonb(sl) order by sl.id)
     from public.orl_ot_slots sl where sl.session_id=s.id and (p_scope='SESSION' or sl.id=p_id)),'[]'),
     'holiday',coalesce((select to_jsonb(h) from public.orl_holidays h where h.holiday_date=s.ot_date and h.is_active),'null'))
     into v from public.orl_ot_sessions s where s.id=sid;
 else raise exception 'Invalid control scope'; end if;
 if v is null then raise exception 'Control target missing'; end if;
 return v;
end $$;
revoke all on function orl_private.c1_control_snapshot(text,uuid) from public,anon,authenticated,service_role;

create function public.orl_ic_c1_control_view(p_session_token uuid,p_scope text,p_id uuid,p_generation uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype; g uuid; v jsonb;
begin
 u:=public.orl_require_session(p_session_token);
 -- Staff can read the holiday/settings lists already exposed by the application,
 -- but cannot prepare an administrative session or slot action.
 if p_scope in('SESSION','SLOT') and u.role not in('ADMIN','WEBMASTER') then raise exception 'Admin access required'; end if;
 select generation into g from orl_private.c1_restore_generation where singleton;
 if p_scope in('SESSION','SLOT') and p_generation is null then raise exception 'Reload the schedule'; end if;
 perform orl_private.c1_check_generation(coalesce(p_generation,g));
 lock table public.orl_settings,public.orl_holidays,public.orl_ot_sessions,public.orl_ot_slots in share mode nowait;
 v:=orl_private.c1_control_snapshot(p_scope,p_id);
 return jsonb_build_object('generation',g,'revision',md5(v::text),'data',v);
end $$;
revoke all on function public.orl_ic_c1_control_view(uuid,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.orl_ic_c1_control_view(uuid,text,uuid,uuid) to service_role;

create function public.orl_ic_c1_control(p_session_token uuid,p_action text,p_id uuid,p_data jsonb,p_generation uuid,p_revision text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype; scope text; v jsonb; k text; merged jsonb; result jsonb:='null';
begin
 u:=public.orl_require_session(p_session_token);
 if u.role not in('ADMIN','WEBMASTER') then raise exception 'Admin access required'; end if;
 scope:=case when p_action in('SESSION_STATUS','SESSION_TITLE') then 'SESSION' when p_action='SLOT_CLOSED' then 'SLOT'
   when p_action in('HOLIDAY_SAVE','HOLIDAY_DELETE','HOLIDAY_GENERATE','HOLIDAY_CLEAR') then 'HOLIDAYS'
   when p_action='SETTINGS' then 'SETTINGS' else null end;
 if scope is null or jsonb_typeof(p_data) is distinct from 'object' or octet_length(p_data::text)>16384 then raise exception 'Invalid control'; end if;
 perform orl_private.c1_check_generation(p_generation);
 -- NOWAIT refuses contention instead of taking a partial multi-table operation.
 -- Existing booking writers cannot change slots during validation/commit.
 lock table public.orl_settings,public.orl_holidays,public.orl_ot_sessions,public.orl_ot_slots in share row exclusive mode nowait;
 v:=orl_private.c1_control_snapshot(scope,case when scope in('SESSION','SLOT') then p_id else null end);
 if p_revision is null or p_revision is distinct from md5(v::text) then raise exception 'Controls changed. Reload and review again'; end if;
 if p_action='SESSION_STATUS' then
   if p_data- 'status'<>'{}' or coalesce(p_data->>'status','') not in('ACTIVE','CANCELLED') then raise exception 'Invalid status'; end if;
   perform public.orl_set_session(p_session_token,p_id,p_data->>'status',null);
 elsif p_action='SESSION_TITLE' then
   if p_data-'title'<>'{}' or jsonb_typeof(p_data->'title') is distinct from 'string' or length(p_data->>'title')>240 then raise exception 'Invalid title'; end if;
   perform public.orl_set_session(p_session_token,p_id,null,p_data->>'title');
 elsif p_action='SLOT_CLOSED' then
   if p_data-'closed'<>'{}' or jsonb_typeof(p_data->'closed') is distinct from 'boolean' then raise exception 'Invalid slot state'; end if;
   if v#>>'{session,status}'<>'ACTIVE' or (v->'holiday'<>'null' and not (v#>>'{session,holiday_override}')::boolean) then raise exception 'OT date unavailable'; end if;
   result:=to_jsonb(public.orl_set_slot_closed(p_session_token,p_id,(p_data->>'closed')::boolean));
 elsif p_action='HOLIDAY_SAVE' then
   if p_data-array['date','title','description']<>'{}' or jsonb_typeof(p_data->'title') is distinct from 'string'
     or length(trim(p_data->>'title')) not between 1 and 240 or jsonb_typeof(p_data->'description') is distinct from 'string'
     or length(p_data->>'description')>4096 or coalesce(p_data->>'date','')!~'^\d{4}-\d{2}-\d{2}$' then raise exception 'Invalid holiday'; end if;
   if extract(year from (p_data->>'date')::date) not between 2026 and 2100 then raise exception 'Invalid year'; end if;
   if p_id is not null and not exists(select 1 from public.orl_holidays where id=p_id) then raise exception 'Holiday missing'; end if;
   result:=to_jsonb(public.orl_save_holiday(p_session_token,p_id,(p_data->>'date')::date,p_data->>'title',p_data->>'description'));
 elsif p_action='HOLIDAY_DELETE' then
   if p_data<>'{}' or p_id is null or not exists(select 1 from public.orl_holidays where id=p_id) then raise exception 'Holiday missing'; end if;
   perform public.orl_delete_holiday(p_session_token,p_id);
 elsif p_action='HOLIDAY_GENERATE' then
   if p_id is not null or p_data-'year'<>'{}' or coalesce(p_data->>'year','')!~'^\d{4}$'
     or (p_data->>'year')::integer not between 2026 and 2100 then raise exception 'Invalid year'; end if;
   result:=public.orl_generate_public_holidays(p_session_token,(p_data->>'year')::integer);
 elsif p_action='HOLIDAY_CLEAR' then
   if p_id is not null or p_data-'password'<>'{}' or jsonb_typeof(p_data->'password') is distinct from 'string'
     or length(p_data->>'password') not between 1 and 1024 then raise exception 'Password required'; end if;
   -- Existing core requires Webmaster AND verifies password. Never audit it.
   result:=to_jsonb(public.orl_clear_all_holidays(p_session_token,p_data->>'password'));
 elsif p_action='SETTINGS' then
   if p_id is not null or p_data='{}' then raise exception 'Invalid settings'; end if;
   for k in select jsonb_object_keys(p_data) loop
     if k not in('SYSTEM_NAME','START_YEAR','END_YEAR','OT_DAYS','MAIN_SLOTS','SPECIAL_SLOTS')
       or jsonb_typeof(p_data->k) is distinct from 'string' then raise exception 'Invalid setting'; end if;
   end loop;
   merged:=v||p_data;
   if length(trim(merged->>'SYSTEM_NAME')) not between 1 and 200
     or coalesce(merged->>'START_YEAR','')!~'^\d{4}$' or coalesce(merged->>'END_YEAR','')!~'^\d{4}$'
     or (merged->>'START_YEAR')::integer<2026 or (merged->>'END_YEAR')::integer>2100
     or (merged->>'END_YEAR')::integer<(merged->>'START_YEAR')::integer
     or coalesce(merged->>'SPECIAL_SLOTS','')!~'^\d{1,3}$' or (merged->>'SPECIAL_SLOTS')::integer>100
     or coalesce(merged->>'MAIN_SLOTS','')!~'^\d{1,3}$' or (merged->>'MAIN_SLOTS')::integer not between 1 and 100
     or coalesce(merged->>'OT_DAYS','')!~'^[0-6](,[0-6]){0,6}$' then raise exception 'Invalid setting values'; end if;
   perform public.orl_save_settings(p_session_token,p_data);
 end if;
 return jsonb_build_object('result',result,'action',p_action);
end $$;
revoke all on function public.orl_ic_c1_control(uuid,text,uuid,jsonb,uuid,text) from public,anon,authenticated;
grant execute on function public.orl_ic_c1_control(uuid,text,uuid,jsonb,uuid,text) to service_role;

-- Schedule reads can lazily create sessions/slots. They also join the Restore
-- fence; retain 020's existing fixed Main capacity and Sunday/Wednesday rules.
do $$ declare def text; begin
 def:=pg_get_functiondef('public.orl_prepare_schedule(uuid,integer,integer)'::regprocedure);
 execute replace(def,'FUNCTION public.orl_prepare_schedule(', 'FUNCTION orl_private.c1_prepare_schedule(');
end $$;
revoke all on function orl_private.c1_prepare_schedule(uuid,integer,integer) from public,anon,authenticated,service_role;
create or replace function public.orl_prepare_schedule(p_session_token uuid,p_year integer,p_month integer)
returns void language plpgsql security definer set search_path='' as $$
declare g uuid;
begin
 perform public.orl_require_session(p_session_token);
 select generation into g from orl_private.c1_restore_generation where singleton;
 perform orl_private.c1_check_generation(g);
 perform orl_private.c1_prepare_schedule(p_session_token,p_year,p_month);
end $$;
commit;
