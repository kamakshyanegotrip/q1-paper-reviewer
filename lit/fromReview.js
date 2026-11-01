// Turns a finished review into a literature brief: the topic, the search queries, and the
// review gaps the literature must answer. Deterministic; no AI involved.
'use strict';

const GAP_RE = /literature|novelty|prior (work|research|studies)|cite|citation|reference|theor|gap|background|related work|state of the art|contribution/i;
const arr = (x) => (Array.isArray(x) ? x : []);
const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();
const shorten = (t, n = 12) => clean(t).split(' ').slice(0, n).join(' ');

function topicOf(R) {
  const M = R.meta || {}, I = R.inventory || {};
  const kw = arr(I.keywords).filter(Boolean).slice(0, 6);
  return { title: clean(M.title), keywords: kw, field: clean(M.field) };
}

// Collect review items that point at missing or weak literature.
function gapsOf(R, S) {
  const gaps = [];
  arr(S && S.major_comments).forEach(c => gaps.push({ source: 'major_comment', text: clean(c.comment || c.text || c.title || c) }));
  const RM = (S && S.revision_roadmap) || {};
  Object.keys(RM).forEach(k => arr(RM[k]).forEach(step => gaps.push({ source: 'roadmap:' + k, text: clean(step.action) })));
  arr(R.literature && R.literature.gaps).forEach(g => gaps.push({ source: 'literature_engine', text: clean(g.text || g) }));
  const seen = new Set();
  return gaps.filter(g => g.text && GAP_RE.test(g.text) && !seen.has(g.text) && seen.add(g.text));
}

function queriesFor(topic, gaps) {
  const base = [topic.title, topic.keywords.join(' ')].filter(Boolean).join(' ');
  const q = [];
  if (base) q.push(shorten(base, 14));
  gaps.forEach(g => {
    const core = clean(g.text).replace(/^(add|cite|include|discuss|review|expand|strengthen|clarify)\s+/i, '');
    q.push(shorten([topic.keywords.slice(0, 3).join(' '), core].filter(Boolean).join(' '), 14));
  });
  return [...new Set(q.filter(Boolean))].slice(0, 8);
}

function literatureBriefFromReview(R, S) {
  const topic = topicOf(R || {});
  const gaps = gapsOf(R || {}, S || {});
  const question = topic.title
    ? `What does the literature show about ${topic.title.replace(/[.:]$/, '')}, and where does the evidence leave gaps?`
    : 'What does the literature show about this topic, and where does the evidence leave gaps?';
  return { question, topic, gaps, queries: queriesFor(topic, gaps), style: '' };
}

const api = { literatureBriefFromReview, gapsOf, queriesFor };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.Q1Brief = api;
