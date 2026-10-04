-- LOCAL SYNTHETIC C1 EXPERIMENT ONLY. Not a deployment migration.
-- Apply after compatible service wrappers and masked reads, never by itself.
begin;
do $guard$
begin
  if session_user <> 'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet
     or to_regclass('orl_private.c1_restore_generation') is null
     or to_regprocedure('public.orl_ic_c1_import(uuid,text,jsonb)') is null then
    raise exception 'LOCAL complete C1 test fixture required. Not a production migration.';
  end if;
end $guard$;

-- Owners retain execution for SECURITY DEFINER service wrappers. Neither a
-- browser session nor a direct service-role call may bypass the new boundary.
revoke all on function
  public.orl_create_request(uuid,jsonb),
  public.orl_edit_scheduled_request(uuid,uuid,jsonb,text),
  public.orl_edit_scheduled_request_checked(uuid,uuid,jsonb,text,uuid),
  public.orl_move_postponed(uuid,uuid,uuid,jsonb,text),
  public.orl_move_postponed_checked(uuid,uuid,uuid,jsonb,text,uuid),
  public.orl_db_remove_patient(uuid,text,text,text),
  public.orl_delete_request(uuid,uuid),
  public.orl_db_export(uuid,text),
  public.orl_db_import(uuid,text,jsonb),
  public.orl_db_import_locked(uuid,text,jsonb),
  public.orl_set_postpone_count(uuid,uuid,integer),
  public.orl_swap_slots(uuid,uuid,uuid),
  public.orl_swap_slots_checked(uuid,uuid,uuid,uuid,uuid),
  public.orl_confirm_request(uuid,uuid),
  public.orl_assign_slot(uuid,uuid,uuid),
  public.orl_review_request(uuid,uuid,text,text),
  public.orl_clear_slot(uuid,uuid),
  public.orl_clear_slot_checked(uuid,uuid,uuid),
  public.orl_request_deletion(uuid,uuid,text),
  public.orl_resolve_deletion(uuid,uuid,text),
  public.orl_set_session(uuid,uuid,text,text),
  public.orl_set_slot_closed(uuid,uuid,boolean),
  public.orl_save_holiday(uuid,uuid,date,text,text),
  public.orl_delete_holiday(uuid,uuid),
  public.orl_generate_public_holidays(uuid,integer),
  public.orl_clear_all_holidays(uuid,text),
  public.orl_save_settings(uuid,jsonb),
  public.orl_prepare_schedule(uuid,integer,integer)
  ,public.orl_db_repair(uuid,text)
  ,public.orl_postpone_slot(uuid,uuid,text)
  ,public.orl_update_slot_request(uuid,uuid,jsonb)
from public,anon,authenticated,service_role;

-- Fail closed if another overload or inherited privilege was missed. This is
-- deliberately scoped: unrelated operational RPCs are NOT declared protected.
do $verify$
declare fn regprocedure; client text;
begin
  for fn in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=any(array[
      'orl_create_request','orl_edit_scheduled_request','orl_edit_scheduled_request_checked',
      'orl_move_postponed','orl_move_postponed_checked','orl_db_remove_patient',
      'orl_delete_request','orl_db_export','orl_db_import','orl_db_import_locked','orl_set_postpone_count',
      'orl_swap_slots','orl_swap_slots_checked','orl_confirm_request','orl_assign_slot','orl_review_request',
      'orl_clear_slot','orl_clear_slot_checked','orl_request_deletion','orl_resolve_deletion',
      'orl_set_session','orl_set_slot_closed','orl_save_holiday','orl_delete_holiday',
      'orl_generate_public_holidays','orl_clear_all_holidays','orl_save_settings','orl_prepare_schedule','orl_db_repair',
      'orl_postpone_slot','orl_update_slot_request']) loop
    foreach client in array array['anon','authenticated','service_role'] loop
      if has_function_privilege(client,fn,'EXECUTE') then
        raise exception 'Legacy overload or inherited grant remains; review before gating.';
      end if;
    end loop;
  end loop;
end $verify$;
commit;
