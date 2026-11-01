// Unpaywall adapter: legal free full-text location. Requires a contact email (set by the operator
// in configuration, never hard-coded), as Unpaywall's API requires it.
'use strict';

function oaUrl(doi, email) {
  if (!email) throw new Error('Unpaywall needs a contact email set in configuration');
  return `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`;
}

async function freeFullText(doi, email, fetchJson) {
  const d = await fetchJson(oaUrl(doi, email));
  const best = d.best_oa_location || null;
  return { isOa: !!d.is_oa, url: best ? (best.url_for_pdf || best.url) : null, license: best ? best.license : null };
}

module.exports = { oaUrl, freeFullText };
