'use strict';
// The user's expected length and outline headings reach the prompt; without them the default rule is kept.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPrompt } = require('../synthesis');

const kept = [{ doi: '10.1/x', title: 'A study', year: 2022, authors: [{ family: 'Lee' }], tierLabel: 'peer-reviewed', abstract: 'Text.' }];

test('default prompt keeps the 1,200 to 1,800 word rule and theme headings', () => {
  const p = buildPrompt('Q?', kept);
  assert.match(p, /Length: about 1,200 to 1,800 words\./);
  assert.match(p, /organise under headings by theme/);
});

test('user length replaces the default length', () => {
  const p = buildPrompt('Q?', kept, { length: '2,500 to 3,500 words' });
  assert.match(p, /Length: about 2,500 to 3,500 words\./);
  assert.doesNotMatch(p, /1,200 to 1,800/);
});

test('outline headings are written as numbered sections in order', () => {
  const p = buildPrompt('Q?', kept, { outline: ['Clinical readiness', '', 'Regulatory governance'] });
  assert.match(p, /1\. Clinical readiness\n\s+2\. Regulatory governance/);
  assert.doesNotMatch(p, /organise under headings by theme/);
  assert.match(p, /Gaps in the evidence/);
});

test('outline is capped at 12 items', () => {
  const items = Array.from({ length: 20 }, (_, i) => 'Heading ' + (i + 1));
  const p = buildPrompt('Q?', kept, { outline: items });
  assert.match(p, /12\. Heading 12/);
  assert.doesNotMatch(p, /Heading 13/);
});
