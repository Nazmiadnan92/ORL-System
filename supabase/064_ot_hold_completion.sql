-- Explicit OT Hold and completion. Installation never changes existing patient state.
-- Hold retains occupancy; only a successful protected MOVE counts a postponement.
-- Completed episodes retain their historical slot and remain available for authorized reads/exports.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $baseline$
declare item record;
begin
 if exists(select 1 from information_schema.columns where table_schema='public' and table_name='orl_requests' and column_name='ot_hold')
   or to_regprocedure('public.orl_ic_ot_lifecycle(uuid,uuid,uuid,text,text,uuid,timestamptz)') is not null then
  raise exception '064: lifecycle migration already installed or partial schema differs. Inspect before retrying.';
 end if;
 if orl_private.c1_recovery_ready() is distinct from true or (orl_private.c6_stats()->>'cutover_complete')::boolean is distinct from true then
  raise exception '064: completed protected recovery/cutover baseline required.';
 end if;
 for item in select * from (values
  ('public.orl_require_session(uuid)','ba9d29923e7269729c8025bf1e266208'),
  ('orl_private.c1_read_schedule(uuid,integer,integer)','0f922b237c5c2a89976c3b4c22345ae7'),
  ('public.orl_ic_c1_mutate(uuid,text,uuid,uuid,uuid,jsonb,text,text,text,jsonb,jsonb,uuid,timestamptz)','9369627b09c1739c304e1c7256b3eaa7'),
  ('public.orl_move_postponed_checked(uuid,uuid,uuid,jsonb,text,uuid)','8bc9b710b397d1dbb10853d82949d3ac'),
  ('public.orl_edit_scheduled_request_checked(uuid,uuid,jsonb,text,uuid)','1b0ee59e8b8e3dbf12d92d0805fd33a5'),
  ('orl_private.c1_mask_json(jsonb,date)','f47cec01cc6028c6320a2b8bc8fb2115'),
  ('public.orl_compact_main(uuid,uuid)','079e866e84bcbd26f029ffe83f78ac75'),
  ('public.orl_db_import_locked(uuid,text,jsonb)','164c6fcc821be0506181321e679db00a'),
  ('orl_private.ot_export_snapshot(uuid)','cd5b92edf6603818b89ff65207ee6970'),
  ('public.orl_clear_slot_checked(uuid,uuid,uuid)','33f1f6ca70fd093b2ecaf3b9f3b0916a'),
  ('public.orl_swap_slots_checked(uuid,uuid,uuid,uuid,uuid)','d76fe9d357abdb069608a8433ec7f824'),
  ('public.orl_review_request(uuid,uuid,text,text)','679cf66be2cd0b0ce655cdec1125133e'),
  ('public.orl_ic_c1_deletion(uuid,text,uuid,uuid,timestamptz,uuid,text)','7e8e1edc7d9e4d3f2e9c4357324af389'),
  ('public.orl_booking_move_view(uuid,uuid)','054330db487f9f3d05e2c2fa9ce59817'),
  ('public.orl_booking_move_request(uuid,uuid,date,text,uuid,timestamptz,uuid)','df32b62cb92fec497eb4e14996543860'),
  ('public.orl_booking_move_review(uuid,uuid,text,uuid,timestamptz,timestamptz,uuid)','e69eff4e6a3a4d5ad0943275662e81ad')
 ) v(signature,expected_md5) loop
  if not coalesce((select prosecdef=(item.signature<>'orl_private.ot_export_snapshot(uuid)') and md5(replace(prosrc,chr(13),''))=item.expected_md5
   from pg_proc where oid=to_regprocedure(item.signature)),false) then
   raise exception '064: protected baseline differs: %',item.signature;
  end if;
 end loop;
 if exists(select 1 from unnest(array['anon','authenticated','service_role']) role_name
  cross join unnest(array['public.orl_require_session(uuid)','public.orl_move_postponed_checked(uuid,uuid,uuid,jsonb,text,uuid)',
   'public.orl_edit_scheduled_request_checked(uuid,uuid,jsonb,text,uuid)',
   'public.orl_clear_slot_checked(uuid,uuid,uuid)','public.orl_swap_slots_checked(uuid,uuid,uuid,uuid,uuid)','public.orl_review_request(uuid,uuid,text,text)',
   'public.orl_db_import_locked(uuid,text,jsonb)','orl_private.c1_mask_json(jsonb,date)','orl_private.ot_export_snapshot(uuid)']) signature
  where has_function_privilege(role_name,signature,'EXECUTE')) then raise exception '064: private helper permissions differ.'; end if;
 if exists(select 1 from unnest(array['anon','authenticated']) role_name
  where has_function_privilege(role_name,'public.orl_compact_main(uuid,uuid)','EXECUTE')) then
  raise exception '064: compaction must remain inaccessible to browser roles.';
 end if;
end $baseline$;

alter table public.orl_requests
 add column ot_hold boolean not null default false,
 add column ot_hold_reason text not null default '',
 add column ot_hold_at timestamptz,
 add column ot_hold_by uuid references public.orl_users(id) on delete set null,
 add column completed_at timestamptz,
 add column completed_by uuid references public.orl_users(id) on delete set null,
 add constraint orl_requests_ot_hold_state check (
  (ot_hold and status in('SCHEDULED','CONFIRMED') and ot_hold_reason ~ '[^[:space:]]'
   and length(ot_hold_reason)<=4096 and ot_hold_at is not null and isfinite(ot_hold_at))
  or (not ot_hold and ot_hold_reason='' and ot_hold_at is null and ot_hold_by is null)),
 add constraint orl_requests_completion_state check (
  (completed_at is null and completed_by is null)
  or (status='COMPLETED' and completed_at is not null and isfinite(completed_at)));
create index orl_requests_ot_hold_queue on public.orl_requests(ot_hold_at,id) where ot_hold;

create function public.orl_ic_ot_lifecycle(p_session_token uuid,p_request_id uuid,p_slot_id uuid,
 p_action text,p_reason text,p_generation uuid,p_expected_version timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype;r public.orl_requests%rowtype;sl public.orl_ot_slots%rowtype;
 ot_day date;revision timestamptz;clean_reason text;
begin
 u:=public.orl_require_session(p_session_token);
 if u.role not in('ADMIN','WEBMASTER') then raise exception 'Admin or Webmaster access required.' using errcode='42501'; end if;
 if p_action is null or p_action not in('HOLD','RELEASE_HOLD','COMPLETE') or p_request_id is null or p_slot_id is null
  or p_expected_version is null or not isfinite(p_expected_version) or p_reason is null or length(p_reason)>4096
  or (p_action='COMPLETE' and p_reason<>'')
  or (p_action<>'COMPLETE' and p_reason !~ '[^[:space:]]') then raise exception 'Invalid OT lifecycle action or reason.'; end if;
 perform orl_private.c1_check_generation(p_generation);
 -- Match Move/Cancel order: session slots, selected request, then proposal queue.
 perform 1 from public.orl_ot_slots where session_id=(select session_id from public.orl_ot_slots where id=p_slot_id) order by id for update;
 select * into sl from public.orl_ot_slots where id=p_slot_id;
 select * into r from public.orl_requests where id=p_request_id for update;
 if not found or r.updated_at is distinct from p_expected_version or r.assigned_slot_id is distinct from p_slot_id
  or sl.request_id is distinct from p_request_id or sl.status not in('RESERVED','CONFIRMED') then
  raise exception 'The selected OT patient changed. Reload the schedule and review again.';
 end if;
 if r.status not in('SCHEDULED','CONFIRMED') or r.deletion_status<>'' then
  raise exception 'Only an active booking without a pending cancellation can change OT status.';
 end if;
 select ot_date into ot_day from public.orl_ot_sessions where id=sl.session_id;
 if ot_day is null then raise exception 'OT date not found.'; end if;
 revision:=greatest(clock_timestamp(),r.updated_at+interval '1 microsecond');
 clean_reason:=orl_private.c1_redact_text(btrim(p_reason));
 if p_action='HOLD' then
  if r.ot_hold then raise exception 'This patient is already on OT Hold. Reload before continuing.'; end if;
  update public.orl_requests set ot_hold=true,ot_hold_reason=clean_reason,ot_hold_at=revision,ot_hold_by=u.id,updated_at=revision where id=r.id;
 elsif p_action='RELEASE_HOLD' then
  if not r.ot_hold then raise exception 'This patient is no longer on OT Hold. Reload before continuing.'; end if;
  update public.orl_requests set ot_hold=false,ot_hold_reason='',ot_hold_at=null,ot_hold_by=null,updated_at=revision where id=r.id;
 else
  if r.ot_hold then raise exception 'Remove OT Hold before marking the operation as done.'; end if;
  if r.status<>'SCHEDULED' or sl.status<>'CONFIRMED' then raise exception 'Approve the booking before marking the operation as done.'; end if;
  if ot_day>(clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date then raise exception 'A future OT booking cannot be marked as done.'; end if;
  update public.orl_requests set status='COMPLETED',completed_at=revision,completed_by=u.id,updated_at=revision where id=r.id;
 end if;
 -- Prior move proposals no longer describe the reviewed episode revision.
 update orl_private.booking_move_requests set status='INVALIDATED',updated_at=revision
  where request_id=r.id and generation=p_generation and status='PENDING';
 insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
 values(u.id,u.display_name,u.role,case p_action when 'HOLD' then 'OT_HOLD_PLACED' when 'RELEASE_HOLD' then 'OT_HOLD_REMOVED' else 'OT_MARKED_DONE' end,
  'REQUEST',r.id::text,jsonb_build_object('ot_date',ot_day,'slot_id',sl.id,'reason',clean_reason,
  'previous_hold',r.ot_hold,'previous_status',r.status)::text);
 return jsonb_build_object('request_id',r.id,'action',p_action,'status',case when p_action='COMPLETE' then 'COMPLETED' else r.status end,
  'ot_hold',p_action='HOLD');
end $$;
revoke all on function public.orl_ic_ot_lifecycle(uuid,uuid,uuid,text,text,uuid,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.orl_ic_ot_lifecycle(uuid,uuid,uuid,text,text,uuid,timestamptz) to service_role;

create function public.orl_get_ot_hold_requests(p_session_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype;g uuid;items jsonb;
begin
 u:=public.orl_require_session(p_session_token);
 if u.role not in('ADMIN','WEBMASTER') then raise exception 'Admin or Webmaster access required.' using errcode='42501'; end if;
 select generation into g from orl_private.c1_restore_generation where singleton;
 perform orl_private.c1_check_generation(g);
 select coalesce(jsonb_agg(orl_private.c1_mask_json(jsonb_build_object(
  'id',r.id,'request_id',r.id,'request_number',r.request_number,'patient_name',r.patient_name,'mrn',r.mrn,
  'patient_ic',r.patient_ic,'surgery',r.surgery,'ot_date',s.ot_date,'slot_id',sl.id,'slot_type',sl.slot_type,'slot_number',sl.slot_number,
  'status',r.status,'ot_hold',r.ot_hold,'ot_hold_reason',r.ot_hold_reason,'ot_hold_at',r.ot_hold_at,'ot_hold_by',r.ot_hold_by,
  'updated_at',r.updated_at,'_ic_edit_version',r.updated_at,'generation',g),s.ot_date) order by r.ot_hold_at,r.id),'[]'::jsonb) into items
 from public.orl_requests r join public.orl_ot_slots sl on sl.id=r.assigned_slot_id and sl.request_id=r.id
 join public.orl_ot_sessions s on s.id=sl.session_id where r.ot_hold;
 return jsonb_build_object('generation',g,'requests',items);
end $$;
revoke all on function public.orl_get_ot_hold_requests(uuid) from public,anon,authenticated,service_role;
grant execute on function public.orl_get_ot_hold_requests(uuid) to anon,authenticated;

-- Patch reviewed bodies in place to retain their exact signatures and ACLs.
-- Each fragment is required to occur once; any drift aborts the entire migration.
do $patches$
declare item record;fn regprocedure;source text;definition text;before_acl aclitem[];before_security boolean;
begin
 for item in select * from (values
  ('orl_private.c1_mask_json(jsonb,date)',
   $old$'review_note','deletion_reason','note','description'$old$,
   $new$'review_note','deletion_reason','note','description','ot_hold_reason'$new$),
  ('orl_private.c1_mask_json(jsonb,date)',
   $old$jsonb_build_object('_ic_edit_version',r.updated_at)$old$,
   $new$jsonb_build_object('_ic_edit_version',r.updated_at,'ot_hold',r.ot_hold,
       'ot_hold_reason',orl_private.c1_redact_text(r.ot_hold_reason),'ot_hold_at',r.ot_hold_at,'ot_hold_by',r.ot_hold_by,
       'completed_at',r.completed_at,'completed_by',r.completed_by)$new$),
  ('orl_private.c1_mask_json(jsonb,date)',
   $old$   return result;
 end if;
 return p_value;$old$,
   $new$   if p_value ? 'patient_ic' and p_value ? 'id' and not (p_value ? 'request_id')
      and (p_value->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
     result:=result||coalesce((select jsonb_build_object('_ic_edit_version',r.updated_at,'ot_hold',r.ot_hold,
       'ot_hold_reason',orl_private.c1_redact_text(r.ot_hold_reason),'ot_hold_at',r.ot_hold_at,'ot_hold_by',r.ot_hold_by,
       'completed_at',r.completed_at,'completed_by',r.completed_by)
       from public.orl_requests r where r.id=(p_value->>'id')::uuid),'{}'::jsonb);
   end if;
   return result;
 end if;
 return p_value;$new$),
  ('orl_private.ot_export_snapshot(uuid)',
   $old$and r.status<>'CANCELLED' and coalesce(r.patient_name,'')<>''$old$,
   $new$and r.status<>'CANCELLED' and not r.ot_hold and coalesce(r.patient_name,'')<>''$new$),
  ('public.orl_compact_main(uuid,uuid)',
   $old$  select coalesce(
    jsonb_agg(jsonb_build_object('request_id',request_id,'status',status) order by slot_number),$old$,
   $new$  -- Keep held and completed patients in their existing slots during other patients' compaction.
  select coalesce(array_agg(sl.id),'{}'::uuid[]) into locked_ids
  from public.orl_ot_slots sl left join public.orl_requests r on r.id=sl.request_id
  where sl.id=any(locked_ids) and not coalesce(r.ot_hold,false) and coalesce(r.status,'')<>'COMPLETED';
  select coalesce(
    jsonb_agg(jsonb_build_object('request_id',request_id,'status',status) order by slot_number),$new$),
  ('public.orl_edit_scheduled_request_checked(uuid,uuid,jsonb,text,uuid)',
   $old$  if v_req.assigned_slot_id is distinct from v_slot.id or v_req.status='CANCELLED' then$old$,
   $new$  if v_req.status='COMPLETED' then raise exception 'Completed operations are read-only.'; end if;
  if v_req.ot_hold and act='CANCEL' then raise exception 'Remove OT Hold before cancelling this booking.'; end if;
  if v_req.assigned_slot_id is distinct from v_slot.id or v_req.status='CANCELLED' then$new$),
  ('public.orl_move_postponed_checked(uuid,uuid,uuid,jsonb,text,uuid)',
   $old$  if r.assigned_slot_id is distinct from a.id or r.status='CANCELLED' then$old$,
   $new$  if r.status='COMPLETED' then raise exception 'Completed operations are read-only.'; end if;
  if r.ot_hold and r.postpone_count>=999 then raise exception 'Postpone count has reached its maximum. No move was applied.'; end if;
  if r.assigned_slot_id is distinct from a.id or r.status='CANCELLED' then$new$),
  ('public.orl_move_postponed_checked(uuid,uuid,uuid,jsonb,text,uuid)',
   $old$    postpone_count=postpone_count+1,$old$,
   $new$    ot_hold=false,ot_hold_reason='',ot_hold_at=null,ot_hold_by=null,
    postpone_count=postpone_count+1,$new$),
  ('public.orl_move_postponed_checked(uuid,uuid,uuid,jsonb,text,uuid)',
   $old$  return new_status;$old$,
   $new$  if r.ot_hold then
    insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
    values(u.id,u.display_name,u.role,'OT_HOLD_MOVED','REQUEST',r.id::text,
      jsonb_build_object('from_slot',a.id,'to_slot',b.id,'reason',p_reason,'hold_reason',r.ot_hold_reason,'postpone_increment',1)::text);
  end if;
  return new_status;$new$),
  ('public.orl_clear_slot_checked(uuid,uuid,uuid)',
   $old$  if not exists(select 1 from public.orl_requests where id=v_slot.request_id and assigned_slot_id=v_slot.id and status<>'CANCELLED') then$old$,
   $new$  if exists(select 1 from public.orl_requests where id=v_slot.request_id and (status='COMPLETED' or ot_hold)) then
    raise exception 'Completed operations cannot be cleared. Remove OT Hold before clearing a held booking.';
  end if;
  if not exists(select 1 from public.orl_requests where id=v_slot.request_id and assigned_slot_id=v_slot.id and status<>'CANCELLED') then$new$),
  ('public.orl_swap_slots_checked(uuid,uuid,uuid,uuid,uuid)',
   $old$  update public.orl_requests
  set assigned_slot_id = null,$old$,
   $new$  if exists(select 1 from public.orl_requests where id in(a.request_id,b.request_id) and status='COMPLETED') then
    raise exception 'Completed operations cannot be reassigned.';
  end if;

  update public.orl_requests
  set assigned_slot_id = null,$new$),
  ('public.orl_review_request(uuid,uuid,text,text)',
   $old$  if v_request.status is distinct from 'CONFIRMED' then$old$,
   $new$  if v_request.ot_hold and p_action='REJECT' then raise exception 'Remove OT Hold before rejecting this booking.'; end if;
  if v_request.status is distinct from 'CONFIRMED' then$new$),
  ('public.orl_ic_c1_deletion(uuid,text,uuid,uuid,timestamptz,uuid,text)',
   $old$  if p_operation='REQUEST' then
    -- 008 used <>; explicitly deny a Staff request with a missing/null owner.$old$,
   $new$  if r.status='COMPLETED' then raise exception 'Completed operations are read-only.'; end if;
  if r.ot_hold then raise exception 'Remove OT Hold before cancelling this booking.'; end if;
  if p_operation='REQUEST' then
    -- 008 used <>; explicitly deny a Staff request with a missing/null owner.$new$),
  ('public.orl_booking_move_view(uuid,uuid)',
   $old$or r.status not in('SCHEDULED','CONFIRMED')$old$,
   $new$or r.ot_hold or r.status not in('SCHEDULED','CONFIRMED')$new$),
  ('public.orl_booking_move_request(uuid,uuid,date,text,uuid,timestamptz,uuid)',
   $old$or r.status not in('SCHEDULED','CONFIRMED')$old$,
   $new$or r.ot_hold or r.status not in('SCHEDULED','CONFIRMED')$new$),
  ('public.orl_booking_move_review(uuid,uuid,text,uuid,timestamptz,timestamptz,uuid)',
   $old$or r.status not in('SCHEDULED','CONFIRMED')$old$,
   $new$or r.ot_hold or r.status not in('SCHEDULED','CONFIRMED')$new$),
  ('public.orl_db_import_locked(uuid,text,jsonb)',
   $old$mapped_deleter uuid; booking_name text;$old$,
   $new$mapped_deleter uuid; mapped_holder uuid; mapped_completer uuid; booking_name text;$new$),
  ('public.orl_db_import_locked(uuid,text,jsonb)',
   $old$  delete from public.orl_ot_slots where true;$old$,
   $new$  -- Older v3 backups omit lifecycle fields. New metadata must describe a valid linked episode.
  if exists(select 1 from jsonb_array_elements(p_backup->'requests') br where
    (br ? 'ot_hold' and jsonb_typeof(br->'ot_hold') is distinct from 'boolean')
    or (coalesce((br->>'ot_hold')::boolean,false) and (
      br->>'status' not in('SCHEDULED','CONFIRMED') or coalesce(br->>'deletion_status','')<>''
      or nullif(br->>'ot_hold_at','') is null or coalesce(br->>'ot_hold_reason','') !~ '[^[:space:]]'
      or not exists(select 1 from jsonb_array_elements(p_backup->'ot_slots') bs
        where bs->>'id'=br->>'assigned_slot_id' and bs->>'request_id'=br->>'id' and bs->>'status' in('RESERVED','CONFIRMED'))))
    or (nullif(br->>'completed_at','') is not null and (br->>'status' is distinct from 'COMPLETED'
      or not exists(select 1 from jsonb_array_elements(p_backup->'ot_slots') bs
        where bs->>'id'=br->>'assigned_slot_id' and bs->>'request_id'=br->>'id' and bs->>'status' in('RESERVED','CONFIRMED'))))) then
    raise exception 'Backup lifecycle metadata or slot links are inconsistent. No data changed.';
  end if;

  delete from public.orl_ot_slots where true;$new$),
  ('public.orl_db_import_locked(uuid,text,jsonb)',
   $old$    -- Never substitute the editable Doctor field for the original submitter.$old$,
   $new$    select cu.id into mapped_holder from public.orl_users cu
      join jsonb_array_elements(p_backup->'users') bu on lower(bu->>'username')=lower(cu.username)
      where (bu->>'id')::uuid=r.ot_hold_by limit 1;
    select cu.id into mapped_completer from public.orl_users cu
      join jsonb_array_elements(p_backup->'users') bu on lower(bu->>'username')=lower(cu.username)
      where (bu->>'id')::uuid=r.completed_by limit 1;
    -- Never substitute the editable Doctor field for the original submitter.$new$),
  ('public.orl_db_import_locked(uuid,text,jsonb)',
   $old$    insert into public.orl_requests(booked_by_name,id,request_number,$old$,
   $new$    insert into public.orl_requests(ot_hold,ot_hold_reason,ot_hold_at,ot_hold_by,completed_at,completed_by,booked_by_name,id,request_number,$new$),
  ('public.orl_db_import_locked(uuid,text,jsonb)',
   $old$    values(booking_name,r.id,r.request_number,$old$,
   $new$    values(coalesce(r.ot_hold,false),orl_private.c1_redact_text(coalesce(r.ot_hold_reason,'')),r.ot_hold_at,mapped_holder,
      r.completed_at,mapped_completer,booking_name,r.id,r.request_number,$new$)
 ) v(signature,old_part,new_part) loop
  fn:=to_regprocedure(item.signature);
  select replace(prosrc,chr(13),''),proacl,prosecdef into source,before_acl,before_security from pg_proc where oid=fn;
  if source is null or (length(source)-length(replace(source,item.old_part,'')))/length(item.old_part)<>1 then
   raise exception '064: reviewed patch target missing or duplicated: %',item.signature;
  end if;
  definition:=replace(replace(pg_get_functiondef(fn),chr(13),''),source,replace(source,item.old_part,item.new_part));
  execute definition;
  if not exists(select 1 from pg_proc where oid=fn and proacl is not distinct from before_acl and prosecdef=before_security) then
   raise exception '064: function permissions changed: %',item.signature;
  end if;
 end loop;
end $patches$;

-- Verify the service boundary and direct-read surface after every definition patch.
do $verify$
begin
 if has_function_privilege('anon','public.orl_ic_ot_lifecycle(uuid,uuid,uuid,text,text,uuid,timestamptz)','EXECUTE')
  or has_function_privilege('authenticated','public.orl_ic_ot_lifecycle(uuid,uuid,uuid,text,text,uuid,timestamptz)','EXECUTE')
  or not has_function_privilege('service_role','public.orl_ic_ot_lifecycle(uuid,uuid,uuid,text,text,uuid,timestamptz)','EXECUTE')
  or not has_function_privilege('anon','public.orl_get_ot_hold_requests(uuid)','EXECUTE') then
  raise exception '064: lifecycle endpoint permissions verification failed.';
 end if;
end $verify$;
notify pgrst,'reload schema';
commit;
