'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSearchUrl, normalizeWork, rebuildAbstract, searchOpenAlex } = require('../sources/openalex');
const { normalizeCrossref, isRetracted } = require('../sources/crossref');
const { oaUrl, freeFullText } = require('../sources/unpaywall');

test('OpenAlex: search URL carries query, page size, optional year filter and optional contact', () => {
  const u = buildSearchUrl('medical tourism India', { perPage: 10, yearFrom: 2016, mailto: 'me@example.org' });
  assert.match(u, /search=medical\+tourism\+India/);
  assert.match(u, /per-page=10/);
  assert.match(u, /from_publication_date%3A2016-01-01|from_publication_date:2016-01-01/);
  assert.match(u, /mailto=me%40example\.org/);
});

test('OpenAlex: no year filter and no contact unless set', () => {
  const u = buildSearchUrl('x');
  assert.ok(!/filter=/.test(u));
  assert.ok(!/mailto=/.test(u));
});

test('OpenAlex: abstract is rebuilt from the inverted index', () => {
  assert.equal(rebuildAbstract({ medical: [0], tourism: [1, 4], grows: [2], fast: [3] }), 'medical tourism grows fast tourism');
});

test('OpenAlex: work normalises to the engine record, incl. retraction flag', () => {
  const r = normalizeWork({
    doi: 'https://doi.org/10.1/abc', title: 'A study', publication_year: 2019, type: 'article',
    authorships: [{ author: { display_name: 'Jane Ann Smith' } }],
    primary_location: { source: { display_name: 'Tourism Management' } },
    cited_by_count: 42, is_retracted: false, abstract_inverted_index: { hello: [0], world: [1] }
  });
  assert.equal(r.doi, '10.1/abc');
  assert.deepEqual(r.authors[0], { family: 'Smith', given: 'Jane Ann' });
  assert.equal(r.venue, 'Tourism Management');
  assert.equal(r.abstract, 'hello world');
  assert.equal(r.citations, 42);
});

test('OpenAlex: search returns normalised records using the injected fetch', async () => {
  const fake = async () => ({ results: [{ doi: 'https://doi.org/10.1/x', title: 'T', publication_year: 2020, authorships: [], primary_location: null, cited_by_count: 1 }] });
  const out = await searchOpenAlex('q', {}, fake);
  assert.equal(out.length, 1);
  assert.equal(out[0].doi, '10.1/x');
});

test('Crossref: normalises DOI metadata', () => {
  const r = normalizeCrossref({
    DOI: '10.1/y', title: ['Policy review'], issued: { 'date-parts': [[2018, 5]] },
    author: [{ family: 'Kumar', given: 'R' }], 'container-title': ['Journal X'], volume: '3', issue: '1', page: '10-20'
  });
  assert.equal(r.year, 2018);
  assert.equal(r.venue, 'Journal X');
  assert.equal(r.retracted, false);
});

test('Crossref: retraction and withdrawal notices are detected', () => {
  assert.equal(isRetracted({ 'update-to': [{ type: 'retraction' }] }), true);
  assert.equal(isRetracted({ 'update-to': [{ type: 'withdrawal' }] }), true);
  assert.equal(isRetracted({ 'update-to': [{ type: 'correction' }] }), false);
  assert.equal(isRetracted({}), false);
});

test('Unpaywall: refuses to call without a configured contact email', () => {
  assert.throws(() => oaUrl('10.1/z', ''), /contact email/);
});

test('Unpaywall: returns the best open-access location', async () => {
  const fake = async () => ({ is_oa: true, best_oa_location: { url_for_pdf: 'https://x/pdf', url: 'https://x', license: 'cc-by' } });
  const r = await freeFullText('10.1/z', 'ops@example.org', fake);
  assert.deepEqual(r, { isOa: true, url: 'https://x/pdf', license: 'cc-by' });
});
