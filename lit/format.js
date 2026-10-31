// Deterministic citation formatting (APA 7 default; Harvard, Vancouver, Chicago author-date, IEEE, MLA 9).
// Input: a source record. Output: a reference string. No AI involved.
'use strict';

const STYLES = ['apa7', 'harvard', 'vancouver', 'chicago', 'ieee', 'mla'];
const DEFAULT_STYLE = 'apa7';

function resolveStyle(style) {
  const s = String(style || '').trim().toLowerCase();
  if (!s) return DEFAULT_STYLE;                 // nothing selected -> APA 7
  if (!STYLES.includes(s)) throw new Error('Unknown citation style: ' + style);
  return s;
}

const initials = (given) => String(given || '').split(/[\s-]+/).filter(Boolean).map(p => p[0].toUpperCase() + '.').join(' ');
const apaName = (a) => a.family + (a.given ? ', ' + initials(a.given) : '');
const harvardName = (a) => a.family + (a.given ? ', ' + initials(a.given).replace(/\. /g, '.') : '') + (a.given ? '' : '');
function joinHarvard(names) {
  if (names.length <= 1) return names.join('');
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}
const vancouverName = (a) => a.family + ' ' + String(a.given || '').split(/[\s-]+/).filter(Boolean).map(p => p[0].toUpperCase()).join('');

function joinApa(names) {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length <= 20) return names.slice(0, -1).join(', ') + ', & ' + names[names.length - 1];
  return names.slice(0, 19).join(', ') + ', ... ' + names[names.length - 1];   // APA 7: first 19, ellipsis, last
}

// Chicago author-date (17th ed.) and MLA 9 / IEEE helpers.
const chicagoName = (a, i) => (i === 0 ? a.family + (a.given ? ', ' + String(a.given).trim() : '') : String(a.given || '').trim() + ' ' + a.family).trim();
function joinChicago(names) {
  if (names.length <= 1) return names.join('');
  if (names.length <= 10) return names.slice(0, -1).join(', ') + ', and ' + names[names.length - 1];
  return names.slice(0, 7).join(', ') + ', et al.';
}
const ieeeName = (a) => initials(a.given) + (initials(a.given) ? ' ' : '') + a.family;
function joinIeee(names) {
  if (names.length > 6) return names[0] + ' et al.';
  if (names.length <= 2) return names.join(' and ');
  return names.slice(0, -1).join(', ') + ', and ' + names[names.length - 1];
}
const mlaName = (a, i) => (i === 0 ? a.family + (a.given ? ', ' + String(a.given).trim() : '') : String(a.given || '').trim() + ' ' + a.family).trim();
function joinMla(names) {
  if (names.length <= 1) return names.join('');
  if (names.length === 2) return names[0] + ', and ' + names[1];
  return names[0] + ', et al.';
}

function sentenceCase(t) { return String(t || '').trim().replace(/\.$/, ''); }

function formatReference(src, style) {
  const st = resolveStyle(style);
  const authors = Array.isArray(src.authors) ? src.authors : [];
  const year = src.year || 'n.d.';
  const title = sentenceCase(src.title);
  const doi = src.doi ? 'https://doi.org/' + String(src.doi).replace(/^https?:\/\/doi\.org\//, '') : (src.url || '');
  const isGrey = !!src.isGrey;

  if (st === 'apa7') {
    const who = isGrey && src.organisation ? src.organisation : joinApa(authors.map(apaName));
    if (isGrey) {
      return `${who} (${year}). ${title}${src.reportType ? ' (' + src.reportType + ')' : ''}. ${src.publisher && src.publisher !== who ? src.publisher + '. ' : ''}${doi}`.trim();
    }
    const vol = src.volume ? `, ${src.volume}` : '';
    const iss = src.issue ? `(${src.issue})` : '';
    const pages = src.pages ? `, ${src.pages}` : '';
    return `${who} (${year}). ${title}. ${src.venue || ''}${vol}${iss}${pages}. ${doi}`.replace(/\s+/g, ' ').trim();
  }

  if (st === 'harvard') {
    const who = isGrey && src.organisation ? src.organisation : joinHarvard(authors.map(harvardName));
    if (isGrey) return `${who} (${year}) ${title}. ${src.publisher ? src.publisher + '.' : ''} ${doi ? 'Available at: ' + doi : ''}`.replace(/\s+/g, ' ').trim();
    const vol = src.volume ? ` ${src.volume}` : '';
    const iss = src.issue ? `(${src.issue})` : '';
    const pages = src.pages ? `, pp. ${src.pages}` : '';
    return `${who} (${year}) '${title}', ${src.venue || ''}${vol}${iss}${pages}.${src.doi ? ' doi:' + src.doi + '.' : ''}`.replace(/\s+/g, ' ').trim();
  }

  if (st === 'chicago') {
    const who = isGrey && src.organisation ? src.organisation : joinChicago(authors.map(chicagoName));
    if (isGrey) return `${who}. ${year}. ${title}.${src.reportType ? ' ' + src.reportType + '.' : ''} ${src.publisher ? src.publisher + '. ' : ''}${doi}`.replace(/\s+/g, ' ').trim();
    const vol = src.volume ? ` ${src.volume}` : '';
    const iss = src.issue ? `, no. ${src.issue}` : '';
    const pages = src.pages ? `: ${src.pages}` : '';
    return `${who}. ${year}. "${title}." ${src.venue || ''}${vol}${iss}${pages}. ${doi}`.replace(/\s+/g, ' ').trim();
  }

  if (st === 'ieee') {
    const who = isGrey && src.organisation ? src.organisation : joinIeee(authors.map(ieeeName));
    if (isGrey) return `${who}, "${title}," ${src.publisher ? src.publisher + ', ' : ''}${year}.${doi ? ' [Online]. Available: ' + doi : ''}`.replace(/\s+/g, ' ').trim();
    const vol = src.volume ? `, vol. ${src.volume}` : '';
    const iss = src.issue ? `, no. ${src.issue}` : '';
    const pages = src.pages ? `, pp. ${src.pages}` : '';
    return `${who}, "${title}," ${src.venue || ''}${vol}${iss}${pages}, ${year}.${src.doi ? ' doi: ' + src.doi + '.' : ''}`.replace(/\s+/g, ' ').replace(/ ,/g, ',').trim();
  }

  if (st === 'mla') {
    const who = isGrey && src.organisation ? src.organisation : joinMla(authors.map(mlaName));
    if (isGrey) return `${who}. ${title}. ${src.publisher ? src.publisher + ', ' : ''}${year}.${doi ? ' ' + doi + '.' : ''}`.replace(/\s+/g, ' ').replace(/\.\./g, '.').trim();
    const vol = src.volume ? `, vol. ${src.volume}` : '';
    const iss = src.issue ? `, no. ${src.issue}` : '';
    const pages = src.pages ? `, pp. ${src.pages}` : '';
    return `${who}. "${title}." ${src.venue || ''}${vol}${iss}, ${year}${pages}.${doi ? ' ' + doi + '.' : ''}`.replace(/\s+/g, ' ').replace(/\.\./g, '.').trim();
  }

  // vancouver
  const who = isGrey && src.organisation ? src.organisation : authors.map(vancouverName).join(', ');
  if (isGrey) return `${who}. ${title}. ${src.publisher ? src.publisher + '; ' : ''}${year}.${doi ? ' Available from: ' + doi : ''}`.replace(/\s+/g, ' ').trim();
  const vol = src.volume ? ` ${src.volume}` : '';
  const iss = src.issue ? `(${src.issue})` : '';
  const pages = src.pages ? `:${src.pages}` : '';
  return `${who}. ${title}. ${src.venue || ''}. ${year};${src.volume || ''}${iss}${pages}.${src.doi ? ' doi:' + src.doi : ''}`.replace(/\s+/g, ' ').replace(/\.\./g, '.').trim();
}

module.exports = { STYLES, DEFAULT_STYLE, resolveStyle, formatReference };
