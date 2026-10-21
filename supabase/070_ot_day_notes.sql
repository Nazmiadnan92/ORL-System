-- Advisory OT-date notes, separate from cancellation reasons and clinical data.
-- Installation changes no existing patient, slot, setting, or audit record.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $baseline$
declare item record;
begin
 if exists(select 1 from pg_attribute where attrelid='public.orl_ot_sessions'::regclass
  and attname in('day_note','day_note_revision') and not attisdropped)
  or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname in('orl_get_ot_day_notes','orl_set_ot_day_note')) then
  raise exception '070: Day Note already exists or installation is partial. Inspect before retrying.';
 end if;
 if orl_private.c1_recovery_ready() is distinct from true
  or (orl_private.c6_stats()->>'cutover_complete')::boolean is distinct from true then
  raise exception '070: completed protected recovery/cutover baseline required.';
 end if;
 for item in select * from (values
  ('public.orl_require_session(uuid)','ba9d29923e7269729c8025bf1e266208'),
  ('orl_private.c1_check_generation(uuid)','5c654a99ad55c29ba66b9b74371c8239'),
  ('orl_private.c1_redact_text(text)','aea30f10772d86163fb1aa4e2362fac3'),
  ('public.orl_db_export(uuid,text)','685f55c7c5c33548eb79933d3beeb16d'),
  ('public.orl_db_import_locked(uuid,text,jsonb)','097da3e68879e5e783e7cd2d6fbc2e8c')
 ) v(signature,expected_md5) loop
  if not coalesce((select prosecdef and md5(replace(prosrc,chr(13),''))=item.expected_md5
   and (proconfig @> array['search_path=""'] or proconfig @> array['search_path=public, extensions'])
   from pg_proc where oid=to_regprocedure(item.signature)),false) then
   raise exception '070: reviewed protected baseline differs: %',item.signature;
  end if;
 end loop;
 if exists(select 1 from unnest(array['anon','authenticated','service_role']) client
  cross join unnest(array['public.orl_require_session(uuid)','orl_private.c1_check_generation(uuid)',
   'orl_private.c1_redact_text(text)','public.orl_db_export(uuid,text)','public.orl_db_import_locked(uuid,text,jsonb)']) signature
  where has_function_privilege(client,signature,'EXECUTE'))
  or exists(select 1 from unnest(array['anon','authenticated']) client
   where has_table_privilege(client,'public.orl_ot_sessions','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
  or not coalesce((select relrowsecurity from pg_class where oid='public.orl_ot_sessions'::regclass),false) then
  raise exception '070: protected permissions differ.';
 end if;
end $baseline$;

alter table public.orl_ot_sessions
 add column day_note text not null default '',
 add column day_note_revision bigint not null default 0,
 add constraint orl_ot_sessions_day_note_length check(length(day_note)<=500),
 add constraint orl_ot_sessions_day_note_revision check(day_note_revision between 0 and 9007199254740991);

create function public.orl_get_ot_day_notes(p_session_token uuid,p_year integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype;g uuid;rows jsonb;
begin
 u:=public.orl_require_session(p_session_token);
 if p_year is null or p_year not between 2026 and 2100 then raise exception 'Invalid year.'; end if;
 select generation into g from orl_private.c1_restore_generation where singleton;
 perform orl_private.c1_check_generation(g);
 -- No schedule generation, patient lookup or side effect. Blank days carry a
 -- revision too, so an editor cannot overwrite a note added since it opened.
 select coalesce(jsonb_agg(jsonb_build_object('session_id',s.id,'ot_date',s.ot_date,
  'day_note',orl_private.c1_redact_text(s.day_note),'revision',s.day_note_revision) order by s.ot_date),'[]'::jsonb)
 into rows from public.orl_ot_sessions s where extract(year from s.ot_date)=p_year;
 return jsonb_build_object('generation',g,'notes',rows);
end $$;
revoke all on function public.orl_get_ot_day_notes(uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.orl_get_ot_day_notes(uuid,integer) to anon,authenticated;

create function public.orl_set_ot_day_note(p_session_token uuid,p_session_id uuid,p_note text,
 p_expected_revision bigint,p_generation uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.orl_users%rowtype;s public.orl_ot_sessions%rowtype;clean_note text;changed boolean;
begin
 u:=public.orl_require_session(p_session_token);
 if u.role not in('ADMIN','WEBMASTER') then
  raise exception 'Admin or Webmaster access required.' using errcode='42501';
 end if;
 if p_session_id is null or p_note is null or length(p_note)>500
  or p_expected_revision is null or p_expected_revision not between 0 and 9007199254740991
  or p_note ~ E'[\\x01-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]' then
  raise exception 'A current OT date and Day Note of up to 500 characters are required.';
 end if;
 perform orl_private.c1_check_generation(p_generation);
 clean_note:=orl_private.c1_redact_text(btrim(replace(replace(p_note,chr(13)||chr(10),chr(10)),chr(13),chr(10)),
  ' '||chr(9)||chr(10)));
 if length(clean_note)>500 then raise exception 'Day Note must be no more than 500 characters.'; end if;
 select * into s from public.orl_ot_sessions where id=p_session_id for update nowait;
 if not found or s.day_note_revision is distinct from p_expected_revision then
  raise exception 'This Day Note changed. Reload the schedule and review again.';
 end if;
 changed:=s.day_note is distinct from clean_note;
 if changed then
  if s.day_note_revision>=9007199254740991 then raise exception 'Day Note revision limit reached. Contact Webmaster.'; end if;
  -- Notes are advisory. Do not change cancellation notes, day status, slots,
  -- patients, booking permissions, or the existing control snapshot fields.
  update public.orl_ot_sessions set day_note=clean_note,day_note_revision=day_note_revision+1 where id=s.id;
  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
  values(u.id,u.display_name,u.role,
   case when clean_note='' then 'OT_DAY_NOTE_REMOVED' when s.day_note='' then 'OT_DAY_NOTE_ADDED' else 'OT_DAY_NOTE_UPDATED' end,
   'OT_SESSION',s.id::text,jsonb_build_object('ot_date',s.ot_date,
    'previous_note',orl_private.c1_redact_text(s.day_note),'note',clean_note,
    'previous_revision',s.day_note_revision,'revision',s.day_note_revision+1,'advisory_only',true)::text);
 end if;
 return jsonb_build_object('session_id',s.id,'ot_date',s.ot_date,'day_note',clean_note,
  'revision',s.day_note_revision+case when changed then 1 else 0 end,'generation',p_generation,'changed',changed);
end $$;
revoke all on function public.orl_set_ot_day_note(uuid,uuid,text,bigint,uuid) from public,anon,authenticated,service_role;
grant execute on function public.orl_set_ot_day_note(uuid,uuid,text,bigint,uuid) to anon,authenticated;

-- Existing exports include every session column via to_jsonb. Restore uses an
-- explicit insert list: preserve these fields there without widening its ACLs.
-- Legacy backups omit both fields and restore as a blank note/revision zero.
do $restore$
declare fn regprocedure;source text;definition text;before_acl aclitem[];item record;
begin
 fn:='public.orl_db_import_locked(uuid,text,jsonb)'::regprocedure;
 select replace(prosrc,chr(13),''),proacl into source,before_acl from pg_proc where oid=fn;
 for item in select * from (values
  ($old$  delete from public.orl_ot_slots where true;$old$,
   $new$  -- Reject malformed new note metadata before replacing any stored record.
  if exists(select 1 from jsonb_array_elements(p_backup->'ot_sessions') bs where
    (bs ? 'day_note' and (jsonb_typeof(bs->'day_note') is distinct from 'string'
      or length(bs->>'day_note')>500 or (bs->>'day_note') ~ E'[\\x01-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]'))
    or (bs ? 'day_note_revision' and (jsonb_typeof(bs->'day_note_revision') is distinct from 'number'
      or (bs->>'day_note_revision') !~ '^[0-9]+$'
      or length(bs->>'day_note_revision')>16
      or (bs->>'day_note_revision')::numeric>9007199254740991))) then
    raise exception 'Backup Day Note metadata is invalid. No data changed.';
  end if;

  delete from public.orl_ot_slots where true;$new$),
  ($old$insert into public.orl_ot_sessions(id,ot_date,day_name,status,note,special_title,holiday_override,updated_by,created_at,updated_at)$old$,
   $new$insert into public.orl_ot_sessions(day_note,day_note_revision,id,ot_date,day_name,status,note,special_title,holiday_override,updated_by,created_at,updated_at)$new$),
  ($old$values(s.id,s.ot_date,s.day_name,s.status,s.note,s.special_title,coalesce(s.holiday_override,false),mapped_user,s.created_at,s.updated_at);$old$,
   $new$values(orl_private.c1_redact_text(coalesce(s.day_note,'')),coalesce(s.day_note_revision,0),s.id,s.ot_date,s.day_name,s.status,s.note,s.special_title,coalesce(s.holiday_override,false),mapped_user,s.created_at,s.updated_at);$new$)
 ) v(old_part,new_part) loop
  if (length(source)-length(replace(source,item.old_part,'')))/length(item.old_part)<>1 then
   raise exception '070: reviewed Restore patch target missing or duplicated.';
  end if;
  source:=replace(source,item.old_part,item.new_part);
 end loop;
 select replace(replace(pg_get_functiondef(fn),chr(13),''),replace(prosrc,chr(13),''),source)
 into definition from pg_proc where oid=fn;
 execute definition;
 if not exists(select 1 from pg_proc where oid=fn and proacl is not distinct from before_acl
  and prosecdef and proconfig @> array['search_path=public, extensions']) then
  raise exception '070: Restore permissions changed. Rolled back.';
 end if;
end $restore$;

notify pgrst,'reload schema';
commit;
