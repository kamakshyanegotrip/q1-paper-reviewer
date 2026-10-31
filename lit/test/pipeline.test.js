'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { synthesize, buildPrompt } = require('../synthesis');
const { runLiteratureReview } = require('../pipeline');

const kept = [
  { doi: '10.1/a', title: 'Medical visas', year: 2021, authors: [{ family: 'Lee', given: 'A' }], abstract: 'Visa rules matter.', tierLabel: 'peer-reviewed', citations: 10 },
  { isGrey: true, organisation: 'Ministry of Tourism', title: 'Medical visa policy note', year: 2023, abstract: 'e-Medical visa.', tierLabel: 'grey literature' }
];

test('prompt lists only kept sources with their keys and forbids outside sources', () => {
  const p = buildPrompt('Q?', kept);
  assert.ok(p.includes('key: 10.1/a'));
  assert.ok(p.includes('Only') || p.includes('ONLY'));
  assert.ok(p.includes('Ministry of Tourism'));
});

test('synthesis accepts a draft whose citations are all kept', async () => {
  const llm = async () => 'Visa rules matter {{cite:10.1/a}}. Policy is e-based {{cite:ty:Medical visa policy note}}.';
  const r = await synthesize('Q?', kept, llm);
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1);
});

test('synthesis retries when the model invents a citation, then passes', async () => {
  const outputs = ['Claim {{cite:10.1/invented}}.', 'Claim {{cite:10.1/a}}.'];
  let calls = 0;
  const llm = async (prompt) => { calls++; if (calls === 2) assert.match(prompt, /10\.1\/invented/); return outputs[calls - 1]; };
  const r = await synthesize('Q?', kept, llm);
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
});

test('synthesis fails closed after max attempts and reports the bad keys', async () => {
  const llm = async () => 'Bad {{cite:10.1/nope}}.';
  const r = await synthesize('Q?', kept, llm, { maxAttempts: 2 });
  assert.equal(r.ok, false);
  assert.deepEqual(r.unknownKeys, ['10.1/nope']);
});

test('pipeline: default style is APA 7, references sorted, log present', async () => {
  const records = [
    { doi: '10.1/a', title: 'Medical visas', year: 2021, authors: [{ family: 'Lee', given: 'A' }], venue: 'J', citations: 10, tier: { scopus: 'active', sjrQuartile: 'Q1' }, abstract: 'x', type: 'article' },
    { doi: '10.1/a', title: 'Medical visas', year: 2021, authors: [{ family: 'Lee', given: 'A' }], venue: 'J', citations: 10, type: 'article' },
    { doi: '10.1/r', title: 'Retracted', year: 2020, retracted: true, type: 'article', authors: [] },
    { isGrey: true, organisation: 'UN Tourism', title: 'Report', year: 2023, publisher: 'UN Tourism', url: 'https://u' }
  ];
  const llm = async () => 'Visas matter {{cite:10.1/a}}. Reports add context {{cite:ty:Report}}.';
  const out = await runLiteratureReview({ question: 'Q?', records, llm });
  assert.equal(out.ok, true);
  assert.deepEqual(out.unresolvedKeys, []);
  assert.equal(out.style, 'apa7');
  assert.equal(out.labels['10.1/a'], '(Lee, 2021)');
  assert.equal(out.labels['ty:Report'], '(UN Tourism, 2023)');
  assert.equal(out.log.excludedBy.retracted, 1);
  assert.equal(out.log.excludedBy.duplicate, 1);
  assert.ok(out.references.length >= 1);
});

test('pipeline: returns not-ok with a reason when no source survives the filters', async () => {
  const r = await runLiteratureReview({ question: 'Q?', records: [{ doi: '10.1/r', title: 'R', retracted: true, type: 'article' }], llm: async () => '' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /No sources/);
});
