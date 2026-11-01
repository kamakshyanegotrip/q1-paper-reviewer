'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../templates');

test('every report type has sections with unique ids and a brief', () => {
  for (const [k, t] of Object.entries(W.REPORT_TYPES)) {
    assert.ok(t.label, k);
    assert.ok(t.sections.length >= 5, k);
    const ids = t.sections.map(s => s.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate id in ' + k);
    for (const s of t.sections) assert.ok(s.title && s.brief, k + ':' + s.id);
  }
});

test('the scientific paper includes the sections the author asked for', () => {
  const ids = W.REPORT_TYPES.scientific.sections.map(s => s.id);
  for (const want of ['abstract', 'introduction', 'literature_review', 'research_gap', 'methodology', 'data_analysis', 'findings', 'discussion', 'implications', 'conclusion', 'contribution']) {
    assert.ok(ids.includes(want), want);
  }
});

test('sectionBrief returns the brief or an empty string', () => {
  assert.match(W.sectionBrief('scientific', 'abstract'), /Abstract|summary/i);
  assert.equal(W.sectionBrief('scientific', 'nope'), '');
  assert.equal(W.sectionBrief('nope', 'abstract'), '');
});
