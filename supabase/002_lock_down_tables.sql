-- Keep the ORL schema private until the server-side API is ready.
-- No public/anonymous access is permitted to patient or operational data.

begin;

alter table public.orl_users enable row level security;
alter table public.orl_settings enable row level security;
alter table public.orl_holidays enable row level security;
alter table public.orl_ot_sessions enable row level security;
alter table public.orl_requests enable row level security;
alter table public.orl_ot_slots enable row level security;
alter table public.orl_audit_log enable row level security;

revoke all on table public.orl_users from anon, authenticated;
revoke all on table public.orl_settings from anon, authenticated;
revoke all on table public.orl_holidays from anon, authenticated;
revoke all on table public.orl_ot_sessions from anon, authenticated;
revoke all on table public.orl_requests from anon, authenticated;
revoke all on table public.orl_ot_slots from anon, authenticated;
revoke all on table public.orl_audit_log from anon, authenticated;

commit;
