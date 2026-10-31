'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveStyle, formatReference, STYLES } = require('../format');

const art = {
  title: 'Medical tourism policy in India.', year: 2020, venue: 'Health Policy J', volume: '81', issue: '2', pages: '104-123',
  doi: '10.1/xyz', authors: [{ family: 'Smith', given: 'John A' }, { family: 'Kumar', given: 'R' }]
};
const grey = { isGrey: true, title: 'National Medical Value Travel Report', year: 2023, organisation: 'Ministry of Health',
  publisher: 'Government Press', reportType: 'report', url: 'https://gov.example/report' };

test('styles are registered and default is APA 7', () => {
  for (const s of ['apa7', 'harvard', 'vancouver', 'chicago', 'ieee', 'mla']) assert.ok(STYLES.includes(s));
  assert.equal(resolveStyle(''), 'apa7');
  assert.equal(resolveStyle(undefined), 'apa7');
  assert.throws(() => resolveStyle('bluebook'), /Unknown citation style/);
});

test('Chicago author-date article', () => {
  assert.equal(formatReference(art, 'chicago'),
    'Smith, John A, and R Kumar. 2020. "Medical tourism policy in India." Health Policy J 81, no. 2: 104-123. https://doi.org/10.1/xyz');
});

test('IEEE article uses initials and numbered pages', () => {
  assert.equal(formatReference(art, 'ieee'),
    'J. A. Smith and R. Kumar, "Medical tourism policy in India," Health Policy J, vol. 81, no. 2, pp. 104-123, 2020. doi: 10.1/xyz.');
});

test('MLA article inverts only the first author', () => {
  assert.equal(formatReference(art, 'mla'),
    'Smith, John A, and R Kumar. "Medical tourism policy in India." Health Policy J, vol. 81, no. 2, 2020, pp. 104-123. https://doi.org/10.1/xyz.');
});

test('MLA uses et al. for three or more authors', () => {
  const three = { ...art, authors: [...art.authors, { family: 'Lee', given: 'M' }] };
  assert.match(formatReference(three, 'mla'), /^Smith, John A, et al\./);
});

test('grey literature is cited by organisation in every new style', () => {
  assert.match(formatReference(grey, 'chicago'), /^Ministry of Health\. 2023\./);
  assert.match(formatReference(grey, 'ieee'), /^Ministry of Health, "National Medical Value Travel Report,"/);
  assert.match(formatReference(grey, 'mla'), /^Ministry of Health\. National Medical Value Travel Report\./);
});
