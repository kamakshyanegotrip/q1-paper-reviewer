'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatReference, resolveStyle } = require('../format');
const { filterSources } = require('../filter');
const { validateCitations } = require('../validate');

const paper = {
  doi: '10.1016/j.tourman.2020.104123', title: 'Medical tourism: a review', year: 2020,
  authors: [{ family: 'Smith', given: 'Jane Ann' }, { family: 'Kumar', given: 'R' }],
  venue: 'Tourism Management', volume: '81', issue: '2', pages: '104123'
};

test('no style selected defaults to APA 7', () => {
  assert.equal(resolveStyle(undefined), 'apa7');
  assert.equal(resolveStyle(''), 'apa7');
  assert.equal(formatReference(paper), formatReference(paper, 'apa7'));
});

test('APA 7 article reference', () => {
  assert.equal(formatReference(paper, 'apa7'),
    'Smith, J. A., & Kumar, R. (2020). Medical tourism: a review. Tourism Management, 81(2), 104123. https://doi.org/10.1016/j.tourman.2020.104123');
});

test('APA 7 uses ellipsis after 19 authors and the last author', () => {
  const authors = Array.from({ length: 25 }, (_, i) => ({ family: 'A' + i, given: 'X' }));
  const out = formatReference({ title: 'Big team', year: 2021, authors, venue: 'J' }, 'apa7');
  assert.ok(out.includes('A18, X., ... A24, X.'));
});

test('Harvard and Vancouver formats', () => {
  assert.match(formatReference(paper, 'harvard'), /^Smith, J\.A\. and Kumar, R\. \(2020\) 'Medical tourism: a review', Tourism Management 81\(2\), pp\. 104123\. doi:/);
  assert.match(formatReference(paper, 'vancouver'), /^Smith JA, Kumar R\. Medical tourism: a review\. Tourism Management\. 2020;81\(2\):104123\. doi:/);
});

test('unknown style is rejected, not silently changed', () => {
  assert.throws(() => resolveStyle('bluebook'), /Unknown citation style/);
});

test('grey literature cites the organisation as author', () => {
  const g = { isGrey: true, organisation: 'UN Tourism', title: 'Global report on medical tourism', year: 2023, publisher: 'UN Tourism', url: 'https://www.unwto.org/x', reportType: 'Report' };
  assert.equal(formatReference(g, 'apa7'),
    'UN Tourism (2023). Global report on medical tourism (Report). https://www.unwto.org/x');
});

test('retracted and duplicate sources are removed; year filter is off by default', () => {
  const recs = [
    { ...paper, citations: 10 },
    { ...paper, citations: 10 },                        // duplicate DOI
    { doi: '10.1/old', title: 'Old theory', year: 1985, citations: 50, tier: { scopus: 'active' }, type: 'article' },
    { doi: '10.1/bad', title: 'Retracted', year: 2021, retracted: true, type: 'article', citations: 3 }
  ];
  const { kept, log } = filterSources(recs);
  assert.equal(kept.length, 2);                          // old paper kept (no year filter), retracted and duplicate dropped
  assert.equal(log.excludedBy.duplicate, 1);
  assert.equal(log.excludedBy.retracted, 1);
});

test('when a year range is set, old papers drop unless foundational', () => {
  const recs = [
    { doi: '10.1/a', title: 'Recent', year: 2022, citations: 4, type: 'article' },
    { doi: '10.1/b', title: 'Old minor', year: 1990, citations: 20, type: 'article' },
    { doi: '10.1/c', title: 'Old foundational', year: 1985, citations: 900, type: 'article' }
  ];
  const { kept, log } = filterSources(recs, { yearFrom: 2016 });
  const titles = kept.map(k => k.title).sort();
  assert.deepEqual(titles, ['Old foundational', 'Recent']);
  assert.equal(log.excludedBy['before-year-range'], 1);
  assert.equal(kept.find(k => k.title === 'Old foundational').foundational, true);
});

test('citation floor and relevance threshold apply only when set', () => {
  const recs = [
    { doi: '10.1/x', title: 'Low cite, relevant', year: 2022, citations: 1, relevance: 0.9, type: 'article' },
    { doi: '10.1/y', title: 'High cite, off-topic', year: 2022, citations: 80, relevance: 0.2, type: 'article' }
  ];
  assert.equal(filterSources(recs).kept.length, 2);      // defaults: nothing extra applied
  const strict = filterSources(recs, { minCitations: 5, minRelevance: 0.5 });
  assert.equal(strict.kept.length, 0);
  assert.equal(strict.log.excludedBy['citation-floor'], 1);
});

test('venue tier applies only to peer-reviewed, and only when set', () => {
  const recs = [
    { doi: '10.1/q1', title: 'Q1', year: 2022, type: 'article', tier: { scopus: 'active', sjrQuartile: 'Q1' } },
    { doi: '10.1/q4', title: 'Q4', year: 2022, type: 'article', tier: { scopus: 'active', sjrQuartile: 'Q4' } },
    { title: 'Govt report', year: 2023, isGrey: true, organisation: 'Ministry of Tourism', method: 'desk review' }
  ];
  const { kept } = filterSources(recs, { minTier: { sjrQuartile: 'Q2' } });
  assert.deepEqual(kept.map(k => k.title).sort(), ['Govt report', 'Q1']);
});

test('validator rejects citation keys that are not in the kept list', () => {
  const text = 'Medical visas are growing {{cite:10.1/a}}. Fees vary by country {{cite:10.1/made-up}}.';
  const r = validateCitations(text, ['10.1/a']);
  assert.equal(r.ok, false);
  assert.deepEqual(r.unknownKeys, ['10.1/made-up']);
});

test('validator flags sentences with no citation', () => {
  const text = 'Medical visas are growing {{cite:10.1/a}}. This sentence has no source.';
  const r = validateCitations(text, ['10.1/a']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.uncitedSentences, ['This sentence has no source.']);
});
