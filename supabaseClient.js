const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (see scripts/supabase-schema.sql and README for setup)');
}

// Service-role key bypasses RLS - only ever used from this server, never sent to the browser.
const supabase = createClient(url, key, { auth: { persistSession: false } });

const DOCUMENTS_BUCKET = process.env.SUPABASE_BUCKET || 'job-documents';

module.exports = { supabase, DOCUMENTS_BUCKET };
