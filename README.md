# BD Construction — Job Tracker

A simple job tracker: log jobs, assign them to whoever won them, track value/profit/status,
import jobs straight from your job costing sheets, and view yearly reports of who won the
most money and total turnover.

Data lives in Supabase (Postgres for records, Supabase Storage for uploaded files —
RAMS, drawings, sign-off sheets, photos), not on a local disk, so everyone is always looking
at the same live data no matter which device or network they're on.

## First-time setup

1. Install [Node.js](https://nodejs.org) (LTS version) if it isn't already installed.
2. Open a terminal in this folder and run:
   ```
   npm install
   ```
   This only needs to be done once (or again if you copy the folder to a new PC).
3. Set the Supabase environment variables the server needs to connect (see
   `scripts/supabase-schema.sql` for the database schema). At minimum:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SUPABASE_BUCKET` (optional, defaults to `job-documents`)

## Running the app locally

```
npm start
```

Then open **http://localhost:3000** in your browser.

Leave the terminal window open while people are using the tracker — closing it stops the app.

### Letting other office staff use it over Wi-Fi

Anyone on the same office network/Wi-Fi as the PC running the app can connect to it
from their own browser (including phones):

1. On the PC running the app, find its local IP address: open a terminal and run `ipconfig`,
   look for "IPv4 Address" (e.g. `192.168.1.42`).
2. Other staff open a browser and go to `http://192.168.1.42:3000` (using the real IP shown).
3. The terminal window also prints this address when you run `npm start`.

This only works while that PC is on, running the app, and everyone's on the same network.

## Using it on your phone from anywhere (not just office Wi-Fi)

For access away from the office (e.g. on site, on mobile data), the app needs to run
somewhere always-on and internet-reachable rather than on one PC — deploy it to a host
like [Render](https://render.com):

1. Push this repo to GitHub (if it isn't already).
2. In Render, create a new **Web Service** from the repo — a `render.yaml` blueprint is
   included in this repo, so Render can pick up the build/start commands automatically.
3. Set the `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` environment variables on the
   Render service (same values as your local setup, from the Supabase project's API
   settings) so it points at the same data everyone already uses.
4. Once deployed, Render gives you an `https://…onrender.com` URL — open that on any
   phone/laptop, on any network, and sign in as normal.

On a phone, open that URL in the browser and use **Add to Home Screen** — the tracker has
an app icon and manifest set up, so it opens full-screen like a normal app from then on.

*Note: this project was deployed to Render before (`bd-job-tracker.onrender.com`), but
that service isn't currently responding — check the Render dashboard to see whether it
needs restarting, or whether a fresh deployment is simpler.*

### Signing in

Each person needs their own account to use the tracker. The first time someone opens it,
they click **Create an account** (name, email, password) and are signed in straight away —
after that they use **Sign In** with the same email/password. Sign-in stays active for 30
days per device, and there's a **Sign Out** button top-right of the header.

Accounts are stored in Supabase, same as everything else — there's no email sent as part
of sign-up. The very first account created becomes an "admin", which grants extra
permissions (deleting jobs, managing the employee list, promoting other admins).

There's no "forgot password" flow (no email is sent from this app). If someone forgets
theirs, delete their row from the `users` table in Supabase and have them create the
account again — ask if you'd like help with that.

## Importing a job from a job costing sheet

If you've got a BD Construction job costing sheet (one job per file, like
`J56056 Beehive Carlisle - Clean Kitchen.xlsx`), click **Import Job Sheet** on the Jobs tab
and choose the file. It reads the Job Number, Client, Employee, Date, Value and Description
straight off the sheet and opens the job form pre-filled — review it and click **Save Job**.
Nothing is saved until you do. Profit and Status aren't pulled in; add those later by editing
the job.

If a sheet is laid out slightly differently and some fields can't be read, it still imports
what it can find — the form just flags which fields it couldn't read (e.g. "Couldn't read
Employee from that file") so you can fill those in yourself before saving.

**Re-importing:** if the sheet's Job Number matches a job already in the tracker, you'll be
asked whether to update that job (pre-filled with the sheet's latest figures) or create a
separate new one — it never updates an existing job silently. So once a job's quote is
updated, re-upload the same sheet and confirm to sync it.

## Data

All data (jobs, employees, calendar, accounts) lives in Supabase — Postgres for records,
Supabase Storage for uploaded files (RAMS, drawings, sign-off sheets, photos). It's not
tied to any one PC, so losing/wiping this folder doesn't lose the data.

To back everything up to a local folder anyway (e.g. before a big change), run
`node scripts/backup-from-render.js` — it logs into the live app like a browser would and
downloads jobs, employees, calendar and all uploaded documents into `backup/`.

## What's tracked per job

- Job Number (optional, but needed for job sheet re-import matching)
- Client — the account/company, e.g. "Greene King". One client can have many locations;
  the Client Report totals them all together under this name
- Location — the site/town, e.g. "Beehive Carlisle" (optional)
- Employee who won it
- Date won
- Start Date — when work on site begins (optional, drives the Progress column below)
- Value (£)
- Profit (£) — added later, once the job's finished and the real number is known
- Status (Won, In Progress, Complete, Invoiced, Lost, Cancelled) — also set/changed after
  creation, from the Edit Job form
- Notes

## Progress tracker

Alongside Status, each job also shows a **Progress** pill in the Jobs table:
- **Not Started** — no Start Date set yet, or it's still in the future
- **Active** — the Start Date has arrived
- **Completed** — someone has manually closed the job down

Filling in a job's Start Date moves it from Not Started to Active automatically. Getting to
**Completed** is always a deliberate action, though — click **Mark Complete** on the job (once
you're done with it) and it moves off to the **Completed Jobs** tab, out of the way of your
open work. Nothing happens automatically just because a date passes or Status changes.

If a job was closed by mistake, open the **Completed Jobs** tab and click **Reopen** — it
moves straight back to the main Jobs list with everything else about it untouched.

## Reports

The **Yearly Reports** tab shows, for each year (by Date Won):
- Total turnover (sum of job value) and total profit
- Number of jobs won
- Each employee's total value/profit/job count, ranked highest first
- The top earner for that year

The **Client Report** tab shows an all-time ranking of clients by how much money they've
brought in (total value across all their jobs, any year), along with total profit and job
count per client, and calls out the biggest client at the top.
