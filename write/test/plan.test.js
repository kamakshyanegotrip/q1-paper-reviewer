'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../plan');
const W = require('../templates');

const project = { topic: 'Medical tourism in Odisha', question: 'What drives demand?', notes: 'Survey of 300 patients', results: 'Mean score 3.8 (SD 0.6)' };
const points = { literature_review: 'Demand drivers\nPrice sensitivity', findings: 'Scores by group', methodology: 'Design' };

test('book is a report type with its own sections', () => {
  assert.ok(W.REPORT_TYPES.book);
  assert.ok(W.REPORT_TYPES.book.sections.some(s => s.id === 'preface'));
});

test('outline budgets add up to the target within tolerance', () => {
  for (const type of Object.keys(W.REPORT_TYPES)) {
    const o = P.buildOutline(type, 6000);
    assert.ok(o.withinTolerance, type + ' total ' + o.total);
    assert.equal(o.target, 6000);
  }
});

test('fixed sections keep their size and the abstract is a fixed budget', () => {
  const o = P.buildOutline('scientific', 6000);
  assert.equal(o.sections.find(s => s.id === 'abstract').words, 225);
});

test('user overrides are used and can move the total out of tolerance', () => {
  const o = P.buildOutline('scientific', 6000, { introduction: 3000 });
  assert.equal(o.sections.find(s => s.id === 'introduction').words, 3000);
  assert.equal(o.withinTolerance, false);
});

test('abstract waits for every body section', () => {
  const deps = P.dependsOn('scientific', 'abstract');
  assert.ok(deps.includes('findings') && deps.includes('conclusion') && deps.includes('literature_review'));
  assert.equal(P.sectionStatus('scientific', 'abstract', project, {}, points).state, 'locked');
});

test('a section unlocks when its prerequisite is drafted', () => {
  const drafts = { introduction: { text: 'Intro text' } };
  assert.equal(P.sectionStatus('scientific', 'literature_review', project, {}, points).state, 'locked');
  assert.equal(P.sectionStatus('scientific', 'literature_review', project, drafts, points).state, 'ready');
});

test('a section needs its content points and the data it uses', () => {
  const noPoints = P.sectionStatus('scientific', 'literature_review', project, { introduction: { text: 'x' } }, {});
  assert.equal(noPoints.state, 'needs_input');
  assert.ok(noPoints.missing.includes('Content points for this section'));

  const noResults = P.sectionStatus('scientific', 'findings', { topic: 't', question: 'q' }, { data_analysis: { text: 'x' } }, points);
  assert.equal(noResults.state, 'needs_input');
  assert.ok(noResults.missing.some(m => /Results or data/.test(m)));
});

test('project basics are required before any section is ready', () => {
  const s = P.sectionStatus('scientific', 'introduction', {}, {}, { introduction: 'Context' });
  assert.equal(s.state, 'needs_input');
  assert.ok(s.missing.includes(P.INPUT_LABELS.topic));
});

test('drafted sections are reported as drafted', () => {
  assert.equal(P.sectionStatus('scientific', 'introduction', project, { introduction: { text: 'x' } }, points).state, 'drafted');
});

test('length check accepts text within 10% of the budget', () => {
  const words = Array(1000).fill('word').join(' ');
  assert.equal(P.lengthCheck(words, 1000).ok, true);
  assert.equal(P.lengthCheck(words, 2000).ok, false);
});

test('section prompt carries the budget, points, data and earlier text', () => {
  const p = P.buildSectionPrompt({
    type: 'scientific', section: 'findings', words: 870, points: 'Scores by group\nGender gap',
    project, prior: [{ title: 'Methodology', text: 'Design text' }], sourcesText: '- key: 10.1/x | Lee (2020) | Title'
  });
  assert.match(p, /about 870 words/);
  assert.match(p, /1\. Scores by group\n2\. Gender gap/);
  assert.match(p, /Results provided \(use only these\)/);
  assert.match(p, /Design text/);
  assert.match(p, /\{\{cite:KEY\}\}/);
  assert.match(p, /\[INSERT: what is missing\]/);
});

test('without sources the prompt asks for no citations', () => {
  const p = P.buildSectionPrompt({ type: 'scientific', section: 'findings', words: 100, points: 'x', project, prior: [] });
  assert.doesNotMatch(p, /\{\{cite:KEY\}\}/);
  assert.match(p, /Make no citations/);
});
