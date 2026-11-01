'use strict';
// The section writer's n8n steps (engine -> Gemini -> finish), run with mocked n8n globals and HTTP.
const test = require('node:test');
const assert = require('node:assert/strict');
const { writeWorkflow } = require('../n8n/build');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const nodes = writeWorkflow().nodes;
const engineCode = nodes.find(n => n.name === 'Write engine').parameters.jsCode;
const finishCode = nodes.find(n => n.name === 'Write finish').parameters.jsCode;
const authOk = { authorized: true, role: 'admin' };
const authNo = { authorized: false };

function mockHttp(calls) {
  return async (opts) => {
    calls.push(opts.url);
    if (opts.url.includes('api.openalex.org')) return { results: [
      { doi: 'https://doi.org/10.1/visa', title: 'Medical visas and demand', publication_year: 2021, type: 'article',
        authorships: [{ author: { display_name: 'Ana Lee' } }], primary_location: { source: { display_name: 'Health J' } }, cited_by_count: 40, abstract_inverted_index: { Visa: [0] } }
    ] };
    return { results: [], resultList: { result: [] } };
  };
}

async function runWriter(body, { auth = authOk, gemini, calls = [] } = {}) {
  const engineFn = new AsyncFunction('$input', '$helpers', '$env', '$', engineCode);
  const $e = name => ({ first: () => ({ json: name === 'Write webhook' ? { body } : auth }) });
  const engineOut = (await engineFn({ first: () => ({ json: auth }) }, { httpRequest: mockHttp(calls) }, {}, $e))[0].json;
  let geminiOut;
  if (!engineOut.prompt) geminiOut = { error: { message: 'no prompt' } };
  else if (typeof gemini === 'function') geminiOut = gemini(engineOut.prompt);
  else geminiOut = { candidates: [{ content: { parts: [{ text: gemini || 'Visa rules shape demand {{cite:' + ((engineOut.prompt.match(/key: ([^\s|]+)/) || [])[1]) + '}}.' }] } }] };
  const finishFn = new AsyncFunction('$input', '$', finishCode);
  const out = await finishFn({ first: () => ({ json: geminiOut }) }, name => ({ first: () => ({ json: engineOut }) }));
  return { engine: engineOut, out: out[0].json };
}

const base = {
  key: 'q1k-test', type: 'empirical:q1', section: 'literature_review', words: 870, style: 'apa7',
  project: JSON.stringify({ topic: 'Medical visas', question: 'What drives medical visa demand?', notes: '', results: '' }),
  prior: JSON.stringify([{ title: 'Introduction', text: 'Earlier text' }]),
  points: 'Visa rules and demand\nPrice sensitivity'
};

test('refuses unauthorised requests without calling the model', async () => {
  const calls = [];
  const r = await runWriter(base, { auth: authNo, calls });
  assert.equal(r.out.ok, false);
  assert.match(r.out.reason, /Not authorised/);
  assert.ok(!calls.some(c => c.includes('openalex')));
});

test('a body section searches sources, writes with the budget and resolves citations', async () => {
  const calls = [];
  const r = await runWriter(base, { calls });
  assert.equal(r.out.ok, true, JSON.stringify(r.out).slice(0, 300));
  assert.match(r.engine.prompt, /about 870 words/);
  assert.match(r.engine.prompt, /Visa rules and demand/);
  assert.match(r.engine.prompt, /Earlier text/);
  assert.match(r.engine.prompt, /key: 10\.1\/visa/);
  assert.ok(calls.some(c => c.includes('api.openalex.org')));
  assert.deepEqual(r.out.unresolvedKeys, []);
  assert.match(r.out.text, /Visa rules shape demand/);
  assert.ok(r.out.words > 0);
});

test('a fixed section (abstract) is written without a source search', async () => {
  const calls = [];
  const r = await runWriter({ ...base, section: 'abstract', words: 225 }, { calls, gemini: 'Background, aim, method and findings in 225 words.' });
  assert.equal(r.out.ok, true);
  assert.ok(!calls.some(c => c.includes('api.openalex.org')));
  assert.match(r.engine.prompt, /Make no citations/);
});

test('refuses a section with no content points', async () => {
  const r = await runWriter({ ...base, points: '   ' });
  assert.equal(r.out.ok, false);
  assert.match(r.out.reason, /content points/);
});

test('an unknown section is refused', async () => {
  const r = await runWriter({ ...base, section: 'nope' });
  assert.equal(r.out.ok, false);
  assert.match(r.out.reason, /Unknown report type or section/);
});

test('a failed model call returns ok false with the reason', async () => {
  const r = await runWriter(base, { gemini: () => ({ error: { message: 'quota exceeded' } }) });
  assert.equal(r.out.ok, false);
  assert.match(r.out.reason, /quota exceeded/);
});

test('a connect revision is rewritten from the previous paragraph without a search', async () => {
  const calls = [];
  const r = await runWriter({ ...base, action: 'revise', mode: 'connect', modification: 'analytical', paragraph: 'Visa rules shape demand.', previous: 'Earlier paragraph.' },
    { calls, gemini: 'Building on that, visa rules shape demand.' });
  assert.equal(r.out.ok, true, JSON.stringify(r.out).slice(0, 300));
  assert.match(r.engine.prompt, /Previous paragraph[\s\S]*Earlier paragraph/);
  assert.ok(!calls.some(c => c.includes('api.openalex.org')));
});

test('an add-content revision searches the literature and cites the new sources', async () => {
  const calls = [];
  const r = await runWriter({ ...base, action: 'revise', mode: 'cite', modification: 'theory', paragraph: 'Visa rules shape demand.' }, { calls });
  assert.equal(r.out.ok, true, JSON.stringify(r.out).slice(0, 300));
  assert.ok(calls.some(c => c.includes('api.openalex.org')));
  assert.match(r.engine.prompt, /key: 10\.1\/visa/);
});

test('a revision without a modification type is refused', async () => {
  const r = await runWriter({ ...base, action: 'revise', mode: 'connect', modification: '', paragraph: 'Text.' });
  assert.equal(r.out.ok, false);
  assert.match(r.out.reason, /modification type/);
});

test('the section hint is used in the section prompt', async () => {
  const r = await runWriter({ ...base, hint: 'Bone marrow disease causes' });
  assert.equal(r.out.ok, true);
  assert.match(r.engine.prompt, /Bone marrow disease causes/);
});

test('a paragraph covers one outline point, follows the paragraphs before it, and searches', async () => {
  const calls = [];
  const r = await runWriter({ ...base, action: 'paragraph', point: 'Visa rules and demand', words: 200, position: 2, total: 3, priorParagraphs: 'First paragraph text.' },
    { calls, gemini: 'Visa rules shape demand {{cite:' + 'x' + '}}.' });
  assert.equal(r.out.ok, true, JSON.stringify(r.out).slice(0, 300));
  assert.match(r.engine.prompt, /paragraph 2 of 3/);
  assert.match(r.engine.prompt, /First paragraph text/);
  assert.match(r.engine.prompt, /about 200 words/);
  assert.ok(calls.some(c => c.includes('api.openalex.org')));
});

test('a paragraph request without its outline point is refused', async () => {
  const r = await runWriter({ ...base, action: 'paragraph', point: '' });
  assert.equal(r.out.ok, false);
  assert.match(r.out.reason, /outline point/);
});
