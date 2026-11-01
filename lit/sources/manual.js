// Manual import for government and industry documents that have no usable API.
// Accepts CSV or JSON exported by the user (e.g. from a ministry or trade-body portal).
// Every imported record is marked isGrey and must state its research method, or the filter drops it.
'use strict';

const REQUIRED = ['title', 'organisation'];

// Minimal RFC 4180-style CSV parser (quoted fields, doubled quotes, CRLF or LF).
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => v !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(v => v !== '')) rows.push(row);
  if (rows.length === 0) return [];
  const header = rows[0].map(h => h.trim());
  return rows.slice(1).map(r => Object.fromEntries(header.map((h, i) => [h, (r[i] || '').trim()])));
}

function toRecord(raw, rowNo) {
  const missing = REQUIRED.filter(k => !raw[k]);
  if (missing.length) return { error: `row ${rowNo}: missing ${missing.join(', ')}` };
  const authors = raw.authors ? [{ family: raw.authors, given: '' }] : [];
  return {
    record: {
      isGrey: true,
      title: raw.title,
      organisation: raw.organisation,
      publisher: raw.publisher || '',
      reportType: raw.report_type || raw.reportType || 'report',
      year: raw.year ? Number(raw.year) : null,
      url: raw.url || '',
      doi: raw.doi || null,
      method: raw.method || '',          // stated research method; required by the filter
      authors,
      citations: 0,
      retracted: false,
      type: 'grey',
      source: 'manual'
    }
  };
}

// text: CSV or JSON string. Returns { records, errors }.
function importManual(text) {
  const trimmed = String(text || '').trim();
  let rows;
  if (trimmed.startsWith('[')) rows = JSON.parse(trimmed);
  else rows = parseCsv(trimmed);
  const records = [], errors = [];
  rows.forEach((raw, i) => {
    const out = toRecord(raw, i + 1);
    if (out.error) errors.push(out.error); else records.push(out.record);
  });
  return { records, errors };
}

module.exports = { importManual, parseCsv, toRecord };
