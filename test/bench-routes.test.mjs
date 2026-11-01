import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const routesUrl = new URL('../bench/routes.mjs', import.meta.url).href;
const report = `
  const { routes, precomputedUrls, routesSource, urlsSource } = await import(${JSON.stringify(routesUrl)});
  console.log(JSON.stringify({ routes: routes.length, urls: precomputedUrls?.length, routesSource, urlsSource, rest: process.argv.slice(1) }));
`;
const flagsUrl = new URL('../bench/flags.mjs', import.meta.url).href;
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const dir = mkdtempSync(join(tmpdir(), 'bench-routes-'));
const route = '{ path: "/a", count: 1, concretePaths: ["/a"], generateUrl: () => "/a" }';
writeFileSync(join(dir, 'routes-paired.mjs'), `export const routes = [${route}];`);
writeFileSync(join(dir, 'routes-paired.urls.mjs'), 'export const precomputedUrls = ["/a", "/a"];');
writeFileSync(join(dir, 'routes-unpaired.mjs'), `export const routes = [${route}, ${route}];`);
writeFileSync(join(dir, 'other.urls.mjs'), 'export const precomputedUrls = ["/b", "/b", "/b"];');
writeFileSync(join(dir, 'no-routes.mjs'), 'export const nothing = [];');

function nodeArgs(script, flags) {
  return ['--input-type=module', '-e', script, '--', ...flags];
}

function load(flags) {
  const output = execFileSync(process.execPath, nodeArgs(report, flags), { cwd: dir, encoding: 'utf8' });
  return JSON.parse(output);
}

function runError(script, flags) {
  const result = spawnSync(process.execPath, nodeArgs(script, flags), { cwd: dir, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  return result.stderr;
}

test('--routes loads a module and the URLs next to it', () => {
  assert.deepEqual(load(['--routes', './routes-paired.mjs']), {
    routes: 1,
    urls: 2,
    routesSource: 'routes-paired.mjs',
    urlsSource: 'routes-paired.urls.mjs',
    rest: [],
  });
});

test('no flag means the generic set and its URLs', () => {
  const loaded = load([]);
  assert.match(loaded.routesSource, /routes-generic\.mjs$/);
  assert.match(loaded.urlsSource, /routes-generic\.urls\.mjs$/);
});

test('--urls overrides the URLs of a route set', () => {
  const loaded = load(['--routes', './routes-paired.mjs', '--urls', './other.urls.mjs']);
  assert.equal(loaded.routesSource, 'routes-paired.mjs');
  assert.equal(loaded.urlsSource, 'other.urls.mjs');
});

test('a module with no URLs generates them, and never borrows the generic ones', () => {
  const loaded = load(['--routes', './routes-unpaired.mjs']);
  assert.equal(loaded.urls, undefined);
  assert.equal(loaded.urlsSource, 'generated from the routes');
});

test('route flags leave positional arguments alone', () => {
  const loaded = load(['tail-lazy', '--routes', './routes-paired.mjs', 'fresh', '--urls', './other.urls.mjs']);
  assert.deepEqual(loaded.rest, ['tail-lazy', 'fresh']);
});

test('a bad route set fails the run, and never falls back to generic', () => {
  assert.match(runError(report, ['--routes', './missing.mjs']), /missing\.mjs does not exist/);
  assert.match(runError(report, ['--routes', 'missing']), /routes-missing\.mjs does not exist/);
  assert.match(runError(report, ['--routes', './no-routes.mjs']), /no exported "routes" array/);
  assert.match(runError(report, ['--routes']), /--routes needs a value/);
  assert.match(runError(report, ['--routes', '--json']), /--routes needs a value/);
});

test('number flags reject anything that is not a number', () => {
  const script = `
    const { takeNumberFlag } = await import(${JSON.stringify(flagsUrl)});
    takeNumberFlag('--time', 1);
  `;
  assert.match(runError(script, ['--time', 'soon']), /--time takes a number, not "soon"/);
});

test('package scripts set no environment variables', () => {
  const { scripts } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  for (const [name, command] of Object.entries(scripts)) {
    assert.doesNotMatch(command, /^[A-Z_]+=/, name);
  }
});
