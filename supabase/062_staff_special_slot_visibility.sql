-- Restore Staff VIEW access to Special slots and availability only.
-- No patient changes. Keep masked IC, session/maintenance gates and booking restrictions.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $repair$
declare fn regprocedure; source text; definition text; before_acl aclitem[];
begin
 if not coalesce((select md5(replace(prosrc,chr(13),''))='176cc950c7c8a75b13e85bb1addbae03' and prosecdef from pg_proc where oid=to_regprocedure('public.orl_get_schedule(uuid,integer,integer)')),false) then raise exception '062: protected baseline differs: public.orl_get_schedule(uuid,integer,integer)'; end if;
 if not coalesce((select md5(replace(prosrc,chr(13),''))='f47cec01cc6028c6320a2b8bc8fb2115' and prosecdef from pg_proc where oid=to_regprocedure('orl_private.c1_mask_json(jsonb,date)')),false) then raise exception '062: protected baseline differs: orl_private.c1_mask_json(jsonb,date)'; end if;
 if not coalesce((select md5(replace(prosrc,chr(13),''))='ba9d29923e7269729c8025bf1e266208' and prosecdef from pg_proc where oid=to_regprocedure('public.orl_require_session(uuid)')),false) then raise exception '062: protected baseline differs: public.orl_require_session(uuid)'; end if;
 if not coalesce((select md5(replace(prosrc,chr(13),''))='b924d46e7bcac41332c9470521a72080' and prosecdef from pg_proc where oid=to_regprocedure('public.orl_assign_slot(uuid,uuid,uuid)')),false) then raise exception '062: protected baseline differs: public.orl_assign_slot(uuid,uuid,uuid)'; end if;
 if not coalesce((select md5(replace(prosrc,chr(13),''))='be1940a8970dbf808fff9ada9ea0bd5f' and prosecdef from pg_proc where oid=to_regprocedure('public.orl_move_postponed_checked(uuid,uuid,uuid,jsonb,text,uuid)')),false) then raise exception '062: protected baseline differs: public.orl_move_postponed_checked(uuid,uuid,uuid,jsonb,text,uuid)'; end if;
 if not not exists(select 1 from unnest(array['anon','authenticated','service_role']) r cross join unnest(array['orl_private.c1_read_schedule(uuid,integer,integer)','orl_private.c1_mask_json(jsonb,date)','public.orl_require_session(uuid)','public.orl_assign_slot(uuid,uuid,uuid)','public.orl_move_postponed_checked(uuid,uuid,uuid,jsonb,text,uuid)']) f where has_function_privilege(r,f,'EXECUTE')) then raise exception '062: private helpers must remain closed.'; end if;

 fn:=to_regprocedure('orl_private.c1_read_schedule(uuid,integer,integer)');
 select replace(prosrc,chr(13),''),proacl into source,before_acl from pg_proc where oid=fn and prosecdef and proconfig @> array['search_path=public, extensions'];
 if source is null or md5(source)<>'0c420957b11181dd4afb00401926ed57' then raise exception '062: orl_private.c1_read_schedule(uuid,integer,integer) baseline differs or already installed. Inspect before retrying.'; end if;
 definition:=replace(replace(pg_get_functiondef(fn),chr(13),''),source,$newbody$
declare
  v_user public.orl_users%rowtype;
begin
  v_user:=public.orl_require_session(p_session_token);
  perform public.orl_prepare_schedule(p_session_token,p_year,p_month);

  return query
  select
    s.id,s.ot_date,s.day_name,
    case when h.id is not null and s.status='ACTIVE' and not s.holiday_override
      then 'HOLIDAY' else s.status end,
    s.note,s.special_title,coalesce(h.title,''),
    coalesce(jsonb_agg(jsonb_build_object(
      'id',sl.id,
      'type',sl.slot_type,
      'number',sl.slot_number,
      'status',sl.status,
      'request_id',sl.request_id,
      'request_status',r.status,
      'deletion_status',r.deletion_status,
      'created_by',r.created_by,
      'created_by_role',creator.role,
      'patient_name',r.patient_name,
      'patient_ic',r.patient_ic,
      'age',coalesce((public.orl_age_parts(r.patient_ic,s.ot_date)->>'years')::integer,r.age),
      'age_months',coalesce((public.orl_age_parts(r.patient_ic,s.ot_date)->>'months')::integer,r.age_months),
      'mrn',r.mrn,
      'surgery',r.surgery,
      'diagnosis',r.diagnosis,
      'doctor',initcap(r.doctor),
      'specialist',initcap(r.specialist),
      'sub_specialty',r.sub_specialty,
      'phone',r.phone,
      'remark',r.remark,
      'postpone_count',r.postpone_count
    ) order by case when sl.slot_type='MAIN' then 0 else 1 end,sl.slot_number),'[]'::jsonb)
  from public.orl_ot_sessions s
  left join public.orl_holidays h on h.holiday_date=s.ot_date and h.is_active
  left join public.orl_ot_slots sl
    on sl.session_id=s.id
  left join public.orl_requests r on r.id=sl.request_id
  left join public.orl_users creator on creator.id=r.created_by
  where extract(year from s.ot_date)=p_year
    and extract(month from s.ot_date)=p_month
  group by s.id,h.id,h.title
  order by s.ot_date;
end $newbody$);
 execute definition;
 if not exists(select 1 from pg_proc where oid=fn and proacl is not distinct from before_acl and md5(replace(prosrc,chr(13),''))='0f922b237c5c2a89976c3b4c22345ae7') then
  raise exception '062: read definition/permissions verification failed. Rolled back.'; end if;

 fn:=to_regprocedure('public.orl_get_special_ot_days(uuid,integer)');
 select replace(prosrc,chr(13),''),proacl into source,before_acl from pg_proc where oid=fn and prosecdef and proconfig @> array['search_path=public, extensions'];
 if source is null or md5(source)<>'28b6422cd002ab43d0e4b470f7ff2cc5' then raise exception '062: public.orl_get_special_ot_days(uuid,integer) baseline differs or already installed. Inspect before retrying.'; end if;
 definition:=replace(replace(pg_get_functiondef(fn),chr(13),''),source,$newbody$
declare v_user public.orl_users%rowtype;
begin
  v_user:=public.orl_require_session(p_session_token);
  if p_year is null or p_year not between 2026 and 2100 then raise exception 'Invalid year.'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'session_id',s.id,'date',s.ot_date,'day_name',s.day_name,'title',s.special_title,
      'status',case when s.status='ACTIVE' and not s.holiday_override and exists(
        select 1 from public.orl_holidays h where h.holiday_date=s.ot_date and h.is_active
      ) then 'HOLIDAY' else s.status end,
      'main_available',(select count(*) from public.orl_ot_slots sl where sl.session_id=s.id and sl.slot_type='MAIN' and sl.status='AVAILABLE' and sl.request_id is null),
      'main_closed',(select count(*) from public.orl_ot_slots sl where sl.session_id=s.id and sl.slot_type='MAIN' and sl.status='CLOSED'),
      'main_total',(select count(*) from public.orl_ot_slots sl where sl.session_id=s.id and sl.slot_type='MAIN'),
      'special_available',(select count(*) from public.orl_ot_slots sl where sl.session_id=s.id and sl.slot_type='SPECIAL' and sl.status='AVAILABLE' and sl.request_id is null),
      'special_closed',(select count(*) from public.orl_ot_slots sl where sl.session_id=s.id and sl.slot_type='SPECIAL' and sl.status='CLOSED'),
      'special_total',(select count(*) from public.orl_ot_slots sl where sl.session_id=s.id and sl.slot_type='SPECIAL')
    ) order by s.ot_date) from public.orl_ot_sessions s
    where extract(year from s.ot_date)=p_year and trim(s.special_title)<>''
  ),'[]'::jsonb);
end $newbody$);
 execute definition;
 if not exists(select 1 from pg_proc where oid=fn and proacl is not distinct from before_acl and md5(replace(prosrc,chr(13),''))='be9cc43e84ccd5837ef94b01b9f309d1') then
  raise exception '062: read definition/permissions verification failed. Rolled back.'; end if;

 fn:=to_regprocedure('public.orl_get_year_month_counts(uuid,integer)');
 select replace(prosrc,chr(13),''),proacl into source,before_acl from pg_proc where oid=fn and prosecdef and proconfig @> array['search_path=public, extensions'];
 if source is null or md5(source)<>'0847482a5a1a701002c3113deb210291' then raise exception '062: public.orl_get_year_month_counts(uuid,integer) baseline differs or already installed. Inspect before retrying.'; end if;
 definition:=replace(replace(pg_get_functiondef(fn),chr(13),''),source,$newbody$
declare v_user public.orl_users%rowtype; m integer;
begin
 v_user:=public.orl_require_session(p_session_token);
 if p_year is null or p_year not between 2026 and 2100 then raise exception 'Invalid year.'; end if;
 for m in 1..12 loop perform public.orl_prepare_schedule(p_session_token,p_year,m); end loop;
 return (with counts as (
 select mon.n,
 count(sl.id) filter(where sl.slot_type='MAIN')::integer main_available,
 count(sl.id) filter(where sl.slot_type='SPECIAL')::integer special_available
 from generate_series(1,12) mon(n)
 left join public.orl_ot_sessions s on extract(year from s.ot_date)=p_year and extract(month from s.ot_date)=mon.n and s.status='ACTIVE'
 and (s.holiday_override or not exists(select 1 from public.orl_holidays h where h.holiday_date=s.ot_date and h.is_active))
 left join public.orl_ot_slots sl on sl.session_id=s.id and sl.status='AVAILABLE' and sl.request_id is null
 group by mon.n)
 select jsonb_agg(jsonb_build_object('month',n,'available',main_available+special_available,
 'main_available',main_available,'special_available',special_available) order by n) from counts);
end $newbody$);
 execute definition;
 if not exists(select 1 from pg_proc where oid=fn and proacl is not distinct from before_acl and md5(replace(prosrc,chr(13),''))='373d33d3fdd1abc3aed2e73ff3c22930') then
  raise exception '062: read definition/permissions verification failed. Rolled back.'; end if;
end $repair$;
notify pgrst,'reload schema';
commit;
