const XLSX = require('xlsx');

function excelDateToISO(value) {
  if (value === undefined || value === null || value === '') return '';
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'number') {
    // Excel serial date
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) {
      const mm = String(parsed.m).padStart(2, '0');
      const dd = String(parsed.d).padStart(2, '0');
      return `${parsed.y}-${mm}-${dd}`;
    }
  }
  const str = String(value).trim();
  // Try DD/MM/YYYY (common UK format)
  const ukMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (ukMatch) {
    let [, d, m, y] = ukMatch;
    if (y.length === 2) y = '20' + y;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  // Try ISO already
  const isoMatch = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return str;
}

function cellValue(sheet, addr) {
  const cell = sheet[addr];
  return cell ? cell.v : '';
}

// Reads BD Construction's standard per-job costing sheet template (one job per file —
// e.g. "J56056 Beehive Carlisle - Clean Kitchen.xlsx") and pulls out the fields at their
// fixed cell positions. Sheets that vary slightly from the standard layout are still read —
// whatever cells don't match just come back blank, and the app prompts for those on the form
// rather than blocking the import outright.
function parseJobSheet(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];

  // The sheet has three stacked lines under the logo: client (e.g. "Greene King"), then
  // site name and town (e.g. "Beehive" / "Carlisle"). The client is the account we bill —
  // one client can have many sites — so keep it separate from the location, otherwise the
  // Client Report ranks each site as if it were a different client.
  const client = String(cellValue(sheet, 'F1') || '').trim();
  const location = [cellValue(sheet, 'F3'), cellValue(sheet, 'F5')]
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .join(' ');

  const description = String(cellValue(sheet, 'A9') || '').trim();

  const rawValue = cellValue(sheet, 'M10');
  const value = typeof rawValue === 'number' ? rawValue : Number(String(rawValue || '').replace(/[£,]/g, '')) || '';

  return {
    jobReference: String(cellValue(sheet, 'L1') || '').trim(),
    client,
    location,
    dateWon: excelDateToISO(cellValue(sheet, 'L3')),
    value,
    employeeName: String(cellValue(sheet, 'I7') || '').trim(),
    description,
  };
}

module.exports = {
  parseJobSheet,
};
