-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor -> New query -> Run).
-- Sets up the tables the job tracker needs. Safe to re-run: uses IF NOT EXISTS everywhere.

create table if not exists employees (
  id uuid primary key,
  name text not null
);

create table if not exists users (
  id uuid primary key,
  name text not null,
  email text not null unique,
  password_hash text not null,
  role text not null default 'staff',
  color text,
  created_at timestamptz not null default now()
);

-- Adds `color` to a users table that already existed before this column did
-- (the CREATE TABLE above only applies to a brand-new table).
alter table users add column if not exists color text;

-- One person per calendar colour: a partial unique index (color is nullable, so
-- anyone who hasn't picked yet doesn't collide with everyone else's null).
create unique index if not exists users_color_unique_idx on users (color) where color is not null;

create table if not exists sessions (
  token text primary key,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists jobs (
  id uuid primary key,
  job_reference text,
  client text not null,
  location text,
  employee_id uuid references employees(id),
  value numeric not null default 0,
  profit numeric not null default 0,
  status text not null default 'Won',
  date_won text,
  start_date text,
  description text,
  completed_at text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists job_documents (
  id uuid primary key,
  job_id uuid not null references jobs(id) on delete cascade,
  category text not null,
  original_name text not null,
  stored_name text not null,
  size bigint,
  uploaded_at timestamptz not null default now()
);

create table if not exists calendar_events (
  id uuid primary key,
  user_id uuid references users(id) on delete set null,
  user_name text,
  date text not null,
  end_date text,
  title text not null,
  duration_value numeric,
  duration_unit text,
  created_at timestamptz not null default now()
);

create index if not exists jobs_employee_id_idx on jobs (employee_id);
create index if not exists job_documents_job_id_idx on job_documents (job_id);
create index if not exists sessions_expires_at_idx on sessions (expires_at);
create index if not exists calendar_events_date_idx on calendar_events (date);

-- Lock every table down by default. The app only ever talks to Supabase using the
-- service-role key (which bypasses RLS), so these policies exist purely as a safety
-- net in case the anon/public key were ever exposed - with RLS on and no policies,
-- that key grants zero access.
alter table employees enable row level security;
alter table users enable row level security;
alter table sessions enable row level security;
alter table jobs enable row level security;
alter table job_documents enable row level security;
alter table calendar_events enable row level security;

-- Storage bucket for uploaded RAMS/drawings/signoff/photos. Private - the app proxies
-- downloads through its own authenticated API rather than exposing public file URLs.
insert into storage.buckets (id, name, public)
values ('job-documents', 'job-documents', false)
on conflict (id) do nothing;
