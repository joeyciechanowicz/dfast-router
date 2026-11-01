import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findFastestFailures } from '../scripts/bench/fastest.mjs';

const names = ['ours', 'theirs', 'other'];
const check = (results) => findFastestFailures(results, names, 'ours');

test('passes when every rival is slower', () => {
  assert.deepEqual(
    check([
      { name: 'ours', hz: 300 },
      { name: 'theirs', hz: 200 },
      { name: 'other', hz: 100 },
    ]),
    [],
  );
});

test('names each faster rival', () => {
  assert.deepEqual(
    check([
      { name: 'ours', hz: 100 },
      { name: 'theirs', hz: 150 },
      { name: 'other', hz: 90 },
    ]),
    ['theirs is 1.50x faster than ours: 150 vs 100 ops/sec'],
  );
});

test('a tie is not slower', () => {
  assert.deepEqual(
    check([
      { name: 'ours', hz: 100 },
      { name: 'theirs', hz: 100 },
      { name: 'other', hz: 50 },
    ]),
    [],
  );
});

test('a rival with no result fails, so a router that drops out is not beaten', () => {
  assert.deepEqual(
    check([
      { name: 'ours', hz: 300 },
      { name: 'other', hz: 100 },
    ]),
    ['theirs has no result'],
  );
});

test('a result of zero is no result', () => {
  assert.deepEqual(
    check([
      { name: 'ours', hz: 300 },
      { name: 'theirs', hz: 0 },
      { name: 'other', hz: 100 },
    ]),
    ['theirs has no result'],
  );
});

test('no result for the target fails', () => {
  assert.deepEqual(
    check([
      { name: 'theirs', hz: 200 },
      { name: 'other', hz: 100 },
    ]),
    ['ours has no result'],
  );
});
