'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const epmc = require('../sources/europepmc');
const core = require('../sources/core');
const doaj = require('../sources/doaj');

test('Europe PMC: builds a year-bounded query and normalizes a record', async () => {
  const url = epmc.buildSearchUrl('medical tourism', { yearFrom: 2015, pageSize: 10 });
  assert.match(url, /PUB_YEAR%3A%5B2015%20TO%202100%5D/);
  assert.match(url, /format=json/);
  const fake = async () => ({ resultList: { result: [{
    doi: '10.1/abc', title: 'Medical tourism in India.', pubYear: '2019',
    authorList: { author: [{ lastName: 'Rao', firstName: 'A' }] },
    journalTitle: 'J Health', journalVolume: '3', issue: '2', pageInfo: '10-20',
    pubTypeList: { pubType: ['journal article'] }, citedByCount: 7, isOpenAccess: 'Y'
  }] } });
  const out = await epmc.search('medical tourism', {}, fake);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Medical tourism in India');
  assert.equal(out[0].year, 2019);
  assert.equal(out[0].authors[0].family, 'Rao');
  assert.equal(out[0].openAccess, true);
  assert.equal(out[0].source, 'europepmc');
});

test('Europe PMC: review publication type is recognised', () => {
  const r = epmc.normalize({ title: 'X', pubTypeList: { pubType: ['Review'] } });
  assert.equal(r.type, 'review');
});

test('CORE: refuses to build a request without an API key', () => {
  assert.throws(() => core.buildRequest('medical tourism', {}), /API key/);
});

test('CORE: sends the key as a Bearer header and normalizes results', async () => {
  const req = core.buildRequest('medical tourism', { apiKey: 'K123', yearFrom: 2018 });
  assert.equal(req.headers.Authorization, 'Bearer K123');
  assert.match(req.url, /yearPublished%3E%3D2018|yearPublished>=2018/);
  const fake = async (url, opts) => {
    assert.equal(opts.headers.Authorization, 'Bearer K123');
    return { results: [{ doi: '10.2/q', title: 'Q', yearPublished: 2020, authors: [{ name: 'Jane Q Doe' }],
      journals: [{ title: 'Journal Q' }], citationCount: 3, downloadUrl: 'https://core/x.pdf' }] };
  };
  const out = await core.search('medical tourism', { apiKey: 'K123' }, fake);
  assert.equal(out[0].authors[0].family, 'Doe');
  assert.equal(out[0].authors[0].given, 'Jane Q');
  assert.equal(out[0].venue, 'Journal Q');
  assert.equal(out[0].openAccess, true);
});

test('DOAJ: builds the search URL and normalizes bibjson', async () => {
  const url = doaj.buildSearchUrl('medical tourism', { yearFrom: 2016, pageSize: 5 });
  assert.match(url, /^https:\/\/doaj\.org\/api\/search\/articles\//);
  assert.match(url, /pageSize=5/);
  const fake = async () => ({ results: [{ bibjson: {
    title: 'Open study', year: '2021', author: [{ name: 'Li Wei' }],
    journal: { title: 'Open J', volume: '9', number: '1' },
    start_page: '5', end_page: '9',
    identifier: [{ type: 'pissn', id: '1234' }, { type: 'doi', id: '10.3/o' }],
    abstract: 'Text'
  } }] });
  const out = await doaj.search('medical tourism', {}, fake);
  assert.equal(out[0].doi, '10.3/o');
  assert.equal(out[0].year, 2021);
  assert.equal(out[0].pages, '5-9');
  assert.equal(out[0].authors[0].family, 'Wei');
  assert.equal(out[0].source, 'doaj');
});
