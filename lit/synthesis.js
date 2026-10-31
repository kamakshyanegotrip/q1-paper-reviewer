// Literature synthesis: the AI writes from kept sources only. The output must pass the
// citation validator; if not, the model is asked again with the offending keys named.
// The LLM call is injected (llm(prompt) -> text) so the logic can be tested offline.
'use strict';
const { validateCitations } = require('./validate');

function sourceKey(s) { return s.doi ? s.doi : ('ty:' + s.title.slice(0, 60)); }

function buildPrompt(question, kept, opts = {}) {
  const list = kept.map(s => {
    const who = s.isGrey ? (s.organisation || 'Organisation') : (s.authors || []).map(a => a.family).join(', ');
    return `- key: ${sourceKey(s)} | ${who} (${s.year || 'n.d.'}) | ${s.title} | ${s.tierLabel}${s.foundational ? ' | foundational' : ''}\n  abstract: ${(s.abstract || '').slice(0, 1200) || '(none provided)'}`;
  }).join('\n');
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
    `Sources:\n${list}`
  ].join('\n');
}

async function synthesize(question, kept, llm, opts = {}) {
  const keys = kept.map(sourceKey);
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
