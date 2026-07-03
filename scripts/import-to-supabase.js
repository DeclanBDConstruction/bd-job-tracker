// One-time import: reads the local `backup/` folder produced by backup-from-render.js and
// seeds Supabase (tables + storage) with it. Safe to re-run - uses upsert throughout.
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to be set in the environment first, e.g.
// (PowerShell):
//   $env:SUPABASE_URL = "https://xxxx.supabase.co"
//   $env:SUPABASE_SERVICE_ROLE_KEY = "..."
//   node scripts/import-to-supabase.js

const fs = require('fs');
const path = require('path');
const { supabase, DOCUMENTS_BUCKET } = require('../supabaseClient');

const BACKUP_DIR = path.join(__dirname, '..', 'backup');
const DOCUMENT_CATEGORIES = ['rams', 'drawings', 'signoff', 'photos'];

function readJson(name) {
  const file = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(file)) throw new Error(`Missing ${file} - run scripts/backup-from-render.js first`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function main() {
  const employees = readJson('employees.json');
  const jobs = readJson('jobs.json');
  const calendar = readJson('calendar.json');

  console.log(`Importing ${employees.length} employees...`);
  if (employees.length) {
    const { error } = await supabase.from('employees')
      .upsert(employees.map((e) => ({ id: e.id, name: e.name })), { onConflict: 'id' });
    if (error) throw new Error(`employees: ${error.message}`);
  }

  console.log(`Importing ${jobs.length} jobs...`);
  if (jobs.length) {
    const rows = jobs.map((j) => ({
      id: j.id,
      job_reference: j.jobReference || null,
      client: j.client,
      location: j.location || '',
      employee_id: j.employeeId,
      value: j.value || 0,
      profit: j.profit || 0,
      status: j.status,
      date_won: j.dateWon,
      start_date: j.startDate || '',
      description: j.description || '',
      completed_at: j.completedAt || '',
      created_at: j.createdAt,
      updated_at: j.updatedAt,
    }));
    const { error } = await supabase.from('jobs').upsert(rows, { onConflict: 'id' });
    if (error) throw new Error(`jobs: ${error.message}`);
  }

  console.log('Importing job documents (metadata + files)...');
  let docCount = 0;
  let fileCount = 0;
  for (const job of jobs) {
    for (const category of DOCUMENT_CATEGORIES) {
      const docs = (job.documents && job.documents[category]) || [];
      for (const doc of docs) {
        const { error } = await supabase.from('job_documents').upsert({
          id: doc.id,
          job_id: job.id,
          category,
          original_name: doc.originalName,
          stored_name: doc.storedName,
          size: doc.size,
          uploaded_at: doc.uploadedAt,
        }, { onConflict: 'id' });
        if (error) throw new Error(`job_documents (${doc.originalName}): ${error.message}`);
        docCount += 1;

        const localFile = path.join(BACKUP_DIR, 'uploads', job.id, category, doc.storedName);
        if (fs.existsSync(localFile)) {
          const buffer = fs.readFileSync(localFile);
          const storagePath = `${job.id}/${category}/${doc.storedName}`;
          const { error: uploadErr } = await supabase.storage
            .from(DOCUMENTS_BUCKET)
            .upload(storagePath, buffer, { upsert: true });
          if (uploadErr) throw new Error(`storage upload (${doc.originalName}): ${uploadErr.message}`);
          fileCount += 1;
        } else {
          console.warn(`  File missing locally, skipped: ${localFile}`);
        }
      }
    }
  }
  console.log(`Imported ${docCount} document records, uploaded ${fileCount} files.`);

  console.log(`Importing ${calendar.length} calendar entries...`);
  if (calendar.length) {
    const rows = calendar.map((c) => ({
      id: c.id,
      user_id: c.userId,
      user_name: c.userName,
      date: c.date,
      end_date: c.endDate,
      title: c.title,
      duration_value: c.durationValue,
      duration_unit: c.durationUnit,
      created_at: c.createdAt,
    }));
    const { error } = await supabase.from('calendar_events').upsert(rows, { onConflict: 'id' });
    if (error) throw new Error(`calendar_events: ${error.message}`);
  }

  console.log('\nDone. Note: user accounts/passwords were NOT part of this import - the live');
  console.log('API never exposes password hashes, so each team member needs to register again');
  console.log('once with their same email after the new version is deployed.');
}

main().catch((err) => {
  console.error('\nImport failed:', err.message);
  process.exit(1);
});
