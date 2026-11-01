'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { importManual, parseCsv } = require('../sources/manual');
const { filterSources } = require('../filter');

test('CSV parser handles quoted commas and doubled quotes', () => {
  const rows = parseCsv('title,organisation\r\n"Visa, policy ""2024""",Ministry X\r\n');
  assert.equal(rows[0].title, 'Visa, policy "2024"');
  assert.equal(rows[0].organisation, 'Ministry X');
});

test('manual CSV import produces grey records and reports rows missing required fields', () => {
  const csv = 'title,organisation,year,method,url\nMedical visa review,Health Dept,2023,desk review,https://x.gov/a\n,No Title Org,2022,survey,\n';
  const { records, errors } = importManual(csv);
  assert.equal(records.length, 1);
  assert.equal(records[0].isGrey, true);
  assert.equal(records[0].type, 'grey');
  assert.equal(records[0].method, 'desk review');
  assert.match(errors[0], /row 2: missing title/);
});

test('manual JSON import works the same way', () => {
  const { records } = importManual('[{"title":"Industry outlook","organisation":"Trade Body","year":"2024","method":"survey of members"}]');
  assert.equal(records[0].year, 2024);
  assert.equal(records[0].organisation, 'Trade Body');
});

test('filter drops grey sources that do not state a method', () => {
  const recs = [
    { isGrey: true, title: 'A', organisation: 'Org', year: 2023, method: '' },
    { isGrey: true, title: 'B', organisation: 'Org', year: 2023, method: 'survey' }
  ];
  const out = filterSources(recs, {});
  assert.equal(out.kept.length, 1);
  assert.equal(out.kept[0].title, 'B');
  assert.equal(out.log.excludedBy['grey-no-method'], 1);
});
