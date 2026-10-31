// Europe PMC adapter (life sciences + open full texts). HTTP injected for testing.
'use strict';
const BASE = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';

function buildSearchUrl(query, opts = {}) {
  const q = opts.yearFrom ? `(${query}) AND (PUB_YEAR:[${opts.yearFrom} TO 2100])` : query;
  return `${BASE}?query=${encodeURIComponent(q)}&format=json&resultType=core&pageSize=${opts.pageSize || 25}`;
}

function normalize(r) {
  const authors = ((r.authorList && r.authorList.author) || []).map(a => ({ family: a.lastName || '', given: a.firstName || '' }));
  return {
    doi: r.doi || null,
    title: (r.title || '').replace(/\.$/, ''),
    year: r.pubYear ? Number(r.pubYear) : null,
    authors,
    venue: r.journalTitle || '',
    volume: r.journalVolume || '', issue: r.issue || '', pages: r.pageInfo || '',
    type: /review/i.test((r.pubTypeList && r.pubTypeList.pubType || []).join(' ')) ? 'review' : 'article',
    citations: Number(r.citedByCount) || 0,
    retracted: false,                                   // Europe PMC does not flag retractions; Crossref check covers it
    abstract: r.abstractText || '',
    openAccess: r.isOpenAccess === 'Y',
    source: 'europepmc'
  };
}

async function search(query, opts, fetchJson) {
  const d = await fetchJson(buildSearchUrl(query, opts));
  return ((d.resultList && d.resultList.result) || []).map(normalize);
}

module.exports = { buildSearchUrl, normalize, search };
