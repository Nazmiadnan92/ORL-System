-- ORL OT Management System: allow Admin/Webmaster reassignment involving Special slots
-- Run once in Supabase SQL Editor after 028.

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
  a_label text;
  b_label text;
begin
  v_user := public.orl_require_session(p_session_token);

  if v_user.role not in ('ADMIN', 'WEBMASTER') then
    raise exception 'Admin access required.';
  end if;

  if p_from = p_to then
    raise exception 'Choose a different OT slot.';
  end if;

  perform 1
  from public.orl_ot_slots
  where id in (p_from, p_to)
  order by id
  for update;

  select * into a from public.orl_ot_slots where id = p_from;
  if not found then raise exception 'Source OT slot not found.'; end if;

  select * into b from public.orl_ot_slots where id = p_to;
  if not found then raise exception 'Target OT slot not found.'; end if;

  if a.session_id <> b.session_id then
    raise exception 'Only slots on the same OT date can be reassigned.';
  end if;

  if a.request_id is null then
    raise exception 'Source OT slot is empty.';
  end if;

  if b.status = 'CLOSED' then
    raise exception 'A patient cannot be reassigned to a closed OT slot.';
  end if;

  perform 1
  from public.orl_requests
  where id in (a.request_id, b.request_id)
  order by id
  for update;

  update public.orl_requests
  set assigned_slot_id = null,
      updated_at = now()
  where id in (a.request_id, b.request_id);

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

  update public.orl_requests
  set assigned_slot_id = case
        when id = a.request_id then b.id
        when id = b.request_id then a.id
      end,
      updated_at = now()
  where id in (a.request_id, b.request_id);

  a_label := case when a.slot_type = 'SPECIAL' then 'Special' else 'Main' end || ' Slot ' || a.slot_number;
  b_label := case when b.slot_type = 'SPECIAL' then 'Special' else 'Main' end || ' Slot ' || b.slot_number;

  insert into public.orl_audit_log(
    user_id, user_name, user_role, action, record_type, record_id, details
  ) values (
    v_user.id, v_user.display_name, v_user.role,
    'OT_SLOT_REASSIGNED', 'OT_SESSION', a.session_id::text,
    case when b.request_id is null
      then a_label || ' moved to ' || b_label
      else a_label || ' swapped with ' || b_label
    end
  );
end;
$$;

revoke all on function public.orl_swap_slots(uuid, uuid, uuid) from public;
grant execute on function public.orl_swap_slots(uuid, uuid, uuid) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
