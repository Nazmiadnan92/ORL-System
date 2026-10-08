-- Read-only readiness check after 057 + 058. Maintenance may intentionally be ON.
-- Full dumps can retain pre-existing same-date duplicates because pg_dump restores
-- data before triggers. Application backup import fires the assignment trigger:
-- importing such duplicates fails atomically and leaves the current DB unchanged.
-- A false duplicate result requires review, never automatic deletion/merging.
begin read only;
with booking_functions(signature,expected_hash) as(values
 ('public.orl_booking_assign_view(uuid,uuid)','060a6404455ba9f9ddbc78a2a19bfac4'),
 ('public.orl_booking_assign_existing(uuid,uuid,uuid,timestamptz,uuid)','e54fa0d43ffd4b4e4d4178b2a814609a'),
 ('public.orl_booking_move_view(uuid,uuid)','054330db487f9f3d05e2c2fa9ce59817'),
 ('public.orl_booking_move_dates(uuid,integer,integer)','c71ea25da94cab202d3915fd21c2ac07'),
 ('public.orl_booking_move_request(uuid,uuid,date,text,uuid,timestamptz,uuid)','1769924c9e73acc96660bb3338593847'),
 ('public.orl_booking_move_list(uuid)','2ea0d80f729e17909f440bcbbf53cff1'),
 ('public.orl_booking_move_review(uuid,uuid,text,uuid,timestamptz,timestamptz,uuid)','488b5a16ad3fe7be54f34d59f3006766'),
 ('orl_private.booking_move_summary(uuid)','f5b3a0c88f1980c47b7d18879370f685'),
 ('orl_private.booking_same_date_guard()','30be1c5fe983f12238591fd2f3661b44')
), public_booking_functions as(select signature from booking_functions where signature like 'public.%')
select jsonb_build_object(
 'reviewed_booking_definitions',not exists(select 1 from booking_functions f left join pg_proc p on p.oid=to_regprocedure(f.signature)
  where p.oid is null or md5(replace(p.prosrc,chr(13),'')) is distinct from f.expected_hash
   or not p.prosecdef or not coalesce(p.proconfig @> array['search_path=""'],false)),
 'reviewed_session_gate',coalesce((select md5(replace(prosrc,chr(13),''))='ba9d29923e7269729c8025bf1e266208'
  from pg_proc where oid=to_regprocedure('public.orl_require_session(uuid)')),false),
 'public_booking_grants',not exists(select 1 from public_booking_functions f cross join unnest(array['anon','authenticated']) r
  where not coalesce(has_function_privilege(r,to_regprocedure(f.signature),'EXECUTE'),false))
  and not exists(select 1 from public_booking_functions f where coalesce(has_function_privilege('service_role',to_regprocedure(f.signature),'EXECUTE'),false)),
 'private_access_closed',not exists(select 1 from unnest(array['anon','authenticated','service_role']) r
  where has_table_privilege(r,'orl_private.booking_move_requests','SELECT,INSERT,UPDATE,DELETE')
   or has_function_privilege(r,'orl_private.booking_move_summary(uuid)','EXECUTE')
   or has_function_privilege(r,'orl_private.booking_same_date_guard()','EXECUTE')
   or has_function_privilege(r,'public.orl_require_session(uuid)','EXECUTE')
   or has_function_privilege(r,'orl_private.c1_require_session_core(uuid)','EXECUTE')
   or has_function_privilege(r,'orl_private.c1_prepare_schedule(uuid,integer,integer)','EXECUTE')
   or has_function_privilege(r,'public.orl_prepare_schedule(uuid,integer,integer)','EXECUTE')),
 'queue_rls_enabled_and_forced',coalesce((select relrowsecurity and relforcerowsecurity from pg_class
  where oid=to_regclass('orl_private.booking_move_requests')),false),
 'one_pending_proposal_per_case_generation',exists(select 1 from pg_index i
  where i.indexrelid=to_regclass('orl_private.booking_move_one_pending') and i.indisunique and i.indisvalid
   and pg_get_expr(i.indpred,i.indrelid)='(status = ''PENDING''::text)'),
 'same_date_assignment_guard_enabled',exists(select 1 from pg_trigger where tgrelid='public.orl_ot_slots'::regclass
  and tgname='orl_booking_same_date_guard' and not tgisinternal and tgenabled in('O','A') and tgtype=23
  and tgfoid=to_regprocedure('orl_private.booking_same_date_guard()')),
 'existing_same_date_duplicates_absent',not exists(select 1 from public.orl_ot_slots sl
  join public.orl_ot_sessions s on s.id=sl.session_id join public.orl_requests r on r.id=sl.request_id
  where sl.status in('RESERVED','CONFIRMED') and r.status not in('CANCELLED','COMPLETED','REJECTED')
   and btrim(r.mrn)<>'' and btrim(r.surgery)<>''
  group by s.ot_date,lower(btrim(r.mrn)),lower(regexp_replace(btrim(r.surgery),'\s+',' ','g')) having count(*)>1),
 'reviewed_capacity_generator',coalesce((select md5(replace(prosrc,chr(13),''))='6dc1567ad399f5ad9b709b6cd1cb3412'
  from pg_proc where oid=to_regprocedure('orl_private.c1_prepare_schedule(uuid,integer,integer)')),false),
 'schedule_wrapper_preserved',coalesce((select md5(replace(prosrc,chr(13),''))='e14b625980cc7dd451567fd4e5be733b'
  from pg_proc where oid=to_regprocedure('public.orl_prepare_schedule(uuid,integer,integer)')),false),
 'six_special_slots_from_2027',not exists(select 1 from public.orl_ot_sessions s left join public.orl_ot_slots sl
  on sl.session_id=s.id and sl.slot_type='SPECIAL' where s.ot_date>=date '2027-01-01' group by s.id
  having coalesce(array_agg(sl.slot_number order by sl.slot_number) filter(where sl.id is not null),array[]::integer[])<>array[1,2,3,4,5,6]),
 'recovery_ready',orl_private.c1_recovery_ready(),
 'identity_storage_preserved',coalesce((orl_private.c6_stats()->>'cutover_complete')::boolean
  and (orl_private.c6_stats()->>'plaintext_rows')::integer=0 and (orl_private.c6_stats()->>'identity_mismatch')::integer=0,false)
);
rollback;
