const test = require('node:test');
const assert = require('node:assert/strict');
const { splitAuthor } = require('../names');
const { formatReference } = require('../format');

test('initial at the end becomes the given name', () => {
  assert.deepEqual(splitAuthor('Sangeetha S'), { family: 'Sangeetha', given: 'S' });
  assert.deepEqual(splitAuthor('Lazar D'), { family: 'Lazar', given: 'D' });
});

test('ordinary names keep the last word as family name', () => {
  assert.deepEqual(splitAuthor('Jatashankar Tewari'), { family: 'Tewari', given: 'Jatashankar' });
  assert.deepEqual(splitAuthor('Mary Ann Smith'), { family: 'Smith', given: 'Mary Ann' });
  assert.deepEqual(splitAuthor('Single'), { family: 'Single', given: '' });
});

test('organisation names are not split into a person', () => {
  assert.deepEqual(splitAuthor('Next Move Strategy Consulting'), { family: 'Next Move Strategy Consulting', given: '' });
});

test('empty names return null', () => {
  assert.equal(splitAuthor(''), null);
  assert.equal(splitAuthor(undefined), null);
});

test('APA output for the included sources uses the corrected names', () => {
  const org = formatReference({ authors: [splitAuthor('Next Move Strategy Consulting')], year: 2026, title: 'Global IVF Devices', isGrey: true, publisher: 'Zenodo' }, 'apa7');
  assert.ok(org.startsWith('Next Move Strategy Consulting (2026).'), org);
  const person = formatReference({ authors: [splitAuthor('Sangeetha S'), splitAuthor('Lazar D')], year: 2025, title: 'Rethinking Health Expenditure in India' }, 'apa7');
  assert.ok(person.startsWith('Sangeetha, S., & Lazar, D. (2025).'), person);
});
