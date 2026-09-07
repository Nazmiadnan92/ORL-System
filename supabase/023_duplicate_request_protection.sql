-- ORL OT Management System: active patient duplicate protection
-- Run once in Supabase SQL Editor after 022.

begin;

create or replace function public.orl_check_duplicate_request(
  p_session_token uuid,
  p_mrn text,
  p_surgery text default ''
)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare
  v_user public.orl_users%rowtype;
  v_mrn text:=lower(trim(coalesce(p_mrn,'')));
  v_surgery text:=lower(regexp_replace(trim(coalesce(p_surgery,'')),'\s+',' ','g'));
  v_matches jsonb;
begin
  v_user:=public.orl_require_session(p_session_token);
  if v_mrn='' then return jsonb_build_object('has_active',false,'exact_count',0,'matches','[]'::jsonb); end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',r.id,
    'request_number',r.request_number,
    'patient_name',r.patient_name,
    'mrn',r.mrn,
    'surgery',r.surgery,
    'diagnosis',r.diagnosis,
    'status',r.status,
    'deletion_status',r.deletion_status,
    'ot_date',s.ot_date,
    'slot_type',sl.slot_type,
    'slot_number',sl.slot_number,
    'exact',v_surgery<>'' and lower(regexp_replace(trim(r.surgery),'\s+',' ','g'))=v_surgery
  ) order by r.created_at desc),'[]'::jsonb)
  into v_matches
  from public.orl_requests r
  left join public.orl_ot_slots sl on sl.id=r.assigned_slot_id
  left join public.orl_ot_sessions s on s.id=sl.session_id
  where lower(trim(r.mrn))=v_mrn
    and r.status not in('CANCELLED','COMPLETED','REJECTED');

  return jsonb_build_object(
    'has_active',jsonb_array_length(v_matches)>0,
    'exact_count',(select count(*) from jsonb_array_elements(v_matches) item where coalesce((item->>'exact')::boolean,false)),
    'matches',v_matches
  );
end $$;

create or replace function public.orl_create_request(p_session_token uuid,p_data jsonb)
returns uuid language plpgsql security definer set search_path=public,extensions as $$
declare
  v_user public.orl_users%rowtype;
  v_id uuid; v_number text; v_age integer; calculated_age integer;
  ic text:=trim(coalesce(p_data->>'patient_ic',''));
  doctor_name text;
  v_mrn text:=lower(trim(coalesce(p_data->>'mrn','')));
  v_surgery text:=lower(regexp_replace(trim(coalesce(p_data->>'surgery','')),'\s+',' ','g'));
  v_allow_duplicate boolean:=lower(coalesce(p_data->>'allow_duplicate','false')) in('true','1','yes','on');
  v_override_reason text:=trim(coalesce(p_data->>'duplicate_reason',''));
  v_existing_id uuid; v_existing_number text;
begin
  v_user:=public.orl_require_session(p_session_token);
  begin v_age:=nullif(trim(p_data->>'age'),'')::integer;
  exception when invalid_text_representation then raise exception 'Age must be a whole number.';
  end;
  calculated_age:=public.orl_age_from_ic(ic,current_date);
  if calculated_age is not null then v_age:=calculated_age; end if;
  if v_age is null or v_age not between 0 and 130 then raise exception 'Enter an age between 0 and 130.'; end if;
  if v_mrn='' then raise exception 'MRN is required.'; end if;
  if nullif(trim(p_data->>'patient_name'),'') is null then raise exception 'Patient Name is required.'; end if;
  if v_surgery='' then raise exception 'Surgery is required.'; end if;
  if nullif(trim(p_data->>'diagnosis'),'') is null then raise exception 'Diagnosis is required.'; end if;
  if nullif(trim(p_data->>'specialist'),'') is null then raise exception 'Specialist is required.'; end if;
  if nullif(trim(p_data->>'sub_specialty'),'') is null then raise exception 'Sub-specialty is required.'; end if;
  if nullif(trim(p_data->>'phone'),'') is null then raise exception 'Phone is required.'; end if;

  -- Serialise equal MRN + procedure submissions so double-clicks cannot create two rows.
  perform pg_advisory_xact_lock(hashtextextended(v_mrn||chr(31)||v_surgery,0));
  select r.id,r.request_number into v_existing_id,v_existing_number
  from public.orl_requests r
  where lower(trim(r.mrn))=v_mrn
    and lower(regexp_replace(trim(r.surgery),'\s+',' ','g'))=v_surgery
    and r.status not in('CANCELLED','COMPLETED','REJECTED')
  order by r.created_at desc limit 1;

  if v_existing_id is not null then
    if v_user.role not in('ADMIN','WEBMASTER') or not v_allow_duplicate then
      raise exception 'Duplicate blocked: active request % already has the same MRN and procedure.',v_existing_number;
    end if;
    if v_override_reason='' then raise exception 'An override reason is required for a duplicate request.'; end if;
  end if;

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
  if v_existing_id is not null then
    insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
    values(v_user.id,v_user.display_name,v_user.role,'DUPLICATE_OVERRIDE','REQUEST',v_id::text,
      'Override of '||v_existing_number||' | Reason: '||v_override_reason);
  end if;
  return v_id;
end $$;

revoke all on function public.orl_check_duplicate_request(uuid,text,text) from public,anon,authenticated;
grant execute on function public.orl_check_duplicate_request(uuid,text,text) to anon,authenticated;
grant execute on function public.orl_create_request(uuid,jsonb) to anon,authenticated;

notify pgrst, 'reload schema';
commit;
