// Government, intergovernmental and industry reports, found through OpenAlex (type = report).
// Only publishers on the allowlist below pass; that stands in for a method statement, since
// these bodies publish their own methodology. Blogs, news sites, Wikipedia and editorials are never included.
'use strict';

const TRUSTED = [
  // intergovernmental
  'UN Tourism', 'UNWTO', 'World Tourism Organization', 'OECD', 'World Health Organization', 'WHO',
  'World Bank', 'International Monetary Fund', 'United Nations',
  // Government of India
  'Ministry of Tourism', 'Ministry of Health and Family Welfare', 'NITI Aayog', 'Invest India',
  'Ministry of External Affairs', 'Department of Commerce',
  // industry bodies
  'World Travel & Tourism Council', 'WTTC', 'IATA', 'FICCI', 'Confederation of Indian Industry', 'CII'
];

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const TRUSTED_N = TRUSTED.map(norm);

function trustedPublisher(name) {
  const n = norm(name);
  if (!n) return false;
  return TRUSTED_N.some(t => n === t || n.includes(t));
}

function buildSearchUrl(query, opts = {}) {
  const f = ['type:report'];
  if (opts.yearFrom) f.push(`from_publication_date:${opts.yearFrom}-01-01`);
  const params = new URLSearchParams({
    search: query,
    filter: f.join(','),
    'per-page': String(opts.perPage || 25)
  });
  if (opts.mailto) params.set('mailto', opts.mailto);
  return 'https://api.openalex.org/works?' + params.toString();
}

function normalizeWork(w) {
  const publisher = (w.primary_location && w.primary_location.source && w.primary_location.source.host_organization_name) ||
    (w.primary_location && w.primary_location.source && w.primary_location.source.display_name) || '';
  const org = ((w.authorships || []).map(a => a.institutions && a.institutions[0] && a.institutions[0].display_name).find(Boolean)) || publisher;
  return {
    isGrey: true,
    type: 'grey',
    reportType: 'report',
    title: w.display_name || w.title || '',
    year: w.publication_year || null,
    organisation: org,
    publisher,
    doi: w.doi ? w.doi.replace(/^https?:\/\/doi\.org\//, '') : null,
    url: (w.primary_location && w.primary_location.landing_page_url) || w.doi || '',
    authors: [],
    citations: w.cited_by_count || 0,
    retracted: !!w.is_retracted,
    abstract: '',
    method: '',
    trustedPublisher: trustedPublisher(org) || trustedPublisher(publisher),
    source: 'grey-openalex'
  };
}

async function search(query, opts, fetchJson) {
  const d = await fetchJson(buildSearchUrl(query, opts));
  return (d.results || []).map(normalizeWork).filter(r => r.trustedPublisher);
}

module.exports = { TRUSTED, trustedPublisher, buildSearchUrl, normalizeWork, search };
