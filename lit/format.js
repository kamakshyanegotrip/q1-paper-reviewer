// Deterministic citation formatting (APA 7 default, Harvard, Vancouver).
// Input: a source record. Output: a reference string. No AI involved.
'use strict';

const STYLES = ['apa7', 'harvard', 'vancouver'];
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

  // vancouver
  const who = isGrey && src.organisation ? src.organisation : authors.map(vancouverName).join(', ');
  if (isGrey) return `${who}. ${title}. ${src.publisher ? src.publisher + '; ' : ''}${year}.${doi ? ' Available from: ' + doi : ''}`.replace(/\s+/g, ' ').trim();
  const vol = src.volume ? ` ${src.volume}` : '';
  const iss = src.issue ? `(${src.issue})` : '';
  const pages = src.pages ? `:${src.pages}` : '';
  return `${who}. ${title}. ${src.venue || ''}. ${year};${src.volume || ''}${iss}${pages}.${src.doi ? ' doi:' + src.doi : ''}`.replace(/\s+/g, ' ').replace(/\.\./g, '.').trim();
}

module.exports = { STYLES, DEFAULT_STYLE, resolveStyle, formatReference };
