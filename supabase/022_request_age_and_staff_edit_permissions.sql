-- ORL OT Management System: stored patient age, doctor defaults and staff edit limits
-- Run once in Supabase SQL Editor after 021.

begin;

alter table public.orl_requests
  add column if not exists age integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname='orl_requests_age_check'
      and conrelid='public.orl_requests'::regclass
  ) then
    alter table public.orl_requests
      add constraint orl_requests_age_check check (age is null or age between 0 and 130);
  end if;
end $$;

create or replace function public.orl_age_from_ic(p_ic text,p_at date default current_date)
returns integer language plpgsql stable set search_path=public,extensions as $$
declare
  raw text:=trim(coalesce(p_ic,''));
  digits text;
  yy integer; mm integer; dd integer; birth_date date; ref_date date:=coalesce(p_at,current_date);
  result integer;
begin
  if raw !~ '^[0-9]{6}-?[0-9]{2}-?[0-9]{4}$' then return null; end if;
  digits:=regexp_replace(raw,'[^0-9]','','g');
  yy:=substring(digits,1,2)::integer;
  mm:=substring(digits,3,2)::integer;
  dd:=substring(digits,5,2)::integer;
  begin
    birth_date:=make_date(2000+yy,mm,dd);
    if birth_date>ref_date then birth_date:=make_date(1900+yy,mm,dd); end if;
  exception when others then
    return null;
  end;
  result:=extract(year from age(ref_date,birth_date))::integer;
  if result<0 or result>130 then return null; end if;
  return result;
end $$;

update public.orl_requests
set age=public.orl_age_from_ic(patient_ic,(created_at at time zone 'Asia/Kuala_Lumpur')::date)
where age is null
  and public.orl_age_from_ic(patient_ic,(created_at at time zone 'Asia/Kuala_Lumpur')::date) is not null;

create or replace function public.orl_create_request(p_session_token uuid,p_data jsonb)
returns uuid language plpgsql security definer set search_path=public,extensions as $$
declare
  v_user public.orl_users%rowtype;
  v_id uuid; v_number text; v_age integer; calculated_age integer;
  ic text:=trim(coalesce(p_data->>'patient_ic',''));
  doctor_name text;
begin
  v_user:=public.orl_require_session(p_session_token);
  begin v_age:=nullif(trim(p_data->>'age'),'')::integer;
  exception when invalid_text_representation then raise exception 'Age must be a whole number.';
  end;
  calculated_age:=public.orl_age_from_ic(ic,current_date);
  if calculated_age is not null then v_age:=calculated_age; end if;
  if v_age is null or v_age not between 0 and 130 then raise exception 'Enter an age between 0 and 130.'; end if;
  if nullif(trim(p_data->>'mrn'),'') is null then raise exception 'MRN is required.'; end if;
  if nullif(trim(p_data->>'patient_name'),'') is null then raise exception 'Patient Name is required.'; end if;
  if nullif(trim(p_data->>'surgery'),'') is null then raise exception 'Surgery is required.'; end if;
  if nullif(trim(p_data->>'diagnosis'),'') is null then raise exception 'Diagnosis is required.'; end if;
  if nullif(trim(p_data->>'specialist'),'') is null then raise exception 'Specialist is required.'; end if;
  if nullif(trim(p_data->>'sub_specialty'),'') is null then raise exception 'Sub-specialty is required.'; end if;
  if nullif(trim(p_data->>'phone'),'') is null then raise exception 'Phone is required.'; end if;
  doctor_name:=coalesce(nullif(trim(p_data->>'doctor'),''),v_user.display_name);
  v_number:='REQ-'||to_char(current_date,'YYYY')||'-'||lpad(nextval('public.orl_request_number_seq')::text,6,'0');
  insert into public.orl_requests(
    request_number,patient_ic,age,mrn,patient_name,surgery,diagnosis,doctor,
    specialist,sub_specialty,phone,remark,created_by
  ) values(
    v_number,ic,v_age,trim(p_data->>'mrn'),trim(p_data->>'patient_name'),
    trim(p_data->>'surgery'),trim(p_data->>'diagnosis'),doctor_name,
    trim(p_data->>'specialist'),trim(p_data->>'sub_specialty'),trim(p_data->>'phone'),
    coalesce(p_data->>'remark',''),v_user.id
  ) returning id into v_id;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
  values(v_user.id,v_user.display_name,v_user.role,'REQUEST_CREATED','REQUEST',v_id::text,'Draft request created');
  return v_id;
end $$;

create or replace function public.orl_get_schedule(p_session_token uuid,p_year integer,p_month integer)
returns table(session_id uuid,ot_date date,day_name text,status text,note text,special_title text,holiday_name text,slots jsonb)
language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype;
begin
  v_user:=public.orl_require_session(p_session_token);
  perform public.orl_prepare_schedule(p_session_token,p_year,p_month);
  return query
  select s.id,s.ot_date,s.day_name,
    case when h.id is not null and s.status='ACTIVE' and not s.holiday_override then 'HOLIDAY' else s.status end,
    s.note,s.special_title,coalesce(h.title,''),
    coalesce(jsonb_agg(jsonb_build_object(
      'id',sl.id,'type',sl.slot_type,'number',sl.slot_number,'status',sl.status,
      'request_id',sl.request_id,'request_status',r.status,'created_by',r.created_by,
      'patient_name',r.patient_name,'patient_ic',r.patient_ic,'age',r.age,'mrn',r.mrn,
      'surgery',r.surgery,'diagnosis',r.diagnosis,'doctor',r.doctor,
      'specialist',r.specialist,'sub_specialty',r.sub_specialty,'phone',r.phone,
      'remark',r.remark,'postpone_count',r.postpone_count)
      order by case when sl.slot_type='MAIN' then 0 else 1 end,sl.slot_number),'[]'::jsonb)
  from public.orl_ot_sessions s
  left join public.orl_holidays h on h.holiday_date=s.ot_date and h.is_active
  left join public.orl_ot_slots sl on sl.session_id=s.id and (v_user.role<>'STAFF' or sl.slot_type='MAIN')
  left join public.orl_requests r on r.id=sl.request_id
  where extract(year from s.ot_date)=p_year and extract(month from s.ot_date)=p_month
  group by s.id,h.id,h.title
  order by s.ot_date;
end $$;

create or replace function public.orl_edit_scheduled_request(p_session_token uuid,p_slot_id uuid,p_data jsonb,p_action text)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare
  v_user public.orl_users%rowtype;
  v_slot public.orl_ot_slots%rowtype;
  v_req public.orl_requests%rowtype;
  act text:=upper(p_action); reason text; v_age integer; calculated_age integer; new_ic text;
begin
  v_user:=public.orl_require_session(p_session_token);
  if act not in('CONFIRM','POSTPONE','CANCEL') then raise exception 'Invalid status action.'; end if;
  select * into v_slot from public.orl_ot_slots where id=p_slot_id for update;
  if not found or v_slot.request_id is null then raise exception 'Assigned request not found.'; end if;
  select * into v_req from public.orl_requests where id=v_slot.request_id for update;
  if not found then raise exception 'Assigned request not found.'; end if;
  if v_user.role='STAFF' and v_req.created_by<>v_user.id and act<>'CANCEL' then raise exception 'You do not have access.'; end if;

  if v_user.role='STAFF' then
    update public.orl_requests set
      surgery=coalesce(nullif(trim(p_data->>'surgery'),''),surgery),
      diagnosis=coalesce(nullif(trim(p_data->>'diagnosis'),''),diagnosis),updated_at=now()
    where id=v_req.id;
  else
    new_ic:=coalesce(p_data->>'patient_ic',v_req.patient_ic);
    begin v_age:=coalesce(nullif(trim(p_data->>'age'),'')::integer,v_req.age);
    exception when invalid_text_representation then raise exception 'Age must be a whole number.';
    end;
    calculated_age:=public.orl_age_from_ic(new_ic,current_date);
    if calculated_age is not null then v_age:=calculated_age; end if;
    if v_age is null or v_age not between 0 and 130 then raise exception 'Enter an age between 0 and 130.'; end if;
    update public.orl_requests set
      patient_ic=new_ic,age=v_age,mrn=coalesce(p_data->>'mrn',mrn),
      patient_name=coalesce(p_data->>'patient_name',patient_name),
      surgery=coalesce(p_data->>'surgery',surgery),diagnosis=coalesce(p_data->>'diagnosis',diagnosis),
      doctor=coalesce(p_data->>'doctor',doctor),specialist=coalesce(p_data->>'specialist',specialist),
      sub_specialty=coalesce(p_data->>'sub_specialty',sub_specialty),phone=coalesce(p_data->>'phone',phone),
      remark=coalesce(p_data->>'remark',remark),updated_at=now()
    where id=v_req.id;
  end if;

  if act='CANCEL' and v_user.role='STAFF' then
    if v_req.deletion_status='PENDING' then raise exception 'A cancellation request is already pending review.'; end if;
    reason:=coalesce(nullif(trim(p_data->>'cancel_reason'),''),'Cancellation requested by Staff');
    update public.orl_requests set deletion_status='PENDING',deletion_reason=reason,
      deletion_requested_by=v_user.id,deletion_requested_at=now(),updated_at=now()
    where id=v_req.id;
    insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
    values(v_user.id,v_user.display_name,v_user.role,'STAFF_CANCELLATION_REQUESTED','REQUEST',v_req.id::text,reason);
    return;
  end if;
  if act='CONFIRM' and v_user.role in('ADMIN','WEBMASTER') then
    update public.orl_requests set status='SCHEDULED',updated_at=now() where id=v_req.id;
    update public.orl_ot_slots set status='CONFIRMED',updated_by=v_user.id,updated_at=now() where id=p_slot_id;
  elsif act='CANCEL' then
    reason:=coalesce(nullif(trim(p_data->>'cancel_reason'),''),nullif(trim(p_data->>'remark'),''),'Cancelled by '||v_user.display_name);
    update public.orl_requests set status='CANCELLED',assigned_slot_id=null,
      deletion_status='APPROVED',deletion_reason=reason,deletion_requested_by=v_user.id,
      deletion_requested_at=now(),updated_at=now() where id=v_req.id;
    update public.orl_ot_slots set request_id=null,status='AVAILABLE',updated_by=v_user.id,updated_at=now() where id=p_slot_id;
    if v_slot.slot_type='MAIN' then perform public.orl_compact_main(v_slot.session_id,v_user.id); end if;
  end if;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
  values(v_user.id,v_user.display_name,v_user.role,'SLOT_EDIT_'||act,'REQUEST',v_req.id::text,
    case when act='CANCEL' then 'Patient cancelled by Admin/Webmaster; OT slot released; cancellation record retained'
         when v_user.role='STAFF' then 'Staff updated Surgery / Procedure and Diagnosis'
         else 'Patient details updated' end);
end $$;

revoke all on function public.orl_age_from_ic(text,date) from public,anon,authenticated;
grant execute on function public.orl_create_request(uuid,jsonb),public.orl_get_schedule(uuid,integer,integer),public.orl_edit_scheduled_request(uuid,uuid,jsonb,text) to anon,authenticated;

notify pgrst, 'reload schema';
commit;
