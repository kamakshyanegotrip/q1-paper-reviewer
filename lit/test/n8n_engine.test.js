'use strict';
// Runs the draft n8n workflow's Code node with mocked n8n globals and HTTP.
const test = require('node:test');
const assert = require('node:assert/strict');
const { workflow } = require('../n8n/build');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const authOk = { authorized: true, role: 'admin', user_id: 1 };
const authNo = { authorized: false, role: '', user_id: null };
const code = workflow().nodes.find(n => n.name === 'Literature engine').parameters.jsCode;

function mockHttp(calls) {
  return async (opts) => {
    calls.push(opts.url);
    const u = opts.url;
    if (u.includes('api.anthropic.com')) {
      const prompt = opts.body.messages[0].content;
      const key = (prompt.match(/key: ([^\s|]+)/) || [])[1];
      return { content: [{ type: 'text', text: `Visa rules shape demand {{cite:${key}}}.` }] };
    }
    if (u.includes('api.openalex.org')) return { results: [
      { doi: 'https://doi.org/10.1/visa', title: 'Medical visas and demand', publication_year: 2021, type: 'article',
        authorships: [{ author: { display_name: 'Ana Lee' } }], primary_location: { source: { display_name: 'Health J' } }, cited_by_count: 40, abstract_inverted_index: { Visa: [0] } },
      { display_name: 'Official report on medical tourism', publication_year: 2023, type: 'report', doi: null,
        authorships: [{ institutions: [{ display_name: 'Ministry of Tourism' }] }], primary_location: { landing_page_url: 'https://tourism.gov.in/r' } },
      { display_name: 'Unvetted report', publication_year: 2023, type: 'report', authorships: [{ institutions: [{ display_name: 'Some Blog' }] }] }
    ] };
    if (u.includes('europepmc')) return { resultList: { result: [] } };
    if (u.includes('doaj.org')) return { results: [] };
    return { results: [] };
  };
}

async function runNode(body, env, calls, auth = authOk) {
  const fn = new AsyncFunction('$input', '$helpers', '$env', '$', code);
  const $ = () => ({ first: () => ({ json: auth }) });
  return fn({ first: () => ({ json: { body } }) }, { httpRequest: mockHttp(calls) }, env, $);
}

const goodBody = {
  key: 'q1k-test', question: 'What does the literature show about medical visas?',
  queries: JSON.stringify(['medical visa demand']), style: 'mla', filters: JSON.stringify({ includeGrey: true })
};

test('draft workflow: refuses requests the checker does not authorise', async () => {
  const out = await runNode(goodBody, {}, [], authNo);
  assert.equal(out[0].json.ok, false);
  assert.match(out[0].json.reason, /Not authorised/);
});

test('draft workflow: refuses when the key checker does not authorise', async () => {
  const out = await runNode(goodBody, {}, [], authNo);
  assert.match(out[0].json.reason, /Not authorised/);
});

test('draft workflow: end to end with mocked sources returns references, skips the AI write-up, no env reads', async () => {
  const calls = [];
  const out = await runNode(goodBody, { ANTHROPIC_API_KEY: 'x', LIT_CONTACT_EMAIL: 'ops@example.org' }, calls);
  const j = out[0].json;
  assert.ok(calls.some(u => u.includes('api.openalex.org')));
  assert.ok(!calls.some(u => u.includes('api.anthropic.com')), 'no AI call without a key path');
  assert.equal(j.skipped, true);
  assert.equal(j.ok, false);
  const texts = j.references.map(r => r.text).join(' || ');
  assert.match(texts, /Medical visas and demand/);
  assert.match(texts, /Official report on medical tourism/);
  assert.doesNotMatch(texts, /Unvetted report/);          // untrusted report excluded
  assert.equal(j.style, 'mla');
});

test('draft workflow: reports-as-articles from OpenAlex do not bypass the grey gate', async () => {
  const calls = [];
  const out = await runNode({ ...goodBody, filters: JSON.stringify({ includeGrey: false }) }, { ANTHROPIC_API_KEY: 'x' }, calls);
  const texts = out[0].json.references ? out[0].json.references.map(r => r.text).join(' ') : '';
  assert.doesNotMatch(texts, /Official report on medical tourism/);
});
