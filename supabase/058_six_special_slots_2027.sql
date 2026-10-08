-- Six Special slots (S1-S6) from 2027 onward. Run after 056.
-- SPECIAL_SLOTS keeps its existing meaning for 2026; Main capacity is unchanged.
-- Only missing slot rows are inserted. Existing rows and patient links are never updated.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $preflight$
declare excess bigint;
begin
  if to_regclass('orl_private.site_maintenance') is null
     or not orl_private.c1_recovery_ready()
     or (orl_private.c6_stats()->>'cutover_complete')::boolean is distinct from true
     or (orl_private.c6_stats()->>'plaintext_rows')::integer is distinct from 0
     or (orl_private.c6_stats()->>'identity_mismatch')::integer is distinct from 0 then
    raise exception 'STOP: protected baseline through 056 is required.';
  end if;
  if (select md5(replace(prosrc,chr(13),'')) from pg_proc
      where oid='public.orl_prepare_schedule(uuid,integer,integer)'::regprocedure)
       is distinct from 'e14b625980cc7dd451567fd4e5be733b'
     or (select md5(replace(prosrc,chr(13),'')) from pg_proc
      where oid='orl_private.c1_prepare_schedule(uuid,integer,integer)'::regprocedure)
       is null
     or (select md5(replace(prosrc,chr(13),'')) from pg_proc
      where oid='orl_private.c1_prepare_schedule(uuid,integer,integer)'::regprocedure)
       not in ('a3466ebff4648c78b6f1582beffb7d3c','544c5dfd927bef55e7b53eb56b84c598') then
    -- Second exact hash is the deployed 020 body with reviewed indentation only.
    -- Unknown bodies still stop; never accept arbitrary whitespace/logic changes.
    raise exception 'STOP: reviewed schedule baseline differs or 058 is already installed.';
  end if;
  if exists(select 1 from unnest(array['anon','authenticated','service_role']) r
    where has_function_privilege(r,'orl_private.c1_prepare_schedule(uuid,integer,integer)','EXECUTE')
       or has_function_privilege(r,'public.orl_require_session(uuid)','EXECUTE')) then
    raise exception 'STOP: private schedule/session helper access must remain closed.';
  end if;
  perform orl_private.c1_check_generation((select generation from orl_private.c1_restore_generation where singleton));
  -- Serialize the preflight and insertion against settings, calendar and booking writers.
  lock table public.orl_settings,public.orl_holidays,public.orl_ot_sessions,public.orl_ot_slots
    in share row exclusive mode nowait;
  select count(*) into excess from public.orl_ot_slots sl
    join public.orl_ot_sessions s on s.id=sl.session_id
    where s.ot_date>=date '2027-01-01' and sl.slot_type='SPECIAL' and sl.slot_number>6;
  if excess>0 then
    raise exception 'STOP: % Special slot(s) above S6 exist from 2027 onward. Review them before applying 058; no slots or bookings were changed.',excess;
  end if;
end $preflight$;

-- Keep the public 046 wrapper byte-for-byte: it enforces the Restore fence and
-- current 056 maintenance/session guard. This helper remains inaccessible to clients.
create or replace function orl_private.c1_prepare_schedule(p_session_token uuid,p_year integer,p_month integer)
returns void language plpgsql security definer set search_path='' as $$
declare v_user public.orl_users%rowtype; v_main integer; v_special integer;
  period_start date; period_end date;
begin
  v_user:=public.orl_require_session(p_session_token);
  if p_year is null or p_year not between 2026 and 2100
     or p_month is null or p_month not between 1 and 12 then
    raise exception 'Invalid schedule period.';
  end if;
  period_start:=make_date(p_year,p_month,1);
  period_end:=(period_start+interval '1 month')::date;
  v_main:=case when p_year=2026 then 10 else 5 end;
  if p_year>=2027 then
    v_special:=6;
    -- A restored/imported excess row must be reviewed, never silently removed.
    if exists(select 1 from public.orl_ot_slots sl join public.orl_ot_sessions s on s.id=sl.session_id
      where s.ot_date>=period_start and s.ot_date<period_end
        and sl.slot_type='SPECIAL' and sl.slot_number>6) then
      raise exception 'STOP: Special slots above S6 exist in this month. Review them before generating the schedule.';
    end if;
    -- Match booking writers' UUID lock order across Main and Special rows;
    -- read a stable set of manually closed Special slots when filling gaps.
    perform 1 from public.orl_ot_slots sl join public.orl_ot_sessions s on s.id=sl.session_id
      where s.ot_date>=period_start and s.ot_date<period_end
      order by sl.id for update of sl;
  else
    select setting_value::integer into v_special
      from public.orl_settings where setting_key='SPECIAL_SLOTS';
  end if;

  insert into public.orl_ot_sessions(ot_date,day_name)
  select d::date,trim(to_char(d,'Day'))
  from generate_series(period_start,(period_end-1)::date,interval '1 day') d
  where extract(dow from d) in (0,3)
  on conflict(ot_date) do nothing;

  insert into public.orl_ot_slots(session_id,slot_type,slot_number,status)
  select s.id,x.slot_type,n,
    case when p_year>=2027 and x.slot_type='SPECIAL'
      and exists(select 1 from public.orl_ot_slots old where old.session_id=s.id and old.slot_type='SPECIAL')
      and not exists(select 1 from public.orl_ot_slots old where old.session_id=s.id and old.slot_type='SPECIAL' and old.status<>'CLOSED')
      then 'CLOSED' else 'AVAILABLE' end
  from public.orl_ot_sessions s
  cross join (values('MAIN'::text,v_main),('SPECIAL'::text,v_special)) x(slot_type,maximum)
  cross join lateral generate_series(1,x.maximum) n
  where s.ot_date>=period_start and s.ot_date<period_end
  on conflict(session_id,slot_type,slot_number) do nothing;
end $$;
revoke all on function orl_private.c1_prepare_schedule(uuid,integer,integer) from public,anon,authenticated,service_role;

-- Backfill every existing 2027+ date, including custom sessions. A date whose
-- existing Special slots are all manually CLOSED receives CLOSED additions.
-- Cancelled sessions and holidays retain their existing session-level blocking;
-- AVAILABLE rows there do not become bookable without the existing override rules.
insert into public.orl_ot_slots(session_id,slot_type,slot_number,status)
select s.id,'SPECIAL',n,
  case when exists(select 1 from public.orl_ot_slots old where old.session_id=s.id and old.slot_type='SPECIAL')
    and not exists(select 1 from public.orl_ot_slots old where old.session_id=s.id and old.slot_type='SPECIAL' and old.status<>'CLOSED')
    then 'CLOSED' else 'AVAILABLE' end
from public.orl_ot_sessions s cross join generate_series(1,6) n
where s.ot_date>=date '2027-01-01'
on conflict(session_id,slot_type,slot_number) do nothing;

comment on function orl_private.c1_prepare_schedule(uuid,integer,integer) is
  'Private schedule generator: Main=10 in 2026, 5 thereafter; Special uses legacy SPECIAL_SLOTS in 2026 and fixed S1-S6 from 2027. Existing slots and bookings are retained.';
notify pgrst,'reload schema';
commit;
