// Source filter for the literature engine. Every filter is optional (user-chosen).
// Retraction check and de-duplication are the only ones on by default, as safety steps.
// Each record gets a decision and reason, so the inclusion log is complete.
'use strict';

const DEFAULTS = {
  types: ['article', 'review', 'conference', 'grey'],   // all types on
  dropRetracted: true,                                  // safety: always on
  dedupe: true,                                         // safety: always on
  yearFrom: null,                                       // off unless user sets it
  yearTo: null,
  foundationalExempt: true,                             // old, heavily-cited theory is never dropped by age
  foundationalCitations: 500,                           // threshold for "foundational" flag
  minTier: null,                                        // e.g. {sjrQuartile:'Q2', scopusActive:true}
  minCitations: null,                                   // off unless user sets it
  minRelevance: null                                    // off unless user sets it (0..1)
};

const QRANK = { Q1: 1, Q2: 2, Q3: 3, Q4: 4 };

function meetsTier(src, min) {
  if (!min) return true;
  const t = src.tier || {};
  if (min.scopusActive && t.scopus !== 'active') return false;
  if (min.sjrQuartile && (!t.sjrQuartile || QRANK[t.sjrQuartile] > QRANK[min.sjrQuartile])) return false;
  if (min.wos && !(t.wos && t.wos.length)) return false;
  if (min.abdc && !(t.abdc && t.abdc.length)) return false;
  return true;
}

function dedupeKey(s) {
  if (s.doi) return 'doi:' + String(s.doi).toLowerCase();
  return 'ty:' + String(s.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + '|' + (s.year || '');
}

function filterSources(records, userFilters) {
  const f = Object.assign({}, DEFAULTS, userFilters || {});
  const kept = [], excluded = [], seen = new Set();
  const log = { input: records.length, excludedBy: {}, yearWindowWidened: false };
  const excl = (rec, reason) => { log.excludedBy[reason] = (log.excludedBy[reason] || 0) + 1; excluded.push({ key: rec.doi || rec.title, reason }); };

  for (const s of records) {
    const isFoundational = (s.citations || 0) >= f.foundationalCitations;
    const type = s.isGrey ? 'grey' : (s.type || 'article');

    if (f.dedupe) {
      const k = dedupeKey(s);
      if (seen.has(k)) { excl(s, 'duplicate'); continue; }
      seen.add(k);
    }
    if (f.dropRetracted && s.retracted) { excl(s, 'retracted'); continue; }
    if (!f.types.includes(type)) { excl(s, 'type:' + type); continue; }
    if (f.yearFrom && s.year && s.year < f.yearFrom) {
      if (!(f.foundationalExempt && isFoundational)) { excl(s, 'before-year-range'); continue; }
    }
    if (f.yearTo && s.year && s.year > f.yearTo) { excl(s, 'after-year-range'); continue; }
    if (!s.isGrey && !meetsTier(s, f.minTier)) { excl(s, 'venue-tier'); continue; }
    if (f.minCitations != null && (s.citations || 0) < f.minCitations && !(s.isGrey)) { excl(s, 'citation-floor'); continue; }
    if (f.minRelevance != null && (s.relevance == null || s.relevance < f.minRelevance)) { excl(s, 'relevance'); continue; }

    kept.push(Object.assign({}, s, { foundational: isFoundational, tierLabel: s.isGrey ? 'grey literature' : 'peer-reviewed' }));
  }
  log.kept = kept.length; log.excluded = excluded.length;
  return { kept, excluded, log };
}

module.exports = { DEFAULTS, filterSources };
