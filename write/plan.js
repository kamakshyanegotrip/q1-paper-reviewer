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
  function buildSectionPrompt({ type, section, words, points, project = {}, prior = [], sourcesText = '', hint = '' }) {
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
    if (String(hint || '').trim()) lines.push(`Author's framing hint (build the section around this): ${String(hint).trim()}`);
    if (s.needs.includes('results') && project.results) lines.push(`Results provided (use only these):\n${project.results}`);
    if (s.needs.includes('notes') && project.notes) lines.push(`Data, method and notes provided:\n${project.notes}`);
    if (prior.length) lines.push('Earlier sections (keep consistent with them):\n' + prior.map(p => `## ${p.title}\n${clip(p.text, 2500)}`).join('\n\n'));
    if (sourcesText) lines.push(`Sources:\n${sourcesText}`);
    return lines.join('\n');
  }


  // Ways to revise one paragraph. Each needs a modification type, so the change has a purpose.
  const REVISE_MODES = {
    connect: 'Rewrite the paragraph so it follows smoothly from the previous paragraph: link ideas, carry over terms, and remove repetition. Keep its claims.',
    discuss: 'Revise the paragraph as the author instructs below. Change only what the instruction asks for.',
    cite: 'Add more content and literature to the paragraph. Use the sources listed, citing each new claim with {{cite:KEY}}, and keep the existing claims.'
  };
  const MODIFICATIONS = {
    argumentative: 'Make the argument explicit: a clear claim, the reasons for it, and the counter-argument answered.',
    discussion: 'Make it discussion-based: interpret the evidence, compare it with the literature, and say what it means.',
    analytical: 'Make it analytical: break the point into its parts, examine how they relate, and show the mechanism.',
    theory: 'Make it theory-based: align the point with the named theory or framework and show what the theory explains.'
  };

  // The prompt to revise one paragraph. mode is connect, discuss or cite; modification is a key of MODIFICATIONS.
  function buildRevisePrompt({ type, section, paragraph, previous = '', mode, modification, instruction = '', sourcesText = '', style = '', project = {} }) {
    if (!REVISE_MODES[mode]) throw new Error('Unknown revision mode');
    if (!MODIFICATIONS[modification]) throw new Error('Choose a modification type first');
    const s = sectionsOf(type).find(x => x.id === section) || { title: section };
    const words = countWords(paragraph);
    const target = mode === 'cite' ? Math.max(40, Math.round(words * 1.6)) : words;
    const lines = [
      `You are revising one paragraph of the "${s.title}" section of an academic document.`,
      `Research question: ${project.question || '(not given)'}`,
      `Task: ${REVISE_MODES[mode]}`,
      `Type of change: ${MODIFICATIONS[modification]}`,
      'Rules:',
      '- Return only the revised paragraph, with no heading and no commentary.',
      '- Do not invent facts, figures or citations. Use only the sources listed below.',
      sourcesText ? '- Keep every {{cite:KEY}} citation that is still relevant, using the exact key shown.' : '- Make no citations; no sources were provided.',
      `- Length: about ${target} words.`,
      '- Write in formal academic English.'
    ];
    const markers = [...new Set(String(paragraph).match(/\{\{cite:[^}]*\}\}/g) || [])];
    if (markers.length) lines.push(`- Keep these citation markers exactly as written, in the same place in the text, and do not remove or change them: ${markers.join(' ')}`);
    if (mode === 'connect' && previous) lines.push(`Previous paragraph (connect to it):\n${previous}`);
    if (mode === 'discuss') lines.push(`Author's instruction: ${String(instruction || '').trim() || '(none given)'}`);
    lines.push(`Paragraph to revise:\n${paragraph}`);
    if (sourcesText) lines.push(`Sources:\n${sourcesText}`);
    if (style) lines.push(`Citation style: ${style}`);
    return lines.join('\n');
  }


  // Words for each paragraph of a section: the section budget split evenly, rounded to 10.
  function paragraphBudgets(words, count) {
    const n = Math.max(1, Math.round(Number(count) || 0));
    const each = Math.max(10, Math.round((Number(words) || 0) / n / 10) * 10);
    return Array.from({ length: n }, () => each);
  }

  // The outline of a section: one paragraph per content point, with its word count.
  function outlineOf(points, words) {
    const items = String(points || '').split('\n').map(x => x.trim()).filter(Boolean);
    const budgets = paragraphBudgets(words, items.length);
    return items.map((point, i) => ({ index: i, point, words: budgets[i] }));
  }

  // The prompt for one paragraph of a section, covering one outline point. prior is the paragraphs before it.
  function buildParagraphPrompt({ type, section, point, words, prior = [], hint = '', sourcesText = '', style = '', project = {}, position = 1, total = 1 }) {
    const t = T.REPORT_TYPES[type] || { label: 'document' };
    const s = sectionsOf(type).find(x => x.id === section) || { title: section, brief: '', needs: [] };
    const lines = [
      `You are writing paragraph ${position} of ${total} in the "${s.title}" section of an academic ${t.label.toLowerCase()}.`,
      `Section purpose: ${s.brief}`,
      `Research question: ${project.question || '(not given)'}`,
      `Topic and context: ${project.topic || '(not given)'}`,
      `This paragraph covers only this point: ${point}`,
      'Rules:',
      '- Write one paragraph only. Do not add a heading, a list or commentary.',
      '- Cover only this point. Do not repeat what the earlier paragraphs say.',
      '- Use ONLY the sources listed below, and only the results and notes given here. Do not invent facts or figures.',
      '- If a detail needed for this point is missing, write [INSERT: what is missing] at that point.',
      sourcesText ? '- Cite every factual claim with {{cite:KEY}} using the exact key shown.' : '- Make no citations; no sources were provided.',
      '- Write in formal academic English.',
      `- Length: about ${words} words (no more than 10% above or below).`
    ];
    if (String(hint || '').trim()) lines.push(`Author's framing hint: ${String(hint).trim()}`);
    if (s.needs.includes('results') && project.results) lines.push(`Results provided (use only these):\n${project.results}`);
    if (s.needs.includes('notes') && project.notes) lines.push(`Data, method and notes provided:\n${project.notes}`);
    if (prior.length) lines.push('Paragraphs already written in this section (follow on from them, do not repeat them):\n' + prior.map(x => clip(x, 1500)).join('\n\n'));
    if (sourcesText) lines.push(`Sources:\n${sourcesText}`);
    if (style) lines.push(`Citation style: ${style}`);
    return lines.join('\n');
  }

  // The prompt that rewrites the source article into one section of the target format.
  // The target format's section list is given so the section fits the whole document.
  // Writing approaches the user can pick for a transform or update.
  const APPROACH_BRIEF = {
    informative: 'Informative. Explain the facts, evidence and context clearly and neutrally; report what the sources show without arguing a position.',
    analytical: 'Analytical. Break the topic into its parts, examine how they relate, compare the evidence, and explain causes and implications.',
    argumentative: 'Argumentative. State a clear thesis, build the case with evidence from the source and the new literature, and address the strongest counter-arguments.',
    descriptive: 'Descriptive. Set out what, who, where and how in organised detail, without interpretation beyond the sources.',
    detailed: 'Detailed. Expand each point with fuller explanation, examples, figures and supporting evidence, without padding.'
  };
  const TRANSFORM_STYLE_LABEL = { apa7: 'APA 7', harvard: 'Harvard', vancouver: 'Vancouver', chicago: 'Chicago', ieee: 'IEEE', mla: 'MLA' };
  function buildTransformPrompt({ type, section, words, source, prior = [], sourcesText = '', project = {}, existing = '', instruction = '', approach = '', style = '' }) {
    const t = T.REPORT_TYPES[type] || { label: 'document', sections: [] };
    const s = sectionsOf(type).find(x => x.id === section) || { title: section, brief: '' };
    const plan = sectionsOf(type).filter(x => x.id !== 'references').map(x => `- ${x.title}${x.fixed != null ? ' (fixed length)' : ''}`).join('\n');
    const lines = [
      `You are transforming an existing academic article into a ${t.label.toLowerCase()}.`,
      `Target section: ${s.title}. Purpose: ${s.brief}`,
      `Target document structure, in order:\n${plan}`,
      `Working title: ${project.title || '(keep the source title)'}`,
      'Rules:',
      '- Use the source article below as the basis: keep its claims, evidence and figures. Do not invent facts or figures.',
      '- Re-organise the source material into this section only, as the target structure requires. Material that belongs to another section is left out here.',
      sourcesText ? '- Where the sources listed below are relevant, integrate them and cite each new claim with {{cite:KEY}} using the exact key shown, copied as it is listed (for example a DOI), never an author name or year. Keep existing claims that remain valid. Cite a listed source only where it directly supports the sentence it follows. Leave a sentence uncited when no listed source supports it, and do not repeat the same citation in paragraph after paragraph.' : '',
      '- Keep every in-text citation the source article already contains (for example (Lee, 2024), [3] or a superscript number) in the same place in the sentence it supports. Do not drop, merge or rephrase a citation away. Write each one in the ' + (TRANSFORM_STYLE_LABEL[style] || 'chosen') + ' style.',
      sourcesText ? '' : '- Add no new citations: no new sources were listed. Write no {{cite:…}} markers.',
      instruction && String(existing).trim() ? '' : `- Length: about ${words} words (no more than 10% above or below).`,
      '- Start with the section title as a heading. Separate paragraphs with a blank line.',
      '- Use markdown: "#" for the chapter or section title, "##" for its subsections, "###" for sub-subsections. Use "**bold**" and "*italic*" only where the source uses them.',
      '- Tables: keep every table as a markdown pipe table (a header row, a separator row, then one row per line). Put its caption on the line directly above it, in the form "Table N: title", with the original number and title. Never turn table cells into plain lines.',
      '- Figures: keep the caption on its own line, in the form "Figure N: title", with the original number and title.',
      '- Present every table as a markdown table: a header row of "|"-separated column names, a separator row such as "|---|---|", then one row per data line. Put a caption line directly above each table in the form "Table N: title", and write the table number and title in bold.',
      '- Write in formal academic English.'
    ];
    if (APPROACH_BRIEF[approach]) lines.push('Writing approach: ' + APPROACH_BRIEF[approach]);
    if (instruction && String(existing).trim()) {
      lines.push(`Revise the section below as instructed: ${String(instruction).slice(0, 1000)}`);
      lines.push('Keep every existing paragraph and citation marker. For each listed source, write at least one NEW paragraph of two to four sentences that states the finding or argument that source reports, and cite that source inside that paragraph as {{cite:KEY}} using its exact key from the Sources list. Insert each new paragraph where it fits the section. Do not reword the existing paragraphs to add citations to them. Use at most two citations per sentence and never cite a source whose author is missing or is a title. Do not invent citations or keys. Output the complete revised section only.');
      if (sourcesText) lines.push(`Sources to add (each needs a new paragraph):\n${sourcesText}`);
      lines.push(`Section to revise (about ${countWords(existing)} words now). Keep its length as the new sources require; there is no word limit for an update.\n${clip(String(existing), 30000)}`);
    } else if (existing && String(existing).trim()) {
      lines.push(`The section below is already written but is about ${countWords(existing)} words short of the target. Continue it: write about ${words} more words that extend the section with material from the source that is not yet covered. Do not repeat what is written, do not restart the title, and do not write a conclusion for the whole document. Output only the new text.`);
      lines.push(`Section written so far:\n${clip(String(existing), 30000)}`);
    }
    if (!(instruction && String(existing).trim())) lines.push(`Source article:\n${String(source || '').slice(0, 200000)}`);
    if (prior.length) lines.push('Sections already transformed (keep consistent with them):\n' + prior.map(p => `## ${p.title}\n${clip(p.text, 2500)}`).join('\n\n'));
    if (sourcesText && !(instruction && String(existing).trim())) lines.push(`Sources:\n${sourcesText}`);
    return lines.filter(x => x !== '').join('\n');
  }

  // One short paragraph that states what a set of sources report together, for the section. The app adds it to the section.
  function buildSetParagraphPrompt({ section, sourcesText = '', existing = '', instruction = '', project = {} }) {
    const lines = [
      'You write one new paragraph for an academic document. The app adds it to the section below.',
      'Document: ' + (project.title || '(not given)'),
      'Section: ' + section + '. ' + String(instruction || '').slice(0, 500),
      'Write ONE paragraph of three to five sentences. It states what the listed sources report together, on the topic of this section, in the same style as the section.',
      'Cite each listed source in the paragraph as {{cite:S1}}, {{cite:S2}} and so on, using the label of the source from the Sources list. Cite no other source. Use at most two citations per sentence.',
      'Output only that paragraph. Do not output the section, a heading, a list or commentary. Do not invent facts, citations or keys.',
      sourcesText ? 'Sources:\n' + sourcesText : 'Sources: none listed.',
      'Section for context only (do not repeat it):\n' + clip(String(existing), 20000)
    ];
    return lines.join('\n');
  }
  const api = { APPROACH_BRIEF, buildTransformPrompt, buildSetParagraphPrompt, buildOutline, dependsOn, sectionStatus, lengthCheck, countWords, buildSectionPrompt, buildRevisePrompt, paragraphBudgets, outlineOf, buildParagraphPrompt, REVISE_MODES, MODIFICATIONS, INPUT_LABELS, TOLERANCE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Q1Plan = api;
})(typeof window !== 'undefined' ? window : globalThis);
