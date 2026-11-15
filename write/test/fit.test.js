'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../plan');

// Deterministic random numbers, so every run of the test is the same.
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const words = n => Array.from({ length: Math.max(0, Math.round(n)) }, (_, i) => 'w' + i).join(' ');

// A writer that behaves like the real one: a first draft that often runs long, a shortened draft close to the
// requested length (sometimes a bit over or under), and a continuation close to the requested length.
function realisticWriter(seed) {
  const r = rng(seed);
  return async ({ words: need, existing, tooLong }) => {
    let factor;
    if (!existing) factor = [1.2, 2.5, 4][Math.floor(r() * 3)];
    else if (tooLong) factor = 0.85 + r() * 0.35;
    else factor = 0.8 + r() * 0.4;
    return { ok: true, text: words(need * factor), references: [] };
  };
}

// A writer that ignores the request to shorten: it always returns the same length.
const stubbornWriter = async ({ words: need, existing }) => ({ ok: true, text: words(existing ? countOf(existing) : need * 3), references: [] });
const countOf = t => String(t).trim().split(/\s+/).filter(Boolean).length;

const outline = P.buildOutline('book:monograph', 3000, {});

test('every section is fitted to its planned length, for many simulated writers', async () => {
  for (let seed = 1; seed <= 200; seed++) {
    for (const s of outline.sections.filter(x => !x.fixed)) {
      const res = await P.fitSection(s.words, realisticWriter(seed * 100 + s.words), { maxAttempts: 8 });
      assert.equal(res.status, 'ok', `seed ${seed} section ${s.id} planned ${s.words} got ${res.words} after ${res.attempts} attempts`);
      assert.ok(res.words >= s.words * 0.9 && res.words <= s.words * 1.1, `${s.id}: ${res.words} vs ${s.words}`);
    }
  }
});

test('a writer that never shortens stops after the attempt limit and reports long', async () => {
  const res = await P.fitSection(170, stubbornWriter, { maxAttempts: 8 });
  assert.equal(res.status, 'long');
  assert.ok(res.attempts <= 8);
});

test('a section too large to send for shortening is kept and reported long, not cut', async () => {
  const big = async ({ existing }) => ({ ok: true, text: words(existing ? 20000 : 30000), references: [] });
  const res = await P.fitSection(170, big, { maxShortenChars: 1000 });
  assert.equal(res.status, 'long');
});

test('shortening is asked for with tooLong and the source is not used for it', async () => {
  const calls = [];
  await P.fitSection(170, async (args) => { calls.push(args); return { ok: true, text: words(args.existing ? 175 : 600), references: [] }; });
  assert.equal(calls[0].tooLong, false);
  assert.equal(calls[1].tooLong, true);
  assert.ok(calls[1].words >= 145 && calls[1].words <= 170, String(calls[1].words));
});

test('onStep receives the text after each reply, so progress is saved', async () => {
  const seen = [];
  await P.fitSection(170, realisticWriter(7), { onStep: (t) => seen.push(countOf(t)) });
  assert.ok(seen.length >= 1);
});

test('the whole article lands within 5% of the target when each section is aimed from the words left', async () => {
  const plans = outline.sections.filter(x => !x.fixed).map(x => x.words);
  for (let seed = 1; seed <= 200; seed++) {
    let done = 0;
    for (let i = 0; i < plans.length; i++) {
      const aim = P.aimFor(plans, i, done, 3000);
      const res = await P.fitSection(aim, realisticWriter(seed * 1000 + i));
      done += res.words;
    }
    assert.ok(done >= 3000 * 0.95 && done <= 3000 * 1.05, `seed ${seed}: total ${done}`);
  }
});
