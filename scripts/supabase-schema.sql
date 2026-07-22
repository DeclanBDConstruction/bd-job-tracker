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

-- Grants specific non-admin users the right to manage the Quoting tab (add/edit/assign/
-- delete quote jobs) without making them a full admin. Admins can always manage quotes too.
-- Superseded by the 'surveyor' role below (which grants quoting automatically) - column
-- kept only so historical data isn't lost, the app no longer reads or writes it.
alter table users add column if not exists can_manage_quotes boolean not null default false;

-- role now has five values: admin, staff (general office), surveyor (office + quoting
-- rights), installation_operative, manufacturing_operative (the last two have no office
-- features yet - see the operative-lockout middleware in server.js). One-time migration:
-- carry forward anyone who already had can_manage_quotes set so they don't lose quoting
-- rights on upgrade (safe to re-run - a no-op once everyone's already 'surveyor').
update users set role = 'surveyor' where can_manage_quotes = true and role = 'staff';

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

-- Who's physically doing the work on a job (installation/manufacturing operatives) - as
-- opposed to jobs.employee_id, which is who commercially WON the job (sales credit), a
-- separate concept entirely. One row per operative per stint of work: which job, which
-- operative, a task description, and a start date + duration in days (same shape as
-- calendar_events - end_date computed the same way in db.js). Each operative marks their
-- OWN assignment done independently - entirely separate from jobs.completed_at/the office
-- "Mark Complete" flow (db.completeJob), which stays admin/office-only. Photos an operative
-- uploads land in the ordinary job_documents 'photos' category, not a separate table, so
-- they show up in the normal Job Detail Photos tab unchanged.
create table if not exists job_assignments (
  id uuid primary key,
  job_id uuid not null references jobs(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  assigned_by uuid references users(id) on delete set null,
  task text not null,
  start_date text not null,
  duration_days numeric not null default 1,
  end_date text not null,
  completed boolean not null default false,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per assignment per calendar day actually worked - a job spanning several days
-- gets a fresh row each day (clock_in_at/arrived_at/clock_out_at), so multi-day jobs keep a
-- day-by-day record rather than one blurred-together total. completed_at is only ever set
-- on whichever day's row the operative actually marks the assignment done on (see
-- setJobAssignmentCompleted in db.js, which requires that day's arrived_at to already be
-- set first) - "how long they were there" is computed as completed_at minus arrived_at, at
-- read time, not stored. All four timestamps are server-stamped at the moment the operative
-- taps the button (never client-supplied/editable), so the record can't be backdated.
create table if not exists assignment_time_logs (
  id uuid primary key,
  assignment_id uuid not null references job_assignments(id) on delete cascade,
  log_date text not null,
  clock_in_at timestamptz,
  arrived_at timestamptz,
  completed_at timestamptz,
  clock_out_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists assignment_time_logs_assignment_date_idx on assignment_time_logs (assignment_id, log_date);

-- One RAMS (Risk Assessment & Method Statement) submission per job_assignment (not per day) -
-- operative reviews/adjusts risk controls and hazards before starting work, once for the whole
-- assignment stint. Submitting this is a prerequisite for marking Arrived (see the gate in
-- db.js markArrived). Locks once arrived_at is set on that day's time log - see
-- createJobAssignmentRams in db.js.
-- hazards is a jsonb array; each element is a full editable copy of one selected generic
-- risk-assessment template (title/legislation/hazard/peopleAffected/currentControls/
-- currentL/currentC/additionalControls/additionalL/additionalC/ppe - same shape as
-- riskAssessments.js's templates), so both the original content and the operative's edits are
-- preserved together, independent of the in-code template changing later.
create table if not exists job_assignment_rams (
  id uuid primary key,
  assignment_id uuid not null references job_assignments(id) on delete cascade,
  method_statement text not null,
  hazards jsonb not null default '[]'::jsonb,
  operative_name text not null,
  signature_image text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists job_assignment_rams_assignment_idx on job_assignment_rams (assignment_id);

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

-- Hired-in vehicles, admin-only. Unlike `hires` above there's no due-back date - a
-- vehicle just stays on-hire until someone off-hires it, which is one-way (see
-- markVehicleHireOffHired in db.js) and stamps off_hire_date + any damage_comments at
-- that point.
create table if not exists vehicle_hires (
  id uuid primary key,
  supplier text,
  hire_date text not null,
  registration text not null,
  make text,
  model text,
  signed_in text,
  signed_out text,
  off_hire_date text,
  damage_comments text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists vehicle_hires_hire_date_idx on vehicle_hires (hire_date);
create index if not exists vehicle_hires_registration_idx on vehicle_hires (registration);

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

-- Staff-edited copies of a risk assessment (either a generic in-code template or another
-- custom one), tweaked and "Save As"-ed under a new title - never overwrites the original,
-- so the in-code generic templates stay untouched and nothing already saved is lost.
create table if not exists custom_risk_assessments (
  id uuid primary key,
  title text not null,
  legislation text,
  hazard text,
  people_affected text,
  current_controls jsonb not null default '[]'::jsonb,
  current_l int not null default 1,
  current_c int not null default 1,
  additional_controls jsonb not null default '[]'::jsonb,
  additional_l int not null default 1,
  additional_c int not null default 1,
  ppe jsonb not null default '[]'::jsonb,
  based_on text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Personal diary: private journal entries, multiple per day, never shown to anyone but
-- the person who wrote them (not even admins) - the server always scopes reads/writes to
-- req.user.id, same trust boundary as `is_private` calendar_events but with no exception.
create table if not exists diary_entries (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  entry_date text not null,
  entry_text text not null,
  completed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Adds `completed` to a diary_entries table that already existed before tick-off/rollover
-- did (the CREATE TABLE above only applies to a brand-new table).
alter table diary_entries add column if not exists completed boolean not null default false;

create index if not exists diary_entries_user_id_date_idx on diary_entries (user_id, entry_date desc, created_at desc);

-- Subcontractors directory: shared contact list anyone can add to, so the whole office
-- knows who to call for a given trade without digging through phones/emails. Each subby
-- must have a signed subcontractor form on file - the file bytes live in the same Storage
-- bucket as job documents, under a `_library/subbies/` prefix.
create table if not exists subbies (
  id uuid primary key,
  company_name text not null,
  person_name text not null,
  phone text,
  trade text,
  form_original_name text,
  form_stored_name text,
  form_size bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Adds the subcontractor form columns to a subbies table that already existed before
-- upload-on-add became required (the CREATE TABLE above only applies to a brand-new
-- table). Nullable so subbies added before this change don't break.
alter table subbies add column if not exists form_original_name text;
alter table subbies add column if not exists form_stored_name text;
alter table subbies add column if not exists form_size bigint;

create index if not exists subbies_company_name_idx on subbies (company_name);

-- Quote jobs to be distributed to surveyors: added by whoever manages quoting (admins,
-- plus anyone with can_manage_quotes), assigned to a surveyor's user account, then ticked
-- off once quoted. Not scoped to a job record since a quote often precedes a job existing.
create table if not exists quotes (
  id uuid primary key,
  client_name text not null,
  site_address text,
  description text,
  due_date date,
  assigned_to uuid references users(id) on delete set null,
  quoted boolean not null default false,
  quoted_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists quotes_assigned_to_idx on quotes (assigned_to);

-- Inventory of physical site signs, shared and editable by anyone (removing a sign is
-- admin-only, same as other shared directories like subbies). Seeded once with 10 rows
-- when the table is first empty (see ensureSignageSeeded in db.js); after that, users
-- add/remove signs themselves. Each sign links to the job it's currently out at - blank
-- means it's back in the yard and available. `location` is no longer written to (job_id
-- replaced it) but the column stays so nothing already saved there is lost.
create table if not exists signage (
  id uuid primary key,
  sign_number int not null unique,
  label text not null,
  location text,
  job_id uuid references jobs(id) on delete set null,
  notes text,
  updated_at timestamptz not null default now()
);

-- Adds job_id to a signage table that already existed before signs were linked to an
-- actual job record (the CREATE TABLE above only applies to a brand-new table).
alter table signage add column if not exists job_id uuid references jobs(id) on delete set null;

create index if not exists signage_sign_number_idx on signage (sign_number);
create index if not exists signage_job_id_idx on signage (job_id);

create index if not exists jobs_employee_id_idx on jobs (employee_id);
create index if not exists job_variations_job_id_idx on job_variations (job_id);
create index if not exists job_documents_job_id_idx on job_documents (job_id);
create index if not exists job_assignments_job_id_idx on job_assignments (job_id);
create index if not exists job_assignments_user_id_idx on job_assignments (user_id);
create index if not exists sessions_expires_at_idx on sessions (expires_at);
create index if not exists calendar_events_date_idx on calendar_events (date);
create index if not exists price_list_items_kind_idx on price_list_items (kind);
create index if not exists saved_risk_assessments_name_idx on saved_risk_assessments (name);
create index if not exists custom_risk_assessments_title_idx on custom_risk_assessments (title);
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
alter table job_assignments enable row level security;
alter table assignment_time_logs enable row level security;
alter table calendar_events enable row level security;
alter table price_list_items enable row level security;
alter table saved_risk_assessments enable row level security;
alter table custom_risk_assessments enable row level security;
alter table hires enable row level security;
alter table vehicle_hires enable row level security;
alter table job_assignment_rams enable row level security;
alter table diary_entries enable row level security;
alter table subbies enable row level security;
alter table quotes enable row level security;
alter table signage enable row level security;

-- Storage bucket for uploaded RAMS/drawings/signoff/photos. Private - the app proxies
-- downloads through its own authenticated API rather than exposing public file URLs.
insert into storage.buckets (id, name, public)
values ('job-documents', 'job-documents', false)
on conflict (id) do nothing;
