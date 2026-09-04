-- ORL OT Management System: request notifications, month summary, edit/cancel and postpone-to-new-slot
begin;

create or replace function public.orl_compact_main(p_session_id uuid,p_user_id uuid)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare packed jsonb; item jsonb; target_id uuid; n integer:=1;
begin
  select coalesce(jsonb_agg(jsonb_build_object('request_id',request_id,'status',status) order by slot_number),'[]'::jsonb) into packed
  from public.orl_ot_slots where session_id=p_session_id and slot_type='MAIN' and request_id is not null;
  update public.orl_ot_slots set request_id=null,status='AVAILABLE' where session_id=p_session_id and slot_type='MAIN';
  for item in select * from jsonb_array_elements(packed) loop
    select id into target_id from public.orl_ot_slots where session_id=p_session_id and slot_type='MAIN' and slot_number=n;
    update public.orl_ot_slots set request_id=(item->>'request_id')::uuid,status=item->>'status',updated_by=p_user_id,updated_at=now() where id=target_id;
    update public.orl_requests set assigned_slot_id=target_id,updated_at=now() where id=(item->>'request_id')::uuid; n:=n+1;
  end loop;
end $$;
revoke all on function public.orl_compact_main(uuid,uuid) from public,anon,authenticated;

create or replace function public.orl_get_notifications(p_session_token uuid)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype;
begin
  v_user:=public.orl_require_session(p_session_token);
  return jsonb_build_object('requests',case when v_user.role in('ADMIN','WEBMASTER') then (select count(*) from public.orl_requests where status='CONFIRMED') else 0 end,
    'deletions',case when v_user.role in('ADMIN','WEBMASTER') then (select count(*) from public.orl_requests where deletion_status='PENDING') else 0 end);
end $$;

create or replace function public.orl_get_requests(p_session_token uuid)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype;
begin
  v_user:=public.orl_require_session(p_session_token);
  return coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'request_number',r.request_number,'patient_name',r.patient_name,'mrn',r.mrn,'surgery',r.surgery,'doctor',r.doctor,'status',r.status,'created_at',r.created_at,'postpone_count',r.postpone_count,'deletion_status',r.deletion_status,'assigned_slot_id',r.assigned_slot_id,'ot_date',s.ot_date,'slot_type',sl.slot_type,'slot_number',sl.slot_number) order by r.created_at desc) from public.orl_requests r left join public.orl_ot_slots sl on sl.id=r.assigned_slot_id left join public.orl_ot_sessions s on s.id=sl.session_id where v_user.role<>'STAFF' or r.created_by=v_user.id),'[]'::jsonb);
end $$;

create or replace function public.orl_get_year_month_counts(p_session_token uuid,p_year integer)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype; m integer;
begin
  v_user:=public.orl_require_session(p_session_token);
  for m in 1..12 loop perform public.orl_prepare_schedule(p_session_token,p_year,m); end loop;
  return coalesce((select jsonb_agg(jsonb_build_object('month',x.m,'available',x.available) order by x.m) from
    (select m.m,count(sl.id) filter(where sl.status='AVAILABLE' and s.status='ACTIVE' and h.id is null)::integer available
     from generate_series(1,12)m(m) left join public.orl_ot_sessions s on extract(year from s.ot_date)=p_year and extract(month from s.ot_date)=m.m
     left join public.orl_holidays h on h.holiday_date=s.ot_date and h.is_active left join public.orl_ot_slots sl on sl.session_id=s.id and (v_user.role<>'STAFF' or sl.slot_type='MAIN') group by m.m)x),'[]'::jsonb);
end $$;

create or replace function public.orl_get_schedule(p_session_token uuid,p_year integer,p_month integer)
returns table(session_id uuid,ot_date date,day_name text,status text,note text,special_title text,holiday_name text,slots jsonb)
language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype;
begin
  v_user:=public.orl_require_session(p_session_token); perform public.orl_prepare_schedule(p_session_token,p_year,p_month);
  return query select s.id,s.ot_date,s.day_name,case when h.id is not null and s.status='ACTIVE' then 'HOLIDAY' else s.status end,s.note,s.special_title,coalesce(h.title,''),
    coalesce(jsonb_agg(jsonb_build_object('id',sl.id,'type',sl.slot_type,'number',sl.slot_number,'status',sl.status,'request_id',sl.request_id,'request_status',r.status,
      'created_by',r.created_by,'patient_name',r.patient_name,'patient_ic',r.patient_ic,'mrn',r.mrn,'surgery',r.surgery,'diagnosis',r.diagnosis,'doctor',r.doctor,'specialist',r.specialist,
      'sub_specialty',r.sub_specialty,'phone',r.phone,'remark',r.remark,'postpone_count',r.postpone_count)
      order by case when sl.slot_type='MAIN' then 0 else 1 end,sl.slot_number),'[]'::jsonb)
  from public.orl_ot_sessions s left join public.orl_holidays h on h.holiday_date=s.ot_date and h.is_active left join public.orl_ot_slots sl on sl.session_id=s.id and (v_user.role<>'STAFF' or sl.slot_type='MAIN')
  left join public.orl_requests r on r.id=sl.request_id where extract(year from s.ot_date)=p_year and extract(month from s.ot_date)=p_month group by s.id,h.id,h.title order by s.ot_date;
end $$;

create or replace function public.orl_edit_scheduled_request(p_session_token uuid,p_slot_id uuid,p_data jsonb,p_action text)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype; v_slot public.orl_ot_slots%rowtype; v_req public.orl_requests%rowtype; act text:=upper(p_action);
begin
  v_user:=public.orl_require_session(p_session_token); select * into v_slot from public.orl_ot_slots where id=p_slot_id for update;
  select * into v_req from public.orl_requests where id=v_slot.request_id for update; if not found then raise exception 'Assigned request not found.'; end if;
  if v_user.role='STAFF' and v_req.created_by<>v_user.id then raise exception 'You do not have access.'; end if;
  update public.orl_requests set patient_ic=coalesce(p_data->>'patient_ic',patient_ic),mrn=coalesce(p_data->>'mrn',mrn),patient_name=coalesce(p_data->>'patient_name',patient_name),surgery=coalesce(p_data->>'surgery',surgery),diagnosis=coalesce(p_data->>'diagnosis',diagnosis),doctor=coalesce(p_data->>'doctor',doctor),specialist=coalesce(p_data->>'specialist',specialist),sub_specialty=coalesce(p_data->>'sub_specialty',sub_specialty),phone=coalesce(p_data->>'phone',phone),remark=coalesce(p_data->>'remark',remark),status=case when act='CANCEL' then 'CANCELLED' when act='CONFIRM' and v_user.role in('ADMIN','WEBMASTER') then 'SCHEDULED' else status end,updated_at=now() where id=v_req.id;
  if act='CONFIRM' and v_user.role in('ADMIN','WEBMASTER') then update public.orl_ot_slots set status='CONFIRMED',updated_by=v_user.id,updated_at=now() where id=p_slot_id;
  elsif act not in('CONFIRM','POSTPONE','CANCEL') then raise exception 'Invalid status action.'; end if;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details) values(v_user.id,v_user.display_name,v_user.role,'SLOT_EDIT_'||act,'REQUEST',v_req.id::text,'Patient details updated');
end $$;

create or replace function public.orl_move_postponed(p_session_token uuid,p_from_slot_id uuid,p_to_slot_id uuid,p_data jsonb,p_reason text)
returns text language plpgsql security definer set search_path=public,extensions as $$
declare v_user public.orl_users%rowtype; a public.orl_ot_slots%rowtype; b public.orl_ot_slots%rowtype; r public.orl_requests%rowtype; old_date date; new_date date; new_status text;
begin
  v_user:=public.orl_require_session(p_session_token); select * into a from public.orl_ot_slots where id=p_from_slot_id for update; select * into b from public.orl_ot_slots where id=p_to_slot_id for update;
  if a.request_id is null then raise exception 'Original patient slot not found.'; end if; if b.request_id is not null or b.status<>'AVAILABLE' then raise exception 'The selected slot is no longer available.'; end if;
  select * into r from public.orl_requests where id=a.request_id for update; if v_user.role='STAFF' and r.created_by<>v_user.id then raise exception 'You do not have access.'; end if;
  if v_user.role='STAFF' and b.slot_type='SPECIAL' then raise exception 'Special slots are available to Admin and Webmaster only.'; end if;
  select ot_date into old_date from public.orl_ot_sessions where id=a.session_id; select ot_date into new_date from public.orl_ot_sessions where id=b.session_id;
  new_status:=case when v_user.role='STAFF' then 'RESERVED' else 'CONFIRMED' end;
  update public.orl_ot_slots set request_id=null,status='AVAILABLE',updated_by=v_user.id,updated_at=now() where id=a.id;
  update public.orl_ot_slots set request_id=r.id,status=new_status,updated_by=v_user.id,updated_at=now() where id=b.id;
  update public.orl_requests set patient_ic=coalesce(p_data->>'patient_ic',patient_ic),mrn=coalesce(p_data->>'mrn',mrn),patient_name=coalesce(p_data->>'patient_name',patient_name),surgery=coalesce(p_data->>'surgery',surgery),diagnosis=coalesce(p_data->>'diagnosis',diagnosis),doctor=coalesce(p_data->>'doctor',doctor),specialist=coalesce(p_data->>'specialist',specialist),sub_specialty=coalesce(p_data->>'sub_specialty',sub_specialty),phone=coalesce(p_data->>'phone',phone),remark=coalesce(p_data->>'remark',remark),assigned_slot_id=b.id,status=case when new_status='RESERVED' then 'CONFIRMED' else 'SCHEDULED' end,postpone_count=postpone_count+1,postpone_history=postpone_history||jsonb_build_array(jsonb_build_object('date',now(),'by',v_user.display_name,'from',old_date||' '||a.slot_type||' Slot '||a.slot_number,'to',new_date||' '||b.slot_type||' Slot '||b.slot_number,'reason',coalesce(p_reason,''))),updated_at=now() where id=r.id;
  if a.slot_type='MAIN' then perform public.orl_compact_main(a.session_id,v_user.id); end if;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details) values(v_user.id,v_user.display_name,v_user.role,'PATIENT_POSTPONED','REQUEST',r.id::text,old_date||' to '||new_date||' | '||coalesce(p_reason,'')); return new_status;
end $$;

grant execute on function public.orl_get_notifications(uuid),public.orl_get_requests(uuid),public.orl_get_year_month_counts(uuid,integer),public.orl_get_schedule(uuid,integer,integer),public.orl_edit_scheduled_request(uuid,uuid,jsonb,text),public.orl_move_postponed(uuid,uuid,uuid,jsonb,text) to anon,authenticated;
commit;
