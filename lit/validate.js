// Citation validator: every citation key in generated text must be in the kept list.
// Citation syntax in drafts: {{cite:KEY}}
'use strict';

function validateCitations(text, keptKeys) {
  const allowed = new Set(keptKeys);
  const found = [...String(text).matchAll(/\{\{cite:([^}]+)\}\}/g)].map(m => m[1].trim());
  const unknown = [...new Set(found.filter(k => !allowed.has(k)))];
  const sentences = String(text).split(/(?<=[.!?])\s+/).filter(s => s.trim() && !/^#/.test(s.trim()));
  const uncited = sentences.filter(s => !/\{\{cite:[^}]+\}\}/.test(s) && !/^\s*(Note|Summary|Gap)\b/i.test(s));
  return { ok: unknown.length === 0, unknownKeys: unknown, citedCount: found.length, uncitedSentences: uncited };
}

module.exports = { validateCitations };
