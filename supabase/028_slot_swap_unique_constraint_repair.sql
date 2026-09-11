-- ORL OT Management System: safely swap occupied Main OT slots
-- Run once in Supabase SQL Editor after 027.

begin;

create or replace function public.orl_swap_slots(
  p_session_token uuid,
  p_from uuid,
  p_to uuid
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user public.orl_users%rowtype;
  a public.orl_ot_slots%rowtype;
  b public.orl_ot_slots%rowtype;
begin
  v_user := public.orl_require_session(p_session_token);

  if v_user.role not in ('ADMIN', 'WEBMASTER') then
    raise exception 'Admin access required.';
  end if;

  if p_from = p_to then
    raise exception 'Choose a different Main OT slot.';
  end if;

  -- Lock both slots in a consistent order before reading their contents.
  perform 1
  from public.orl_ot_slots
  where id in (p_from, p_to)
  order by id
  for update;

  select * into a from public.orl_ot_slots where id = p_from;
  if not found then raise exception 'Source OT slot not found.'; end if;

  select * into b from public.orl_ot_slots where id = p_to;
  if not found then raise exception 'Target OT slot not found.'; end if;

  if a.session_id <> b.session_id or a.slot_type <> 'MAIN' or b.slot_type <> 'MAIN' then
    raise exception 'Only Main slots on the same OT date can be swapped.';
  end if;

  if a.request_id is null then
    raise exception 'Source OT slot is empty.';
  end if;

  if b.status = 'CLOSED' then
    raise exception 'A patient cannot be reassigned to a closed OT slot.';
  end if;

  -- Lock the affected requests, then release both request-side unique keys.
  perform 1
  from public.orl_requests
  where id in (a.request_id, b.request_id)
  order by id
  for update;

  update public.orl_requests
  set assigned_slot_id = null,
      updated_at = now()
  where id in (a.request_id, b.request_id);

  -- Clear both slot-side links before assigning either request to its new slot.
  update public.orl_ot_slots
  set request_id = null,
      status = 'AVAILABLE',
      updated_by = v_user.id,
      updated_at = now()
  where id in (a.id, b.id);

  update public.orl_ot_slots
  set request_id = b.request_id,
      status = case when b.request_id is null then 'AVAILABLE' else b.status end,
      updated_by = v_user.id,
      updated_at = now()
  where id = a.id;

  update public.orl_ot_slots
  set request_id = a.request_id,
      status = a.status,
      updated_by = v_user.id,
      updated_at = now()
  where id = b.id;

  -- Reconnect each request only after the old unique assignments are clear.
  update public.orl_requests
  set assigned_slot_id = case
        when id = a.request_id then b.id
        when id = b.request_id then a.id
      end,
      updated_at = now()
  where id in (a.request_id, b.request_id);

  insert into public.orl_audit_log(
    user_id, user_name, user_role, action, record_type, record_id, details
  ) values (
    v_user.id, v_user.display_name, v_user.role,
    'OT_SLOT_REASSIGNED', 'OT_SESSION', a.session_id::text,
    'Main Slot ' || a.slot_number || ' swapped with Main Slot ' || b.slot_number
  );
end;
$$;

revoke all on function public.orl_swap_slots(uuid, uuid, uuid) from public;
grant execute on function public.orl_swap_slots(uuid, uuid, uuid) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
