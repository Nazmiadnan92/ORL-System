-- ORL OT Management System: generate National + Kedah holidays by year
-- Run once in Supabase SQL Editor after 001-017.

begin;

create extension if not exists http with schema extensions;

create or replace function public.orl_generate_public_holidays(
  p_session_token uuid,
  p_year integer
)
returns jsonb
language plpgsql
security definer
set search_path=public,extensions
as $$
declare
  u public.orl_users%rowtype;
  response extensions.http_response;
  item text[];
  date_text text;
  holiday_name text;
  states_text text;
  states_lower text;
  v_holiday_date date;
  found_count integer:=0;
  inserted_count integer:=0;
begin
  u:=public.orl_require_session(p_session_token);
  if u.role not in ('ADMIN','WEBMASTER') then
    raise exception 'Admin or Webmaster access required.';
  end if;
  if p_year<2026 or p_year>2100 then
    raise exception 'Year must be between 2026 and 2100.';
  end if;

  -- The reader bridge prevents Cloudflare from returning a different page to Supabase.
  -- It receives only the public calendar URL; no ORL or patient data is transmitted.
  perform set_config('http.curlopt_useragent','ORLOMS Holiday Generator/1.1',true);
  perform set_config('http.curlopt_timeout_ms','30000',true);

  select * into response
  from extensions.http_get(('https://r.jina.ai/http://calendarmalaysia.com/public-holidays-'||p_year||'/')::varchar);

  if response.status<>200 then
    raise exception 'Calendar Malaysia has no available holiday page for %.',p_year;
  end if;

  for item in
    select match
    from regexp_matches(
      response.content,
      E'\\|[ \\t]*([^|\\r\\n]+)[ \\t]*\\|[ \\t]*([^|\\r\\n]+)[ \\t]*\\|[ \\t]*([^|\\r\\n]+)[ \\t]*\\|[ \\t]*([^|\\r\\n]+)[ \\t]*\\|',
      'g'
    ) as holiday_rows(match)
  loop
    date_text:=trim(item[1]);
    holiday_name:=trim(item[3]);
    states_text:=trim(item[4]);
    if date_text!~ '^[0-9]{1,2}[[:space:]][A-Za-z]{3}$' then continue; end if;

    states_lower:=lower(states_text);
    if states_lower='national'
       or (states_lower like 'national%' and states_lower not like '%except%kedah%')
       or states_lower like '%kedah%' then
      v_holiday_date:=to_date(date_text||' '||p_year,'DD Mon YYYY');
      found_count:=found_count+1;
      insert into public.orl_holidays(holiday_date,title,description,created_by)
      values(v_holiday_date,holiday_name,'Generated from Calendar Malaysia '||p_year||' — '||states_text,u.id)
      on conflict(holiday_date) do nothing;
      if found then inserted_count:=inserted_count+1; end if;
    end if;
  end loop;

  if found_count=0 then
    raise exception 'Calendar Malaysia returned a page, but its holiday table could not be read for %.',p_year;
  end if;

  insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,record_id,details)
  values(u.id,u.display_name,u.role,'HOLIDAYS_GENERATED','HOLIDAY',p_year::text,
         inserted_count||' added; '||(found_count-inserted_count)||' existing date(s) kept; source Calendar Malaysia');

  return jsonb_build_object('year',p_year,'matched',found_count,'inserted',inserted_count,'skipped',found_count-inserted_count);
end $$;

revoke all on function public.orl_generate_public_holidays(uuid,integer) from public;
grant execute on function public.orl_generate_public_holidays(uuid,integer) to anon,authenticated;

commit;
