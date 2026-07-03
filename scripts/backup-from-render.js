// One-time backup tool: logs into the LIVE app exactly like a browser would, and
// downloads everything (employees, jobs, calendar, uploaded documents) to a local
// "backup" folder. Safe to run against the live Render app - it only reads data,
// never writes.
//
// Usage:
//   node scripts/backup-from-render.js
// It will prompt for the site URL, your login email, and your password.

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const OUT_DIR = path.join(__dirname, '..', 'backup');
const DOCUMENT_CATEGORIES = ['rams', 'drawings', 'signoff', 'photos'];

const ENTER_CHARS = ['\n', '\r'];
const CTRL_C = '\x03';
const BACKSPACE_CHARS = ['\x7f', '\x08'];

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (!hidden) {
      rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
      return;
    }
    // Hide typed characters for password entry.
    const stdin = process.stdin;
    process.stdout.write(question);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (char) => {
      if (ENTER_CHARS.includes(char)) {
        stdin.setRawMode(false);
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        rl.close();
        resolve(value);
      } else if (char === CTRL_C) {
        process.exit(1);
      } else if (BACKSPACE_CHARS.includes(char)) {
        value = value.slice(0, -1);
      } else {
        value += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  let baseUrl = (await ask('Site URL [https://bd-job-tracker.onrender.com]: ')) || 'https://bd-job-tracker.onrender.com';
  baseUrl = baseUrl.replace(/\/+$/, '');
  const email = await ask('Login email: ');
  const password = await ask('Password: ', { hidden: true });

  console.log('\nLogging in...');
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!loginRes.ok) {
    const body = await loginRes.json().catch(() => ({}));
    throw new Error(`Login failed: ${body.error || loginRes.status}`);
  }
  const setCookie = typeof loginRes.headers.getSetCookie === 'function'
    ? loginRes.headers.getSetCookie()
    : [loginRes.headers.get('set-cookie')].filter(Boolean);
  const sidCookie = setCookie.map((c) => c.split(';')[0]).find((c) => c.startsWith('sid='));
  if (!sidCookie) throw new Error('Login succeeded but no session cookie was returned');
  const cookieHeader = sidCookie;

  async function apiGet(pathname) {
    const res = await fetch(`${baseUrl}${pathname}`, { headers: { Cookie: cookieHeader } });
    if (!res.ok) throw new Error(`GET ${pathname} failed: ${res.status}`);
    return res.json();
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('Fetching employees, jobs, calendar...');
  const [employees, jobs, calendar] = await Promise.all([
    apiGet('/api/employees'),
    apiGet('/api/jobs'),
    apiGet('/api/calendar'),
  ]);

  fs.writeFileSync(path.join(OUT_DIR, 'employees.json'), JSON.stringify(employees, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'jobs.json'), JSON.stringify(jobs, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'calendar.json'), JSON.stringify(calendar, null, 2));
  console.log(`Saved ${employees.length} employees, ${jobs.length} jobs, ${calendar.length} calendar entries.`);

  console.log('Downloading uploaded documents (this can take a while if there are many files)...');
  let fileCount = 0;
  for (const job of jobs) {
    for (const category of DOCUMENT_CATEGORIES) {
      const docs = (job.documents && job.documents[category]) || [];
      for (const doc of docs) {
        const destDir = path.join(OUT_DIR, 'uploads', job.id, category);
        fs.mkdirSync(destDir, { recursive: true });
        const destPath = path.join(destDir, doc.storedName);
        const res = await fetch(`${baseUrl}/api/jobs/${job.id}/documents/${category}/${doc.id}/file`, {
          headers: { Cookie: cookieHeader },
        });
        if (!res.ok) {
          console.warn(`  Skipping ${doc.originalName} (job ${job.id}/${category}): HTTP ${res.status}`);
          continue;
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(destPath, buffer);
        fileCount += 1;
      }
    }
  }
  console.log(`Downloaded ${fileCount} files.`);
  console.log(`\nDone. Backup saved to: ${OUT_DIR}`);
  console.log('Keep this folder safe until the Supabase migration is confirmed working.');
}

main().catch((err) => {
  console.error('\nBackup failed:', err.message);
  process.exit(1);
});
