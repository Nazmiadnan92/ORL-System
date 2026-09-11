-- ORL OT Management System: secure patient search by MRN, IC/Passport or name
-- Run once in Supabase SQL Editor after 026.

begin;

create or replace function public.orl_find_patient_search(
  p_session_token uuid,
  p_search text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user public.orl_users%rowtype;
  v_query text := trim(coalesce(p_search, ''));
  v_compact text := regexp_replace(lower(trim(coalesce(p_search, ''))), '[^a-z0-9]', '', 'g');
begin
  v_user := public.orl_require_session(p_session_token);

  if length(v_query) < 2 then
    raise exception 'Enter at least 2 characters to search.';
  end if;

  return coalesce((
    with matches as (
      select
        r.*,
        s.ot_date,
        sl.slot_type,
        sl.slot_number,
        case
          when lower(trim(r.mrn)) = lower(v_query) then 0
          when v_compact <> '' and regexp_replace(lower(coalesce(r.patient_ic, '')), '[^a-z0-9]', '', 'g') = v_compact then 1
          when lower(trim(r.patient_name)) = lower(v_query) then 2
          when lower(r.patient_name) like lower(v_query) || '%' then 3
          else 4
        end as match_rank
      from public.orl_requests r
      left join public.orl_ot_slots sl on sl.id = r.assigned_slot_id
      left join public.orl_ot_sessions s on s.id = sl.session_id
      where (v_user.role in ('ADMIN', 'WEBMASTER') or r.created_by = v_user.id)
        and (
          lower(trim(r.mrn)) = lower(v_query)
          or (
            v_compact <> ''
            and regexp_replace(lower(coalesce(r.patient_ic, '')), '[^a-z0-9]', '', 'g') = v_compact
          )
          or (
            length(v_query) >= 3
            and lower(r.patient_name) like '%' || lower(v_query) || '%'
          )
        )
      order by match_rank, r.updated_at desc
      limit 100
    )
    select jsonb_agg(
      jsonb_build_object(
        'id', m.id,
        'request_number', m.request_number,
        'patient_name', m.patient_name,
        'patient_ic', m.patient_ic,
        'age', m.age,
        'mrn', m.mrn,
        'surgery', m.surgery,
        'diagnosis', m.diagnosis,
        'doctor', m.doctor,
        'specialist', m.specialist,
        'sub_specialty', m.sub_specialty,
        'phone', m.phone,
        'remark', m.remark,
        'status', m.status,
        'postpone_count', m.postpone_count,
        'created_at', m.created_at,
        'ot_date', m.ot_date,
        'slot_type', m.slot_type,
        'slot_number', m.slot_number
      )
      order by m.match_rank, m.updated_at desc
    )
    from matches m
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.orl_find_patient_search(uuid, text) from public;
grant execute on function public.orl_find_patient_search(uuid, text) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
