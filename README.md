# BD Construction — Job Tracker

A simple job tracker: log jobs, assign them to whoever won them, track value/profit/status,
import jobs straight from your job costing sheets, and view yearly reports of who won the
most money and total turnover.

## First-time setup

1. Install [Node.js](https://nodejs.org) (LTS version) if it isn't already installed.
2. Open a terminal in this folder and run:
   ```
   npm install
   ```
   This only needs to be done once (or again if you copy the folder to a new PC).

## Running the app

```
npm start
```

Then open **http://localhost:3000** in your browser.

Leave the terminal window open while people are using the tracker — closing it stops the app.

### Letting other office staff use it

The app runs on one PC and other people on the same office network/Wi-Fi can connect to it
from their own browser:

1. On the PC running the app, find its local IP address: open a terminal and run `ipconfig`,
   look for "IPv4 Address" (e.g. `192.168.1.42`).
2. Other staff open a browser and go to `http://192.168.1.42:3000` (using the real IP shown).
3. The terminal window also prints this address when you run `npm start`.

Everyone sees and edits the same data, live.

### Signing in

Each person needs their own account to use the tracker. The first time someone opens it,
they click **Create an account** (name, email, password) and are signed in straight away —
after that they use **Sign In** with the same email/password. Sign-in stays active for 30
days per device, and there's a **Sign Out** button top-right of the header.

Accounts are stored locally in `data/db.json`, same as everything else — there's no email
sent, nothing leaves this PC. The very first account created becomes an "admin" behind the
scenes; this doesn't do anything yet, but it's there ready for when permissions (who can see
or edit what) get added later.

There's no "forgot password" flow (no email is sent from this app). If someone forgets
theirs, open `data/db.json`, delete their entry from the `users` array, and have them create
the account again — ask if you'd like help with that.

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

All data is stored in `data/db.json` in this folder. Back this file up periodically
(e.g. copy it to OneDrive/a USB stick) — if the folder is lost, the data is lost.
There's no cloud storage involved; everything stays local to this PC.

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
