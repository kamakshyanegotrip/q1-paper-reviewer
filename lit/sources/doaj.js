// DOAJ adapter (directory of open-access journals, quality-checked). HTTP injected for testing.
'use strict';

function buildSearchUrl(query, opts = {}) {
  const q = opts.yearFrom ? `${query} AND bibjson.year:>=${opts.yearFrom}` : query;
  return `https://doaj.org/api/search/articles/${encodeURIComponent(q)}?pageSize=${opts.pageSize || 25}`;
}

function normalize(r) {
  const b = r.bibjson || {};
  const doiId = (b.identifier || []).find(i => i.type === 'doi');
  return {
    doi: doiId ? doiId.id : null,
    title: b.title || '',
    year: b.year ? Number(b.year) : null,
    authors: (b.author || []).map(a => {
      const parts = String(a.name || '').split(' ');
      return { family: parts.slice(-1)[0] || '', given: parts.slice(0, -1).join(' ') };
    }),
    venue: (b.journal && b.journal.title) || '',
    volume: b.journal && b.journal.volume || '', issue: b.journal && b.journal.number || '',
    pages: b.start_page ? `${b.start_page}${b.end_page ? '-' + b.end_page : ''}` : '',
    type: 'article',
    citations: 0,                                       // DOAJ holds no citation counts
    retracted: false,
    abstract: b.abstract || '',
    openAccess: true,
    source: 'doaj'
  };
}

async function search(query, opts, fetchJson) {
  const d = await fetchJson(buildSearchUrl(query, opts));
  return (d.results || []).map(normalize);
}

module.exports = { buildSearchUrl, normalize, search };
