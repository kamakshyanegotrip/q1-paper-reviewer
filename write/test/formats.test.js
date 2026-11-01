'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../formats');
const types = F.buildTypes();

test('the formats cover the five families and all 30 empirical designs', () => {
  assert.equal(F.FAMILIES.length, 5);
  const designs = Object.keys(types).filter(k => k.startsWith('empirical:'));
  assert.equal(designs.length, 30);
  assert.ok(types['case:descriptive'] && types['review:systematic'] && types['thesis:standard'] && types['book:authored']);
});

test('article types end with an abstract after the body; references come last', () => {
  for (const [key, t] of Object.entries(types)) {
    const ids = t.sections.map(s => s.id);
    assert.equal(ids[ids.length - 1], 'references', key);
    if (t.familyLabel && key.indexOf('thesis') !== 0 && key.indexOf('book') !== 0) {
      assert.ok(ids.includes('abstract'), key);
      assert.equal(t.sections.find(s => s.id === 'abstract').after, 'all', key);
    }
  }
});

test('each body section waits for the one before it; ids are unique', () => {
  for (const [key, t] of Object.entries(types)) {
    const ids = t.sections.map(s => s.id);
    assert.equal(new Set(ids).size, ids.length, key + ' duplicate ids');
    const body = t.sections.filter(s => s.fixed == null);
    body.slice(1).forEach((s, i) => assert.deepEqual(s.after, [body[i].id], key + ' ' + s.id));
  }
});

test('classify gives inputs by section title', () => {
  assert.deepEqual(F.classify('Methods and measures').needs, ['notes']);
  assert.deepEqual(F.classify('Findings with evidence excerpts').needs, ['results']);
  assert.equal(F.classify('Abstract').fixed, 225);
});
