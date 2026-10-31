// CORE adapter (open-access aggregator). Needs an API key set in configuration (never hard-coded).
'use strict';
const BASE = 'https://api.core.ac.uk/v3/search/works';

function buildRequest(query, opts = {}) {
  if (!opts.apiKey) throw new Error('CORE needs an API key set in configuration');
  const q = opts.yearFrom ? `(${query}) AND yearPublished>=${opts.yearFrom}` : query;
  return { url: `${BASE}?q=${encodeURIComponent(q)}&limit=${opts.pageSize || 25}`, headers: { Authorization: `Bearer ${opts.apiKey}` } };
}

function normalize(w) {
  return {
    doi: w.doi || null,
    title: w.title || '',
    year: w.yearPublished || null,
    authors: (w.authors || []).map(a => {
      const parts = String(a.name || '').split(' ');
      return { family: parts.slice(-1)[0] || '', given: parts.slice(0, -1).join(' ') };
    }),
    venue: (w.journals && w.journals[0] && w.journals[0].title) || w.publisher || '',
    type: 'article',
    citations: w.citationCount || 0,
    retracted: false,
    abstract: w.abstract || '',
    openAccess: !!w.downloadUrl,
    source: 'core'
  };
}

async function search(query, opts, fetchJson) {
  const req = buildRequest(query, opts);
  const d = await fetchJson(req.url, { headers: req.headers });
  return (d.results || []).map(normalize);
}

module.exports = { buildRequest, normalize, search };
