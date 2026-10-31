import test from 'node:test';
import assert from 'node:assert/strict';
import { injectNotFound } from '../bench/corpus.mjs';
import { createReference } from '../bench/reference.mjs';

const urls = Array.from({ length: 1000 }, (_, i) => `/users/${i}/orders/${i + 1}`);
const reference = createReference([{ concretePaths: ['/users/:id#int/orders/:order#int'] }]);
const isNotFound = (url) => reference(url) === null;

// Math.random would make a failure here impossible to reproduce.
function seededRng() {
  let state = 1;
  return () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
}

const inject = (percent) => injectNotFound(urls, percent, isNotFound, seededRng());
const countNotFound = (list) => list.filter(isNotFound).length;

test('injectNotFound replaces an exact share with URLs that match no route', () => {
  assert.equal(countNotFound(urls), 0);
  assert.equal(countNotFound(inject(20)), 200);
  assert.equal(countNotFound(inject(0.5)), 5);
});

test('injectNotFound handles the ends of the range', () => {
  assert.deepEqual(inject(0), urls);
  assert.equal(countNotFound(inject(100)), 1000);
});

test('injectNotFound keeps the size and order, and leaves its input alone', () => {
  const before = [...urls];
  const injected = inject(20);
  assert.equal(injected.length, urls.length);
  assert.deepEqual(urls, before);
  const kept = injected.filter((url, i) => url === urls[i]).length;
  assert.equal(kept, 800);
});

test('injectNotFound spreads the 404s through the corpus', () => {
  const injected = inject(20);
  const inFirstHalf = injected.slice(0, 500).filter(isNotFound).length;
  assert.ok(inFirstHalf > 70 && inFirstHalf < 130, `${inFirstHalf} of 200 in the first half`);
});

test('injectNotFound fails instead of spinning when no URL can miss', () => {
  assert.throws(() => injectNotFound(urls, 20, () => false, seededRng()), /still matched a route/);
});
