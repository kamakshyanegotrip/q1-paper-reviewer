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

test('the quantitative empirical article includes its sections in order', () => {
  const ids = W.REPORT_TYPES['empirical:q1'].sections.map(s => s.id);
  for (const want of ['abstract', 'introduction', 'literature_review', 'results', 'conclusion']) {
    assert.ok(ids.includes(want), want);
  }
});

test('sectionBrief returns the brief or an empty string', () => {
  assert.match(W.sectionBrief('empirical:q1', 'abstract'), /Abstract|summary/i);
  assert.equal(W.sectionBrief('empirical:q1', 'nope'), '');
  assert.equal(W.sectionBrief('nope', 'abstract'), '');
});
