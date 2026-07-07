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

-- Links a user account to the matching employee record (matched by name at registration
-- time, e.g. "Neil Gaskell" signing up links to the "Neil Gaskell" employee), so a
-- non-admin can be shown only their own figures on the Yearly Reports tab.
alter table users add column if not exists employee_id uuid references employees(id) on delete set null;

-- One person per calendar colour: a partial unique index (color is nullable, so
-- anyone who hasn't picked yet doesn't collide with everyone else's null).
create unique index if not exists users_color_unique_idx on users (color) where color is not null;
create index if not exists users_employee_id_idx on users (employee_id);

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

-- Extra works added to a job after the original quote - scope changes are normal
-- mid-job, and without tracking them separately the job's quoted Value silently
-- stops matching what it's actually worth.
create table if not exists job_variations (
  id uuid primary key,
  job_id uuid not null references jobs(id) on delete cascade,
  description text not null,
  value numeric not null default 0,
  created_at timestamptz not null default now()
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
  start_time text,
  end_time text,
  is_private boolean not null default false,
  created_at timestamptz not null default now()
);

-- Adds columns to a calendar_events table that already existed before these did
-- (the CREATE TABLE above only applies to a brand-new table).
alter table calendar_events add column if not exists is_private boolean not null default false;
alter table calendar_events add column if not exists start_time text;
alter table calendar_events add column if not exists end_time text;

-- Labour rates and material prices used when pricing up quotes. `kind` splits the same
-- shape of data into the Labour tab and the Price List tab.
create table if not exists price_list_items (
  id uuid primary key,
  kind text not null,
  name text not null,
  price numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Hired-in plant/equipment, admin-only. Job number is free text (typed in directly)
-- rather than linked to a row in `jobs`, since a hire doesn't need to match an existing
-- job entry. Due-back date and overdue/due-soon flagging are computed from hire_date +
-- duration at read time (see db.js), not stored.
create table if not exists hires (
  id uuid primary key,
  item text not null,
  supplier text,
  -- job_id and job_description: no longer written by the app (job_number below replaced
  -- both as a single free-text field) - left in place rather than dropped so no data is
  -- lost from before this changed.
  job_id uuid references jobs(id) on delete set null,
  job_number text,
  job_description text,
  hire_date text not null,
  quantity numeric not null default 1,
  duration_value numeric not null default 1,
  duration_unit text not null default 'days',
  returned_at text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Adds job_number/job_description to a hires table that already existed before this
-- changed from a job dropdown to free text (the CREATE TABLE above only applies to a
-- brand-new table). job_description is no longer written to (see comment above) but the
-- column stays so nothing already saved there is lost.
alter table hires add column if not exists job_number text;
alter table hires add column if not exists job_description text;

-- Risk assessments staff upload themselves (as opposed to the generic in-code templates),
-- kept separate from any one job so the same file can be attached again next time that job
-- or a similar one comes up. The file bytes live in the same Storage bucket as job
-- documents, under a `_library/rams/` prefix.
create table if not exists saved_risk_assessments (
  id uuid primary key,
  name text not null,
  original_name text not null,
  stored_name text not null,
  size bigint,
  uploaded_by text,
  created_at timestamptz not null default now()
);

-- Personal diary: private journal entries, multiple per day, never shown to anyone but
-- the person who wrote them (not even admins) - the server always scopes reads/writes to
-- req.user.id, same trust boundary as `is_private` calendar_events but with no exception.
create table if not exists diary_entries (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  entry_date text not null,
  entry_text text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists diary_entries_user_id_date_idx on diary_entries (user_id, entry_date desc, created_at desc);

create index if not exists jobs_employee_id_idx on jobs (employee_id);
create index if not exists job_variations_job_id_idx on job_variations (job_id);
create index if not exists job_documents_job_id_idx on job_documents (job_id);
create index if not exists sessions_expires_at_idx on sessions (expires_at);
create index if not exists calendar_events_date_idx on calendar_events (date);
create index if not exists price_list_items_kind_idx on price_list_items (kind);
create index if not exists saved_risk_assessments_name_idx on saved_risk_assessments (name);
create index if not exists hires_job_id_idx on hires (job_id);
create index if not exists hires_hire_date_idx on hires (hire_date);

-- Lock every table down by default. The app only ever talks to Supabase using the
-- service-role key (which bypasses RLS), so these policies exist purely as a safety
-- net in case the anon/public key were ever exposed - with RLS on and no policies,
-- that key grants zero access.
alter table employees enable row level security;
alter table users enable row level security;
alter table sessions enable row level security;
alter table jobs enable row level security;
alter table job_variations enable row level security;
alter table job_documents enable row level security;
alter table calendar_events enable row level security;
alter table price_list_items enable row level security;
alter table saved_risk_assessments enable row level security;
alter table hires enable row level security;
alter table diary_entries enable row level security;

-- Storage bucket for uploaded RAMS/drawings/signoff/photos. Private - the app proxies
-- downloads through its own authenticated API rather than exposing public file URLs.
insert into storage.buckets (id, name, public)
values ('job-documents', 'job-documents', false)
on conflict (id) do nothing;
