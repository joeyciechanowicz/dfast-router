/**
 * Differential test: the router must agree with bench/reference.mjs on route and params.
 *
 * Runs a sample under `npm test`, and everything with FULL_CORPUS=1 (`npm run test:consistency`).
 * DIFF_TARGET=prototype checks prototype/ instead, on the bench route sets only, because the
 * prototype has no methods, wildcards, aliases, or regex routes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createReference } from '../bench/reference.mjs';
import { methods, neverWin, routes as overlapRoutes, urls as overlapUrls } from './fixtures/routes-overlap.mjs';
import { compare, countOverlaps, mutate } from './helpers/differential.mjs';

const FULL = process.env.FULL_CORPUS === '1';
const PROTOTYPE = process.env.DIFF_TARGET === 'prototype';
const SAMPLE_URLS = 40_000;
const SAMPLE_MUTATIONS = 10_000;
const FULL_MUTATIONS = 400_000;

async function routerTarget(routes) {
  const { createRouter } = await import('../src/index.ts');
  const router = createRouter();
  routes.forEach((route, id) => {
    router.on(route.method ?? 'GET', route.path, () => {}, { route: id });
  });
  return (method, url) => {
    const match = router.find(method, url);
    return match === null ? null : { route: match.store.route, params: match.params };
  };
}

async function prototypeTarget(routes) {
  const { buildFast, compile } = await import('../prototype/rc.mjs');
  const patterns = routes.flatMap((route, id) => route.concretePaths.map((path) => ({ path, route: id })));
  const stores = routes.map((_, id) => ({ route: id }));
  const options = { train: [], mode: 'lazy', gallop: 8, after: 8, tail: true };
  const find = buildFast(compile(patterns, { acceptByPattern: true }), stores, options);
  return (_, url) => {
    const match = find(url);
    return match === null ? null : { route: match.store.route, params: match.params };
  };
}

function lookupsFor(corpus) {
  const unique = [...new Set(corpus)];
  const stride = FULL ? 1 : Math.max(1, Math.floor(unique.length / SAMPLE_URLS));
  const sample = unique.filter((_, i) => i % stride === 0);
  const urls = [...sample, ...mutate(unique, FULL ? FULL_MUTATIONS : SAMPLE_MUTATIONS)];
  // The prototype leaves path normalization to its caller.
  const usable = PROTOTYPE ? urls.filter((url) => url[0] === '/') : urls;
  return usable.map((url) => ({ method: 'GET', url }));
}

function assertAgrees(result) {
  const shown = JSON.stringify(result.mismatches.slice(0, 5), null, 1);
  assert.equal(result.mismatches.length, 0, `${result.mismatches.length} of ${result.checked} differ: ${shown}`);
}

async function checkRouteSet(routes, corpus) {
  const find = await (PROTOTYPE ? prototypeTarget : routerTarget)(routes);
  const result = compare(find, routes, lookupsFor(corpus));
  console.log(`checked ${result.checked}, ${result.hits} hits, ${result.mismatches.length} mismatches`);
  assertAgrees(result);
  assert.ok(result.hits > result.checked / 2, 'too few hits to mean anything');
}

const overlapLookups = () => overlapUrls().flatMap((url) => methods.map((method) => ({ method, url })));

test('bench route set: generic', async () => {
  const { routes, precomputedUrls } = await import('../bench/routes-generic.mjs');
  await checkRouteSet(routes, precomputedUrls);
});

const specificRoutes = new URL('../bench/routes-specific.mjs', import.meta.url);
const specificUrls = new URL('../bench/routes-specific.urls.mjs', import.meta.url);
const specificSkip = existsSync(specificRoutes) && existsSync(specificUrls)
  ? false
  : 'bench/routes-specific.mjs is git-ignored and not present';

test('bench route set: specific', { skip: specificSkip }, async () => {
  const { routes } = await import(specificRoutes.href);
  const { precomputedUrls } = await import(specificUrls.href);
  await checkRouteSet(routes, precomputedUrls);
});

test('overlapping route set', { skip: PROTOTYPE ? 'the prototype uses registration order' : false }, async () => {
  const find = await routerTarget(overlapRoutes);
  const result = compare(find, overlapRoutes, overlapLookups());
  console.log(`checked ${result.checked}, ${result.hits} hits, ${result.mismatches.length} mismatches`);
  assertAgrees(result);
});

test('the overlapping set really does overlap, and every rule decides something', () => {
  const lookups = overlapLookups();
  const overlaps = countOverlaps(overlapRoutes, lookups);
  console.log(`${overlaps} of ${lookups.length} lookups match more than one route`);
  assert.ok(overlaps > 200, `only ${overlaps} lookups overlap`);

  const reference = createReference(overlapRoutes);
  const winners = new Set();
  for (const { method, url } of lookups) {
    const found = reference(url, method);
    if (found !== null) winners.add(found.route);
  }
  const lost = overlapRoutes.map((_, id) => id).filter((id) => !winners.has(id));
  assert.deepEqual(lost, neverWin, `never won: ${lost.map((id) => String(overlapRoutes[id].path))}`);
});

// The harness has to be able to fail. A reference is a correct router, so break one on purpose.
const asTarget = (reference) => (method, url) => reference(url, method);

test('the harness passes a correct router', () => {
  const lookups = overlapLookups();
  const result = compare(asTarget(createReference(overlapRoutes)), overlapRoutes, lookups);
  assert.equal(result.mismatches.length, 0);
  assert.ok(result.hits > 1000);
});

test('the harness catches one wrong param', () => {
  const correct = createReference(overlapRoutes);
  const broken = (method, url) => {
    const found = correct(url, method);
    if (url !== '/u/abc' || found === null) return found;
    return { ...found, params: { a: 'wrong' } };
  };
  const { mismatches } = compare(broken, overlapRoutes, overlapLookups());
  assert.ok(mismatches.length > 0);
  assert.ok(mismatches.every(({ url }) => url === '/u/abc'));
});

test('the harness catches one swapped priority', () => {
  const winner = overlapRoutes.findIndex((route) => route.path === '/items/all');
  const without = overlapRoutes.map((route, id) => (id === winner ? { ...route, concretePaths: [] } : route));
  const { mismatches } = compare(asTarget(createReference(without)), overlapRoutes, overlapLookups());
  assert.ok(mismatches.length > 0);
  assert.ok(mismatches.every(({ want }) => want.route === winner));
});

test('the harness catches a router using registration order', () => {
  const lookups = overlapLookups();
  const each = overlapRoutes.map((route) => createReference([route]));
  const firstRegistered = (method, url) => {
    for (let id = 0; id < each.length; id += 1) {
      const found = each[id](url, method);
      if (found !== null) return { route: id, params: found.params };
    }
    return null;
  };
  const { mismatches } = compare(firstRegistered, overlapRoutes, lookups);
  assert.ok(mismatches.length > 100, `only ${mismatches.length} differ`);
});
