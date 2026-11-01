// Phase 1 pipeline: records -> filter -> synthesis -> validation -> formatted references -> log.
// Source fetching is done by the caller (n8n or the web app) and passed in as records,
// so the same logic runs in tests and in production.
'use strict';
const { filterSources } = require('./filter');
const { formatReference, resolveStyle } = require('./format');
const { synthesize, sourceKey } = require('./synthesis');

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

module.exports = { runLiteratureReview };
