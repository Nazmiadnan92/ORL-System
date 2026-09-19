-- Request counts, not unique-patient counts. Staff scope mirrors patient search.
begin;
create or replace function public.orl_subspecialty_statistics(
 p_session_token uuid,p_from date default null,p_to date default null,
 p_sub text default '',p_specialist text default '',p_status text default 'ACTIVE',
 p_assignment text default '',p_offset integer default 0)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare u public.orl_users%rowtype; result jsonb;
begin
 u:=public.orl_require_session(p_session_token);
 if p_from>p_to then raise exception 'Start date must not be after end date.'; end if;
 if p_status is null or p_status not in('ACTIVE','PENDING','SCHEDULED','POSTPONED','APPROVED','COMPLETED','CANCELLED','REJECTED','ALL') then raise exception 'Invalid status filter.'; end if;
 if p_assignment is null or p_assignment not in('','ASSIGNED','UNASSIGNED') or p_offset is null or p_offset<0 then raise exception 'Invalid filter.'; end if;
 with scoped as (
  select r.id,r.request_number,r.patient_name,r.patient_ic,r.mrn,r.age,r.age_months,
   r.diagnosis,r.surgery,initcap(r.doctor) doctor,initcap(r.specialist) specialist,
   coalesce(nullif(trim(r.sub_specialty),''),'Unspecified') sub_specialty,
   r.status,r.postpone_count,r.created_at,r.assigned_slot_id,
   s.ot_date,sl.slot_type,sl.slot_number,
   case when s.ot_date is not null then s.ot_date else (r.created_at at time zone 'Asia/Kuala_Lumpur')::date end filter_date
  from public.orl_requests r
  left join public.orl_ot_slots sl on sl.id=r.assigned_slot_id
  left join public.orl_ot_sessions s on s.id=sl.session_id
  where (u.role in('ADMIN','WEBMASTER') or r.created_by=u.id)
   and r.status<>'DRAFT'
 ), filtered as (
  select * from scoped r where
   (p_from is null or filter_date>=p_from) and (p_to is null or filter_date<=p_to)
   and (coalesce(p_specialist,'')='' or lower(r.specialist) like '%'||lower(p_specialist)||'%')
   and (p_assignment='' or (p_assignment='ASSIGNED' and assigned_slot_id is not null) or (p_assignment='UNASSIGNED' and assigned_slot_id is null))
   and (p_status='ALL'
    or (p_status='ACTIVE' and status in('CONFIRMED','APPROVED','SCHEDULED'))
    or (p_status='PENDING' and status='CONFIRMED')
    or (p_status='POSTPONED' and postpone_count>0 and status in('CONFIRMED','APPROVED','SCHEDULED'))
    or (p_status not in('ACTIVE','PENDING','POSTPONED','ALL') and status=p_status))
 ), selected as (
  select * from filtered where coalesce(p_sub,'')='' or sub_specialty=p_sub
 ), page_rows as (
  select * from selected order by filter_date,id limit 100 offset p_offset
 )
 select jsonb_build_object(
  'scope',case when u.role='STAFF' then 'MY_REQUESTS' else 'ALL_REQUESTS' end,
  'cards',coalesce((select jsonb_agg(jsonb_build_object('name',sub_specialty,'count',n) order by sub_specialty)
    from (select sub_specialty,count(*) n from filtered group by sub_specialty) counts),'[]'::jsonb),
  'total',(select count(*) from selected),
  'rows',coalesce((select jsonb_agg(to_jsonb(p) - 'assigned_slot_id' order by filter_date,id) from page_rows p),'[]'::jsonb)
 ) into result;
 return result;
end $$;
revoke all on function public.orl_subspecialty_statistics(uuid,date,date,text,text,text,text,integer) from public,anon,authenticated;
grant execute on function public.orl_subspecialty_statistics(uuid,date,date,text,text,text,text,integer) to anon,authenticated;
notify pgrst,'reload schema';
commit;
