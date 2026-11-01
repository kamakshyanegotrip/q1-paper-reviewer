'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../plan');
const W = require('../templates');

const project = { topic: 'Medical tourism in Odisha', question: 'What drives demand?', notes: 'Survey of 300 patients', results: 'Mean score 3.8 (SD 0.6)' };
const points = { literature_review: 'Demand drivers\nPrice sensitivity', findings: 'Scores by group', methodology: 'Design' };

test('book is a report type with its own sections', () => {
  assert.ok(W.REPORT_TYPES['book:authored']);
  assert.ok(W.REPORT_TYPES['book:authored'].sections.some(s => s.id === 'preface'));
});

test('outline budgets add up to the target within tolerance', () => {
  for (const type of Object.keys(W.REPORT_TYPES)) {
    const o = P.buildOutline(type, 6000);
    assert.ok(o.withinTolerance, type + ' total ' + o.total);
    assert.equal(o.target, 6000);
  }
});

test('fixed sections keep their size and the abstract is a fixed budget', () => {
  const o = P.buildOutline('empirical:q1', 6000);
  assert.equal(o.sections.find(s => s.id === 'abstract').words, 225);
});

test('user overrides are used and can move the total out of tolerance', () => {
  const o = P.buildOutline('empirical:q1', 6000, { introduction: 3000 });
  assert.equal(o.sections.find(s => s.id === 'introduction').words, 3000);
  assert.equal(o.withinTolerance, false);
});

test('abstract waits for every body section', () => {
  const deps = P.dependsOn('empirical:q1', 'abstract');
  assert.ok(deps.includes('results') && deps.includes('conclusion') && deps.includes('literature_review'));
  assert.equal(P.sectionStatus('empirical:q1', 'abstract', project, {}, points).state, 'locked');
});

test('a section unlocks when its prerequisite is drafted', () => {
  const drafts = { introduction: { text: 'Intro text' } };
  assert.equal(P.sectionStatus('empirical:q1', 'literature_review', project, {}, points).state, 'locked');
  assert.equal(P.sectionStatus('empirical:q1', 'literature_review', project, drafts, points).state, 'ready');
});

test('a section needs its content points and the data it uses', () => {
  const noPoints = P.sectionStatus('empirical:q1', 'literature_review', project, { introduction: { text: 'x' } }, {});
  assert.equal(noPoints.state, 'needs_input');
  assert.ok(noPoints.missing.includes('Content points for this section'));

  const earlier = {};
  for (const id of ['introduction', 'literature_review', 'research_design', 'measures', 'data_quality']) earlier[id] = { text: 'x' };
  const noResults = P.sectionStatus('empirical:q1', 'results', { topic: 't', question: 'q' }, earlier, points);
  assert.equal(noResults.state, 'needs_input');
  assert.ok(noResults.missing.some(m => /Results or data/.test(m)));
});

test('project basics are required before any section is ready', () => {
  const s = P.sectionStatus('empirical:q1', 'introduction', {}, {}, { introduction: 'Context' });
  assert.equal(s.state, 'needs_input');
  assert.ok(s.missing.includes(P.INPUT_LABELS.topic));
});

test('drafted sections are reported as drafted', () => {
  assert.equal(P.sectionStatus('empirical:q1', 'introduction', project, { introduction: { text: 'x' } }, points).state, 'drafted');
});

test('length check accepts text within 10% of the budget', () => {
  const words = Array(1000).fill('word').join(' ');
  assert.equal(P.lengthCheck(words, 1000).ok, true);
  assert.equal(P.lengthCheck(words, 2000).ok, false);
});

test('section prompt carries the budget, points, data and earlier text', () => {
  const p = P.buildSectionPrompt({
    type: 'empirical:q1', section: 'results', words: 870, points: 'Scores by group\nGender gap',
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
  const p = P.buildSectionPrompt({ type: 'empirical:q1', section: 'results', words: 100, points: 'x', project, prior: [] });
  assert.doesNotMatch(p, /\{\{cite:KEY\}\}/);
  assert.match(p, /Make no citations/);
});

test('a hint is added to the section prompt when given', () => {
  const p = P.buildSectionPrompt({ type: 'empirical:q1', section: 'introduction', words: 300, points: 'Causes', project: {}, prior: [], hint: 'Bone marrow disease causes' });
  assert.match(p, /framing hint.*Bone marrow disease causes/);
});

test('a revision needs a modification type and a known mode', () => {
  const base = { type: 'empirical:q1', section: 'results', paragraph: 'Scores rose.', mode: 'connect' };
  assert.throws(() => P.buildRevisePrompt(Object.assign({}, base, { modification: '' })), /modification type/);
  assert.throws(() => P.buildRevisePrompt(Object.assign({}, base, { mode: 'rewrite', modification: 'analytical' })), /mode/);
});

test('connect uses the previous paragraph; discuss uses the instruction; cite adds length', () => {
  const connect = P.buildRevisePrompt({ type: 'empirical:q1', section: 'results', paragraph: 'Scores rose.', previous: 'Earlier text.', mode: 'connect', modification: 'analytical' });
  assert.match(connect, /Previous paragraph[\s\S]*Earlier text/);
  const discuss = P.buildRevisePrompt({ type: 'empirical:q1', section: 'results', paragraph: 'Scores rose.', mode: 'discuss', modification: 'argumentative', instruction: 'Argue the rise is seasonal' });
  assert.match(discuss, /Argue the rise is seasonal/);
  const cite = P.buildRevisePrompt({ type: 'empirical:q1', section: 'results', paragraph: Array(100).fill('w').join(' '), mode: 'cite', modification: 'theory', sourcesText: '[K1] Source' });
  assert.match(cite, /about 160 words/);
  assert.match(cite, /\{\{cite:KEY\}\}/);
});

test('the outline gives one paragraph per content point, with words split evenly', () => {
  const o = P.outlineOf('Background\nProblem\nAim', 900);
  assert.equal(o.length, 3);
  assert.deepEqual(o.map(x => x.point), ['Background', 'Problem', 'Aim']);
  assert.deepEqual(o.map(x => x.words), [300, 300, 300]);
  assert.deepEqual(P.outlineOf('', 900), []);
});

test('a paragraph prompt covers one point and follows the earlier paragraphs', () => {
  const p = P.buildParagraphPrompt({ type: 'empirical:q1', section: 'introduction', point: 'Cost of care abroad', words: 200, prior: ['First paragraph text.'], position: 2, total: 3 });
  assert.match(p, /paragraph 2 of 3/);
  assert.match(p, /covers only this point: Cost of care abroad/);
  assert.match(p, /First paragraph text/);
  assert.match(p, /about 200 words/);
});
