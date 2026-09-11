-- ORL OT Management System: PostgreSQL foundation
-- Foundational schema for a new ORL OT Management System database.
-- Never commit patient data, credentials or exported .orlbackup files to Git.

begin;

create table if not exists public.orl_users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique check (username ~ '^[A-Za-z0-9._-]{3,40}$'),
  password_hash text not null,
  display_name text not null,
  role text not null check (role in ('WEBMASTER', 'ADMIN', 'STAFF')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.orl_settings (
  setting_key text primary key,
  setting_value text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.orl_holidays (
  id uuid primary key default gen_random_uuid(),
  holiday_date date not null unique,
  title text not null,
  description text not null default '',
  is_active boolean not null default true,
  created_by uuid references public.orl_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.orl_ot_sessions (
  id uuid primary key default gen_random_uuid(),
  ot_date date not null unique,
  day_name text not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'CANCELLED')),
  note text not null default '',
  special_title text not null default '',
  updated_by uuid references public.orl_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.orl_requests (
  id uuid primary key default gen_random_uuid(),
  request_number text not null unique,
  patient_ic text not null,
  mrn text not null,
  patient_name text not null,
  surgery text not null,
  diagnosis text not null,
  doctor text not null,
  specialist text not null,
  sub_specialty text not null,
  phone text not null,
  remark text not null default '',
  status text not null default 'DRAFT' check (status in ('DRAFT', 'CONFIRMED', 'PENDING REVIEW', 'APPROVED', 'REJECTED', 'SCHEDULED', 'COMPLETED', 'CANCELLED')),
  confirmed_at timestamptz,
  reviewed_by uuid references public.orl_users(id) on delete set null,
  reviewed_at timestamptz,
  review_note text not null default '',
  requested_year integer,
  requested_month integer check (requested_month between 1 and 12),
  postpone_count integer not null default 0 check (postpone_count between 0 and 999),
  postpone_history jsonb not null default '[]'::jsonb,
  deletion_status text not null default '' check (deletion_status in ('', 'PENDING', 'APPROVED')),
  deletion_reason text not null default '',
  deletion_requested_by uuid references public.orl_users(id) on delete set null,
  deletion_requested_at timestamptz,
  created_by uuid references public.orl_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.orl_ot_slots (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.orl_ot_sessions(id) on delete cascade,
  slot_type text not null check (slot_type in ('MAIN', 'SPECIAL')),
  slot_number integer not null check (slot_number > 0),
  request_id uuid unique references public.orl_requests(id) on delete set null,
  status text not null default 'AVAILABLE' check (status in ('AVAILABLE', 'RESERVED', 'CONFIRMED')),
  updated_by uuid references public.orl_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, slot_type, slot_number)
);

create table if not exists public.orl_audit_log (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  user_id uuid references public.orl_users(id) on delete set null,
  user_name text not null default '',
  user_role text not null default '',
  action text not null,
  record_type text not null default '',
  record_id text not null default '',
  details text not null default ''
);

create index if not exists orl_requests_status_idx on public.orl_requests(status);
create index if not exists orl_requests_created_at_idx on public.orl_requests(created_at desc);
create index if not exists orl_requests_postpone_count_idx on public.orl_requests(postpone_count desc);
create index if not exists orl_sessions_ot_date_idx on public.orl_ot_sessions(ot_date);
create index if not exists orl_slots_session_idx on public.orl_ot_slots(session_id, slot_type, slot_number);
create index if not exists orl_audit_occurred_at_idx on public.orl_audit_log(occurred_at desc);

insert into public.orl_settings (setting_key, setting_value)
values
  ('SYSTEM_NAME', 'ORL OT MANAGEMENT SYSTEM'),
  ('START_YEAR', '2026'),
  ('END_YEAR', '2100'),
  ('OT_DAYS', '0,3'),
  ('MAIN_SLOTS', '5'),
  ('SPECIAL_SLOTS', '2')
on conflict (setting_key) do nothing;

commit;
