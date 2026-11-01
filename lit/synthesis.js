// Literature synthesis: the AI writes from kept sources only. The output must pass the
// citation validator; if not, the model is asked again with the offending keys named.
// The LLM call is injected (llm(prompt) -> text) so the logic can be tested offline.
'use strict';
const { validateCitations } = require('./validate');

function sourceKey(s) { return s.doi ? s.doi : ('ty:' + s.title.slice(0, 60)); }

const DEFAULT_LENGTH = '1,200 to 1,800 words';
const MAX_OUTLINE = 12;

// opts.length: the expected length as the user wrote it (e.g. "2,500 to 3,500 words").
// opts.outline: optional list of headings or points; when given, one section is written per item, in order.
function buildPrompt(question, kept, opts = {}) {
  const list = kept.map(s => {
    const who = s.isGrey ? (s.organisation || 'Organisation') : (s.authors || []).map(a => a.family).join(', ');
    return `- key: ${sourceKey(s)} | ${who} (${s.year || 'n.d.'}) | ${s.title} | ${s.tierLabel}${s.foundational ? ' | foundational' : ''}\n  abstract: ${(s.abstract || '').slice(0, 1200) || '(none provided)'}`;
  }).join('\n');
  const length = (opts.length || '').trim() || DEFAULT_LENGTH;
  const outline = (opts.outline || []).map(s => String(s).trim()).filter(Boolean).slice(0, MAX_OUTLINE);
  const structure = outline.length
    ? [
        '- Structure: write one section for each heading below, in this order, using the heading as the section title. Keep every section on its own topic.',
        ...outline.map((h, i) => `  ${i + 1}. ${h}`),
        '- End with a short "Gaps in the evidence" section.'
      ]
    : ['- Structure: organise under headings by theme, with a short gaps section at the end.'];
  return [
    'You are writing a literature review section for an academic paper.',
    `Research question: ${question}`,
    'Rules:',
    '- Use ONLY the sources listed below. Do not add any other source or fact that is not in them.',
    '- Cite every factual sentence with {{cite:KEY}} using the exact key shown.',
    '- Separate peer-reviewed from grey literature when they support different claims.',
    '- If the sources do not cover a point, say so under a heading "Gaps in the evidence" instead of guessing.',
    '- Do not invent statistics, dates, or policy details.',
    '- Write in formal academic English.',
    `- Length: about ${length}.`,
    ...structure,
    `Sources:\n${list}`
  ].join('\n');
}

async function synthesize(question, kept, llm, opts = {}) {
  const keys = kept.map(sourceKey);
  if (typeof llm !== 'function') return { ok: false, skipped: true, text: '', attempts: 0 };
  const maxAttempts = opts.maxAttempts || 3;
  let prompt = buildPrompt(question, kept, opts);
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const text = await llm(prompt);
    const check = validateCitations(text, keys);
    last = { text, check, attempts: attempt };
    if (check.ok) return { ok: true, text, attempts: attempt, uncited: check.uncitedSentences };
    prompt = prompt + `\n\nYour previous draft cited keys that are not in the source list: ${check.unknownKeys.join(', ')}. Rewrite it using only the listed keys.`;
  }
  return { ok: false, text: last.text, attempts: maxAttempts, unknownKeys: last.check.unknownKeys, uncited: last.check.uncitedSentences };
}

module.exports = { buildPrompt, synthesize, sourceKey };
