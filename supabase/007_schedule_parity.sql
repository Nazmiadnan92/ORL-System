-- ORL OT Management System: original-style schedule cards and controls
begin;

create or replace function public.orl_prepare_schedule(p_session_token uuid,p_year integer,p_month integer)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype; v_main integer; v_special integer;
begin
  v_user:=public.orl_require_session(p_session_token);
  if p_year not between 2026 and 2100 or p_month not between 1 and 12 then raise exception 'Invalid schedule period.'; end if;
  select setting_value::integer into v_main from public.orl_settings where setting_key='MAIN_SLOTS';
  select setting_value::integer into v_special from public.orl_settings where setting_key='SPECIAL_SLOTS';
  insert into public.orl_ot_sessions(ot_date,day_name)
  select d::date,trim(to_char(d,'Day')) from generate_series(make_date(p_year,p_month,1),(make_date(p_year,p_month,1)+interval '1 month - 1 day')::date,interval '1 day') d
  where extract(dow from d) in (0,3) on conflict(ot_date) do nothing;
  insert into public.orl_ot_slots(session_id,slot_type,slot_number)
  select s.id,x.slot_type,n from public.orl_ot_sessions s cross join (values('MAIN'::text,v_main),('SPECIAL'::text,v_special)) x(slot_type,maximum) cross join lateral generate_series(1,x.maximum)n
  where extract(year from s.ot_date)=p_year and extract(month from s.ot_date)=p_month on conflict(session_id,slot_type,slot_number) do nothing;
end $$;

drop function if exists public.orl_get_schedule(uuid,integer,integer);
create function public.orl_get_schedule(p_session_token uuid,p_year integer,p_month integer)
returns table(session_id uuid,ot_date date,day_name text,status text,note text,special_title text,holiday_name text,slots jsonb)
language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype;
begin
  v_user:=public.orl_require_session(p_session_token); perform public.orl_prepare_schedule(p_session_token,p_year,p_month);
  return query select s.id,s.ot_date,s.day_name,
    case when h.id is not null and s.status='ACTIVE' then 'HOLIDAY' else s.status end,
    s.note,s.special_title,coalesce(h.title,''),
    coalesce(jsonb_agg(jsonb_build_object('id',sl.id,'type',sl.slot_type,'number',sl.slot_number,'status',sl.status,'request_id',sl.request_id,
      'patient_name',r.patient_name,'patient_ic',r.patient_ic,'mrn',r.mrn,'surgery',r.surgery,'diagnosis',r.diagnosis,'doctor',r.doctor,
      'specialist',r.specialist,'sub_specialty',r.sub_specialty,'phone',r.phone,'remark',r.remark,'postpone_count',r.postpone_count)
      order by case when sl.slot_type='MAIN' then 0 else 1 end,sl.slot_number),'[]'::jsonb)
  from public.orl_ot_sessions s left join public.orl_holidays h on h.holiday_date=s.ot_date and h.is_active
  left join public.orl_ot_slots sl on sl.session_id=s.id left join public.orl_requests r on r.id=sl.request_id
  where extract(year from s.ot_date)=p_year and extract(month from s.ot_date)=p_month group by s.id,h.id,h.title order by s.ot_date;
end $$;

create or replace function public.orl_set_session(p_session_token uuid,p_session_id uuid,p_status text,p_title text default null)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype;
begin
  v_user:=public.orl_require_session(p_session_token); if v_user.role not in('ADMIN','WEBMASTER') then raise exception 'Admin access required.'; end if;
  if p_status is not null and p_status not in('ACTIVE','CANCELLED') then raise exception 'Invalid OT status.'; end if;
  update public.orl_ot_sessions set status=coalesce(p_status,status),special_title=coalesce(p_title,special_title),updated_by=v_user.id,updated_at=now() where id=p_session_id;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details) values(v_user.id,v_user.display_name,v_user.role,'OT_SESSION_UPDATED','OT_SESSION',p_session_id::text,coalesce(p_status,'')||' '||coalesce(p_title,''));
end $$;

create or replace function public.orl_clear_slot(p_session_token uuid,p_slot_id uuid)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype; v_slot public.orl_ot_slots%rowtype;
begin
  v_user:=public.orl_require_session(p_session_token); if v_user.role not in('ADMIN','WEBMASTER') then raise exception 'Admin access required.'; end if;
  select * into v_slot from public.orl_ot_slots where id=p_slot_id for update; if not found then raise exception 'Slot not found.'; end if;
  update public.orl_requests set assigned_slot_id=null,status='APPROVED',updated_at=now() where id=v_slot.request_id;
  update public.orl_ot_slots set request_id=null,status='AVAILABLE',updated_by=v_user.id,updated_at=now() where id=p_slot_id;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details) values(v_user.id,v_user.display_name,v_user.role,'OT_SLOT_CLEARED','OT_SLOT',p_slot_id::text,'Patient removed from OT slot');
end $$;

create or replace function public.orl_postpone_slot(p_session_token uuid,p_slot_id uuid,p_reason text default '')
returns void language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype; v_slot public.orl_ot_slots%rowtype; v_req public.orl_requests%rowtype; item jsonb; packed jsonb; target_id uuid; n integer:=1;
begin
  v_user:=public.orl_require_session(p_session_token); if v_user.role not in('ADMIN','WEBMASTER') then raise exception 'Admin access required.'; end if;
  select * into v_slot from public.orl_ot_slots where id=p_slot_id for update; if not found or v_slot.request_id is null then raise exception 'Assigned slot not found.'; end if;
  select * into v_req from public.orl_requests where id=v_slot.request_id for update;
  update public.orl_requests set assigned_slot_id=null,status='APPROVED',postpone_count=postpone_count+1,
    postpone_history=postpone_history||jsonb_build_array(jsonb_build_object('date',now(),'ot_date',(select ot_date from public.orl_ot_sessions where id=v_slot.session_id),'slot',v_slot.slot_number,'reason',coalesce(p_reason,''),'by',v_user.display_name)),updated_at=now() where id=v_req.id;
  update public.orl_ot_slots set request_id=null,status='AVAILABLE',updated_by=v_user.id,updated_at=now() where id=v_slot.id;
  if v_slot.slot_type='MAIN' then
    select coalesce(jsonb_agg(jsonb_build_object('request_id',request_id,'status',status) order by slot_number),'[]'::jsonb) into packed from public.orl_ot_slots where session_id=v_slot.session_id and slot_type='MAIN' and request_id is not null;
    update public.orl_ot_slots set request_id=null,status='AVAILABLE' where session_id=v_slot.session_id and slot_type='MAIN';
    for item in select * from jsonb_array_elements(packed) loop
      select id into target_id from public.orl_ot_slots where session_id=v_slot.session_id and slot_type='MAIN' and slot_number=n;
      update public.orl_ot_slots set request_id=(item->>'request_id')::uuid,status=item->>'status',updated_by=v_user.id,updated_at=now() where id=target_id;
      update public.orl_requests set assigned_slot_id=target_id where id=(item->>'request_id')::uuid; n:=n+1;
    end loop;
  end if;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details) values(v_user.id,v_user.display_name,v_user.role,'OT_POSTPONED','REQUEST',v_req.id::text,coalesce(p_reason,''));
end $$;

create or replace function public.orl_update_slot_request(p_session_token uuid,p_slot_id uuid,p_data jsonb)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype; v_request_id uuid;
begin
  v_user:=public.orl_require_session(p_session_token); if v_user.role not in('ADMIN','WEBMASTER') then raise exception 'Admin access required.'; end if;
  select request_id into v_request_id from public.orl_ot_slots where id=p_slot_id; if v_request_id is null then raise exception 'Assigned request not found.'; end if;
  update public.orl_requests set patient_ic=coalesce(p_data->>'patient_ic',patient_ic),mrn=coalesce(p_data->>'mrn',mrn),patient_name=coalesce(p_data->>'patient_name',patient_name),surgery=coalesce(p_data->>'surgery',surgery),diagnosis=coalesce(p_data->>'diagnosis',diagnosis),doctor=coalesce(p_data->>'doctor',doctor),specialist=coalesce(p_data->>'specialist',specialist),sub_specialty=coalesce(p_data->>'sub_specialty',sub_specialty),phone=coalesce(p_data->>'phone',phone),remark=coalesce(p_data->>'remark',remark),updated_at=now() where id=v_request_id;
end $$;

grant execute on function public.orl_prepare_schedule(uuid,integer,integer),public.orl_get_schedule(uuid,integer,integer),public.orl_set_session(uuid,uuid,text,text),public.orl_clear_slot(uuid,uuid),public.orl_postpone_slot(uuid,uuid,text),public.orl_update_slot_request(uuid,uuid,jsonb) to anon,authenticated;
commit;
