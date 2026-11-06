// Splits an OpenAlex display name into { family, given } for citation formatting.
// Organisation names (for example "Next Move Strategy Consulting") keep the whole name as the family
// name with no given name. Names ending in initials (for example "Sangeetha S") take the initials as the given name.
'use strict';

const ORG = /\b(consulting|strategy|group|inc|ltd|llc|corporation|corp|institute|organi[sz]ation|university|council|ministry|office|foundation|association|company|limited|services|market|research|agency|board|department|centre|center|press|publishing|publisher|ieee|who|oecd|world|zenodo|cern)\b/i;

function splitAuthor(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  if (ORG.test(n)) return { family: n, given: '' };
  const t = n.split(/\s+/);
  let i = t.length;
  while (i > 1 && t[i - 1].length === 1) i--;
  if (i === t.length) return { family: t[t.length - 1], given: t.slice(0, -1).join(' ') };
  return { family: t.slice(0, i).join(' '), given: t.slice(i).join(' ') };
}

module.exports = { splitAuthor };
