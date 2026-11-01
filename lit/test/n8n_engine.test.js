'use strict';
// Runs the draft n8n workflow's three Code/HTTP steps with mocked n8n globals and HTTP:
// engine (search + filter + prompt) -> Gemini (mocked) -> finish (citation check + references).
const test = require('node:test');
const assert = require('node:assert/strict');
const { workflow } = require('../n8n/build');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const authOk = { authorized: true, role: 'admin', user_id: 1 };
const authNo = { authorized: false, role: '', user_id: null };
const nodes = workflow().nodes;
const engineCode = nodes.find(n => n.name === 'Literature engine').parameters.jsCode;
const finishCode = nodes.find(n => n.name === 'Literature finish').parameters.jsCode;
// Both Code nodes carry the same bundled library; the finish node also needs its own copy in n8n.

function mockHttp(calls) {
  return async (opts) => {
    calls.push(opts.url);
    const u = opts.url;
    if (u.includes('api.openalex.org')) return { results: [
      { doi: 'https://doi.org/10.1/visa', title: 'Medical visas and demand', publication_year: 2021, type: 'article',
        authorships: [{ author: { display_name: 'Ana Lee' } }], primary_location: { source: { display_name: 'Health J' } }, cited_by_count: 40, abstract_inverted_index: { Visa: [0] } },
      { display_name: 'Official report on medical tourism', publication_year: 2023, type: 'report', doi: null,
        authorships: [{ institutions: [{ display_name: 'Ministry of Tourism' }] }], primary_location: { landing_page_url: 'https://tourism.gov.in/r' } },
      { display_name: 'Unvetted report', publication_year: 2023, type: 'report', authorships: [{ institutions: [{ display_name: 'Some Blog' }] }] }
    ] };
    return { results: [], resultList: { result: [] } };
  };
}

// Runs the three steps. `gemini` is the reply the model gives (a function of the prompt, or an error object).
async function runFlow(body, calls, { auth = authOk, gemini = null } = {}) {
  const engineFn = new AsyncFunction('$input', '$helpers', '$env', '$', engineCode);
  const $e = name => ({ first: () => ({ json: name === 'Literature webhook' ? { body } : auth }) });
  const engineOut = (await engineFn({ first: () => ({ json: auth }) }, { httpRequest: mockHttp(calls) }, {}, $e))[0].json;

  // Gemini step: continueOnFail means a failed call reaches the finish step as an error object.
  let geminiOut;
  if (!engineOut.prompt) geminiOut = { error: { message: 'no prompt' } };
  else if (gemini) geminiOut = typeof gemini === 'function' ? gemini(engineOut.prompt) : gemini;
  else geminiOut = { candidates: [{ content: { parts: [{ text: defaultReply(engineOut.prompt) }] } }] };
  if (!engineOut.prompt) calls.push('gemini:skipped');
  else calls.push('gemini');

  const finishFn = new AsyncFunction('$input', '$', finishCode);
  const $f = name => ({ first: () => ({ json: engineOut }) });
  const out = await finishFn({ first: () => ({ json: geminiOut }) }, $f);
  return out[0].json;
}

// A reply that cites the first source key in the prompt, as the model is asked to do.
function defaultReply(prompt) {
  const key = (prompt.match(/key: ([^\s|]+)/) || [])[1];
  return `Visa rules shape demand {{cite:${key}}}.`;
}

const goodBody = {
  key: 'q1k-test', question: 'What does the literature show about medical visas?',
  queries: JSON.stringify(['medical visa demand']), style: 'mla', filters: JSON.stringify({ includeGrey: true })
};

test('flow: refuses requests the checker does not authorise and never calls the model', async () => {
  const calls = [];
  const j = await runFlow(goodBody, calls, { auth: authNo });
  assert.equal(j.ok, false);
  assert.match(j.reason, /Not authorised/);
  assert.ok(!calls.includes('gemini'));
});

test('flow: end to end writes a draft whose citations resolve and keeps trusted grey sources only', async () => {
  const calls = [];
  const j = await runFlow(goodBody, calls);
  assert.equal(j.ok, true, JSON.stringify(j).slice(0, 300));
  assert.ok(calls.includes('gemini'));
  assert.equal(j.skipped, false);
  const texts = j.references.map(r => r.text).join(' || ');
  assert.match(texts, /Medical visas and demand/);
  assert.match(texts, /Official report on medical tourism/);
  assert.doesNotMatch(texts, /Unvetted report/);
  assert.equal(j.style, 'mla');
  const readable = j.draft.replace(/\{\{cite:([^}]+)\}\}/g, (m, k) => j.labels[k] || 'UNRESOLVED');
  assert.doesNotMatch(readable, /UNRESOLVED/);
  assert.match(readable, /\(Lee, 2021\)/);
  assert.deepEqual(j.unresolvedKeys, []);
});

test('flow: reports-as-articles from OpenAlex do not bypass the grey gate', async () => {
  const calls = [];
  const j = await runFlow({ ...goodBody, filters: JSON.stringify({ includeGrey: false }) }, calls);
  const texts = (j.references || []).map(r => r.text).join(' ');
  assert.doesNotMatch(texts, /Official report on medical tourism/);
});

test('flow: a model error still returns the sources, with the reason', async () => {
  const calls = [];
  const j = await runFlow(goodBody, calls, { gemini: { error: { message: 'quota exceeded' } } });
  assert.equal(j.ok, false);
  assert.match(j.reason, /quota exceeded/);
  assert.ok(j.references.length > 0);
});

test('flow: a draft that cites a source not in the list is flagged, not passed as ok', async () => {
  const calls = [];
  const j = await runFlow(goodBody, calls, { gemini: { candidates: [{ content: { parts: [{ text: 'Claim {{cite:made-up-key}}.' }] } }] } });
  assert.equal(j.ok, false);
  assert.deepEqual(j.unresolvedKeys, ['made-up-key']);
});
