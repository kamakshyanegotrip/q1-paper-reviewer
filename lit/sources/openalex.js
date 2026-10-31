// OpenAlex adapter: search works and normalise to the source record used by the engine.
// The HTTP call is injected (fetchJson) so tests can run without network access.
'use strict';

const BASE = 'https://api.openalex.org/works';

function buildSearchUrl(query, opts = {}) {
  const p = new URLSearchParams({ search: query, 'per-page': String(opts.perPage || 25), select: 'id,doi,title,publication_year,authorships,primary_location,type,cited_by_count,abstract_inverted_index,is_retracted' });
  if (opts.yearFrom) p.set('filter', `from_publication_date:${opts.yearFrom}-01-01`);
  if (opts.mailto) p.set('mailto', opts.mailto);   // user-supplied contact, optional
  return `${BASE}?${p.toString()}`;
}

function rebuildAbstract(inv) {
  if (!inv) return '';
  const words = [];
  for (const [w, positions] of Object.entries(inv)) for (const pos of positions) words[pos] = w;
  return words.filter(Boolean).join(' ');
}

function normalizeWork(w) {
  const src = w.primary_location && w.primary_location.source || {};
  const doi = w.doi ? String(w.doi).replace(/^https?:\/\/doi\.org\//, '') : null;
  return {
    doi,
    title: w.title || '',
    year: w.publication_year || null,
    authors: (w.authorships || []).map(a => {
      const name = (a.author && a.author.display_name) || '';
      const parts = name.split(' ');
      return { family: parts.slice(-1)[0] || '', given: parts.slice(0, -1).join(' ') };
    }),
    venue: src.display_name || '',
    type: w.type === 'review' ? 'review' : (w.type === 'proceedings-article' ? 'conference' : 'article'),
    citations: w.cited_by_count || 0,
    retracted: !!w.is_retracted,
    abstract: rebuildAbstract(w.abstract_inverted_index),
    isGrey: false,
    source: 'openalex'
  };
}

async function searchOpenAlex(query, opts, fetchJson) {
  const data = await fetchJson(buildSearchUrl(query, opts));
  return (data.results || []).map(normalizeWork);
}

module.exports = { buildSearchUrl, normalizeWork, rebuildAbstract, searchOpenAlex };
