// Planning for "Writing from scratch": the outline with word budgets, the dependency rules,
// the readiness check before a section can be written, and the prompt for one section.
// Pure functions, shared by the browser, the Node tests and the n8n section writer.
(function (root) {
  'use strict';
  const T = (typeof require === 'function') ? require('./templates') : root.Q1Write;
  const TOLERANCE = 0.1;
  const INPUT_LABELS = {
    topic: 'Topic and context',
    question: 'Research question',
    notes: 'Data, method and other notes (sample, design, tools, dates)',
    results: 'Results or data (figures, tables, key findings)'
  };

  function sectionsOf(type) { const t = T.REPORT_TYPES[type]; return t ? t.sections : []; }
  function weightedIds(type) { return sectionsOf(type).filter(s => s.fixed == null).map(s => s.id); }

  // The sections a section must wait for, as ids.
  function dependsOn(type, id) {
    const s = sectionsOf(type).find(x => x.id === id);
    if (!s) return [];
    if (s.after === 'all') return weightedIds(type).filter(x => x !== id);
    return (s.after || []).slice();
  }

  // Outline: the word budget for every section, scaled from the target. Fixed sections keep their size.
  // overrides: { sectionId: words } from the user's edits.
  function buildOutline(type, targetWords, overrides = {}) {
    const target = Math.max(0, Math.round(Number(targetWords) || 0));
    const secs = sectionsOf(type);
    const fixedSum = secs.filter(s => s.fixed != null).reduce((a, s) => a + s.fixed, 0);
    const pool = Math.max(0, target - fixedSum);
    const weightSum = secs.filter(s => s.fixed == null).reduce((a, s) => a + s.weight, 0) || 1;
    const sections = secs.map(s => {
      let words = s.fixed != null ? s.fixed : Math.round((pool * s.weight / weightSum) / 10) * 10;
      if (overrides[s.id] != null && overrides[s.id] !== '') words = Math.max(0, Math.round(Number(overrides[s.id]) || 0));
      return { id: s.id, title: s.title, brief: s.brief, words, fixed: s.fixed != null, needs: s.needs.slice(), dependsOn: dependsOn(type, s.id) };
    });
    const total = sections.reduce((a, s) => a + s.words, 0);
    return { sections, total, target, withinTolerance: target > 0 && Math.abs(total - target) <= target * TOLERANCE };
  }

  // What is still missing before this section can be written.
  // drafts: { sectionId: { text } }. project: the saved project details. points: { sectionId: 'text' }.
  function sectionStatus(type, id, project = {}, drafts = {}, points = {}) {
    const s = sectionsOf(type).find(x => x.id === id);
    if (!s) return { state: 'missing', missing: [], blockedBy: [] };
    if (drafts[id] && drafts[id].text) return { state: 'drafted', missing: [], blockedBy: [] };
    const titleOf = x => (sectionsOf(type).find(y => y.id === x) || { title: x }).title;
    const blockedBy = dependsOn(type, id).filter(d => !(drafts[d] && drafts[d].text)).map(titleOf);
    const missing = [];
    if (!String(project.topic || '').trim()) missing.push(INPUT_LABELS.topic);
    if (!String(project.question || '').trim() && s.id !== 'title') missing.push(INPUT_LABELS.question);
    if (!String(points[id] || '').trim()) missing.push('Content points for this section');
    for (const n of s.needs) {
      if (n === 'question') continue;
      if (!String(project[n] || '').trim()) missing.push(INPUT_LABELS[n]);
    }
    if (blockedBy.length) return { state: 'locked', missing, blockedBy };
    if (missing.length) return { state: 'needs_input', missing, blockedBy: [] };
    return { state: 'ready', missing: [], blockedBy: [] };
  }

  const countWords = text => String(text || '').trim().split(/\s+/).filter(Boolean).length;
  // A draft is on budget when it is within the tolerance of the words planned for it.
  function lengthCheck(text, words) {
    const count = countWords(text);
    const low = Math.round(words * (1 - TOLERANCE)), high = Math.round(words * (1 + TOLERANCE));
    return { count, words, ok: words === 0 || (count >= low && count <= high), low, high };
  }

  const clip = (t, n) => { const s = String(t || ''); return s.length > n ? s.slice(0, n) + ' …' : s; };

  // The prompt for one section. sourcesText is the list of kept sources with their citation keys.
  function buildSectionPrompt({ type, section, words, points, project = {}, prior = [], sourcesText = '' }) {
    const t = T.REPORT_TYPES[type] || { label: 'document' };
    const s = sectionsOf(type).find(x => x.id === section) || { title: section, brief: '', needs: [] };
    const pointLines = String(points || '').split('\n').map(x => x.trim()).filter(Boolean);
    const lines = [
      `You are writing one section of an academic ${t.label.toLowerCase()}.`,
      `Section: ${s.title}. Purpose: ${s.brief}`,
      `Working title: ${project.title || '(not given)'}`,
      `Topic and context: ${project.topic || '(not given)'}`,
      `Research question: ${project.question || '(not given)'}`,
      `Aims or objectives: ${project.aims || '(not given)'}`,
      'Rules:',
      '- Use ONLY the sources listed below, and only the results and notes given here. Do not add facts, figures or citations that are not provided.',
      '- If a result or detail needed for this section is missing, write [INSERT: what is missing] at that point instead of inventing it.',
      sourcesText ? '- Cite every factual claim with {{cite:KEY}} using the exact key shown.' : '- Make no citations; no sources were provided for this section.',
      '- Write in formal academic English.',
      `- Length: about ${words} words (no more than 10% above or below).`,
      '- Start with the section title as a heading.',
      'Cover these content points, in this order:',
      ...pointLines.map((p, i) => `${i + 1}. ${p}`)
    ];
    if (s.needs.includes('results') && project.results) lines.push(`Results provided (use only these):\n${project.results}`);
    if (s.needs.includes('notes') && project.notes) lines.push(`Data, method and notes provided:\n${project.notes}`);
    if (prior.length) lines.push('Earlier sections (keep consistent with them):\n' + prior.map(p => `## ${p.title}\n${clip(p.text, 2500)}`).join('\n\n'));
    if (sourcesText) lines.push(`Sources:\n${sourcesText}`);
    return lines.join('\n');
  }

  const api = { buildOutline, dependsOn, sectionStatus, lengthCheck, countWords, buildSectionPrompt, INPUT_LABELS, TOLERANCE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Q1Plan = api;
})(typeof window !== 'undefined' ? window : globalThis);
