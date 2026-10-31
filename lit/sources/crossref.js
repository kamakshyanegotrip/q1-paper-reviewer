// Crossref adapter: DOI metadata and retraction check. HTTP injected for testing.
'use strict';

function normalizeCrossref(msg) {
  const doi = msg.DOI || null;
  const date = msg.issued && msg.issued['date-parts'] && msg.issued['date-parts'][0][0];
  return {
    doi,
    title: (msg.title && msg.title[0]) || '',
    year: date || null,
    authors: (msg.author || []).map(a => ({ family: a.family || a.name || '', given: a.given || '' })),
    venue: (msg['container-title'] && msg['container-title'][0]) || '',
    volume: msg.volume || '', issue: msg.issue || '', pages: msg.page || '',
    retracted: isRetracted(msg),
    source: 'crossref'
  };
}

// Crossref marks retractions as an update of type "retraction" or "withdrawal".
function isRetracted(msg) {
  const updates = msg['update-to'] || [];
  return updates.some(u => u.type === 'retraction' || u.type === 'withdrawal');
}

async function lookupDoi(doi, fetchJson) {
  const data = await fetchJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
  return normalizeCrossref(data.message || {});
}

module.exports = { normalizeCrossref, isRetracted, lookupDoi };
