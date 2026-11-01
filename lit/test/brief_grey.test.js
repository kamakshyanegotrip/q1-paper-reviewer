'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { literatureBriefFromReview } = require('../fromReview');
const grey = require('../sources/grey');
const { filterSources } = require('../filter');

test('brief: question, keywords and gap-driven queries come from the review', () => {
  const R = { meta: { title: 'Medical visa policy in top 20 countries.' }, inventory: { keywords: ['medical visa', 'health tourism', 'policy'] } };
  const S = {
    major_comments: [{ comment: 'The novelty claim is not supported by prior literature on e-visa regimes.' }, { comment: 'Sample size is small.' }],
    revision_roadmap: { priority_1_must_fix: [{ action: 'Add background citations on medical visa reciprocity.' }], priority_4_editorial: [{ action: 'Fix typos in the abstract.' }] }
  };
  const b = literatureBriefFromReview(R, S);
  assert.match(b.question, /medical visa policy in top 20 countries/i);
  assert.equal(b.gaps.length, 2);                       // sample-size and typo items are not literature gaps
  assert.ok(b.queries.length >= 2 && b.queries.length <= 8);
  assert.ok(b.queries.some(q => /medical visa/.test(q)));
});

test('brief: empty review still returns a usable question', () => {
  const b = literatureBriefFromReview({}, {});
  assert.equal(b.gaps.length, 0);
  assert.equal(b.queries.length, 0);
  assert.match(b.question, /this topic/);
});

test('grey: OpenAlex report query is restricted to reports', () => {
  const url = grey.buildSearchUrl('medical tourism India', { yearFrom: 2018, perPage: 10 });
  assert.match(url, /filter=type%3Areport%2Cfrom_publication_date%3A2018-01-01/);
});

test('grey: only allowlisted government and industry publishers pass', async () => {
  const fake = async () => ({ results: [
    { display_name: 'Medical Value Travel Report', publication_year: 2023, authorships: [{ institutions: [{ display_name: 'Ministry of Tourism' }] }], primary_location: { landing_page_url: 'https://tourism.gov.in/x' }, cited_by_count: 4 },
    { display_name: 'Blog post on visas', publication_year: 2023, authorships: [{ institutions: [{ display_name: 'Travel Blog Ltd' }] }] },
    { display_name: 'Wikipedia-like summary', publication_year: 2022, authorships: [{ institutions: [{ display_name: 'Wikipedia' }] }] }
  ] });
  const out = await grey.search('medical tourism', {}, fake);
  assert.equal(out.length, 1);
  assert.equal(out[0].organisation, 'Ministry of Tourism');
  assert.equal(out[0].isGrey, true);
});

test('grey: trusted publisher is kept by the filter without a stated method', () => {
  const recs = [
    { isGrey: true, trustedPublisher: true, title: 'Official report', organisation: 'OECD', year: 2024, method: '' },
    { isGrey: true, trustedPublisher: false, title: 'Unknown report', organisation: 'Some Co', year: 2024, method: '' }
  ];
  const out = filterSources(recs, {});
  assert.deepEqual(out.kept.map(k => k.title), ['Official report']);
});
