// Phase 1 pipeline: records -> filter -> synthesis -> validation -> formatted references -> log.
// Source fetching is done by the caller (n8n or the web app) and passed in as records,
// so the same logic runs in tests and in production.
'use strict';
const { filterSources } = require('./filter');
const { formatReference, resolveStyle } = require('./format');
const { synthesize, sourceKey, buildPrompt } = require('./synthesis');
const { validateCitations } = require('./validate');

async function runLiteratureReview({ question, records, filters, style, llm, maxAttempts }) {
  const chosenStyle = resolveStyle(style);                       // default APA 7
  const { kept, excluded, log } = filterSources(records, filters);
  if (kept.length === 0) {
    return { ok: false, reason: 'No sources passed the filters', log, excluded };
  }
  const syn = await synthesize(question, kept, llm, { maxAttempts });
  const references = kept
    .slice()
    .sort((a, b) => String(a.authors && a.authors[0] ? a.authors[0].family : a.organisation || a.title).localeCompare(String(b.authors && b.authors[0] ? b.authors[0].family : b.organisation || b.title)))
    .map(s => ({ key: sourceKey(s), text: formatReference(s, chosenStyle), tier: s.tierLabel, foundational: !!s.foundational }));
  const labels = {};
  for (const s of kept) {
    const k = sourceKey(s);
    const who = s.isGrey ? (s.organisation || s.title) : (s.authors && s.authors[0] ? s.authors[0].family : s.title);
    const more = !s.isGrey && s.authors && s.authors.length > 1 ? ' et al.' : '';
    labels[k] = `(${who}${more}, ${s.year || 'n.d.'})`;
  }
  return {
    ok: syn.ok,
    skipped: !!syn.skipped,
    labels,
    style: chosenStyle,
    draft: syn.text,
    attempts: syn.attempts,
    unresolvedKeys: syn.unknownKeys || [],
    uncitedSentences: syn.uncited || [],
    references,
    log,
    excluded
  };
}

// Two-step version for n8n: step 1 searches/filters and builds the prompt; the model call is a
// separate node (it needs a stored credential); step 2 checks the reply and formats the result.
function prepareLiterature({ question, records, filters, style }) {
  const chosenStyle = resolveStyle(style);
  const { kept, excluded, log } = filterSources(records, filters);
  if (kept.length === 0) {
    return { early: { ok: false, reason: 'No sources passed the filters', log, excluded } };
  }
  return { early: null, prompt: buildPrompt(question, kept), kept, style: chosenStyle, log, excluded };
}

function finishLiterature({ prep, text, error }) {
  if (prep.early) return prep.early;
  const kept = prep.kept;
  const references = kept.slice()
    .sort((a, b) => String(a.authors && a.authors[0] ? a.authors[0].family : a.organisation || a.title).localeCompare(String(b.authors && b.authors[0] ? b.authors[0].family : b.organisation || b.title)))
    .map(s => ({ key: sourceKey(s), text: formatReference(s, prep.style), tier: s.tierLabel, foundational: !!s.foundational }));
  const labels = {};
  for (const s of kept) {
    const k = sourceKey(s);
    const who = s.isGrey ? (s.organisation || s.title) : (s.authors && s.authors[0] ? s.authors[0].family : s.title);
    const more = !s.isGrey && s.authors && s.authors.length > 1 ? ' et al.' : '';
    labels[k] = `(${who}${more}, ${s.year || 'n.d.'})`;
  }
  const base = { labels, style: prep.style, references, log: prep.log, excluded: prep.excluded, skipped: false };
  if (error || !text) return Object.assign(base, { ok: false, draft: '', reason: 'The AI draft could not be written: ' + (error || 'empty reply') });
  const check = validateCitations(text, kept.map(sourceKey));
  return Object.assign(base, {
    ok: check.ok, draft: text, attempts: 1,
    unresolvedKeys: check.unknownKeys || [], uncitedSentences: check.uncitedSentences || check.uncited || [],
    reason: check.ok ? undefined : 'The draft cited sources that are not in the list; check the citations before use.'
  });
}

module.exports = { runLiteratureReview, prepareLiterature, finishLiterature };
