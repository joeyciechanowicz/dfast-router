import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createReference } from '../../bench/reference.mjs';
import { buildExtractor } from '../../src/compiler/extract';
import { compareRank, parsePattern, variantAst, variantRegExp } from '../../src/compiler/pattern';
import { NON_ASCII } from '../../src/compiler/types';
import { parseFragment } from '../../src/compiler/regex-parser';
import type { Ast, ParseFragment, Variant } from '../../src/compiler/types';

const parse: ParseFragment = parseFragment;

const UUID = '550e8400-e29b-41d4-a716-446655440000';

const STATIC = (value: string) => ({ kind: 'static', value });
const PARAM = (name: string, source: string | null = null, score = 0) => ({ kind: 'param', name, source, score });
const WILDCARD = (name: string) => ({ kind: 'wildcard', name });

const only = (pattern: string): Variant => {
  const variants = parsePattern(pattern);
  assert.equal(variants.length, 1, pattern);
  return variants[0];
};

/**
 * The router's rules, built from this module's exports: variants merged by key, sorted by rank, and
 * scanned with variantRegExp. It stands in for WP-8 so these tests can compare with the reference.
 */
function tableOf(patterns: string[]) {
  const byKey = new Map<string, { variant: Variant; route: number }>();
  patterns.forEach((pattern, route) => {
    for (const variant of parsePattern(pattern)) byKey.set(variant.key, { variant, route });
  });
  const entries = [...byKey.values()]
    .sort((a, b) => compareRank(a.variant, b.variant))
    .map(({ variant, route }) => ({
      route,
      regex: variantRegExp(variant),
      extract: buildExtractor(variant, parse),
    }));
  return (url: string) => {
    const query = url.indexOf('?');
    const end = query === -1 ? url.length : query;
    const path = url.slice(0, end);
    for (const { route, regex, extract } of entries) {
      if (regex.test(path)) return { route, params: extract === null ? {} : extract(url, end) };
    }
    return null;
  };
}

const paramsOf = (pattern: string, url: string) => tableOf([pattern])(url)?.params;
const routeOf = (patterns: string[], url: string) => tableOf(patterns)(url)?.route ?? null;

function assertBeats(high: string, low: string, url: string) {
  assert.equal(routeOf([high, low], url), 0, `${high} before ${low} on ${url}`);
  assert.equal(routeOf([low, high], url), 1, `${low} before ${high} on ${url}`);
}

/** Whether the AST accepts `path`, read by code unit as the DFA reads it. */
function accepts(ast: Ast, path: string): boolean {
  const symbol = (i: number) => Math.min(path.charCodeAt(i), NON_ASCII);
  const step = (node: Ast, from: Set<number>): Set<number> => {
    if (node.t === 'set') {
      const to = new Set<number>();
      for (const p of from) if (p < path.length && node.set[symbol(p)] === 1) to.add(p + 1);
      return to;
    }
    if (node.t === 'cat') return node.xs.reduce((at, x) => step(x, at), from);
    if (node.t === 'alt') return new Set(node.xs.flatMap((x) => [...step(x, from)]));
    let at = from;
    for (let i = 0; i < node.min; i += 1) at = step(node.x, at);
    const reached = new Set(at);
    for (let i = node.min; i < node.max && at.size > 0; i += 1) {
      at = new Set([...step(node.x, at)].filter((p) => !reached.has(p)));
      for (const p of at) reached.add(p);
    }
    return reached;
  };
  return step(ast, new Set([0])).has(path.length);
}

function astOf(variant: Variant): Ast {
  const parsed = variantAst(variant, parse);
  assert.ok(parsed.ok);
  return parsed.ast;
}

function seededRng(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

test('segments: static text, params, regex params, and aliases', () => {
  assert.deepEqual(only('/a/:b/:c(\\d+)/:d#int').segments, [
    STATIC('a'),
    PARAM('b'),
    PARAM('c', '\\d+', 10),
    PARAM('d', '[0-9]+', 40),
  ]);
  assert.deepEqual(only('/a/:b/:c(\\d+)/:d#int').rank, [100, 0, 10, 40]);
});

test('segments: a slash inside a param regex does not split the segment', () => {
  assert.deepEqual(only('/x/:v([^/]+)/end').segments, [STATIC('x'), PARAM('v', '[^/]+', 10), STATIC('end')]);
  assert.deepEqual(only('/:v((a/b)|c)/z').segments, [PARAM('v', '(a/b)|c', 10), STATIC('z')]);
  assert.deepEqual(only('/:v(a\\/b)/z').segments, [PARAM('v', 'a\\/b', 10), STATIC('z')]);
  assert.deepEqual(only('/:v([)/]+)/z').segments, [PARAM('v', '[)/]+', 10), STATIC('z')]);
});

test('segments: text that only looks like syntax stays static', () => {
  assert.deepEqual(only('/a:b').segments, [STATIC('a:b')]);
  assert.deepEqual(only('/a*').segments, [STATIC('a*')]);
  assert.deepEqual(only('/items?').segments, [STATIC('items?')]);
  assert.deepEqual(only('/(a|b)?').segments, [STATIC('(a|b)?')]);
});

test('root: a leading slash is added, and an empty pattern is the root', () => {
  assert.deepEqual(only('').segments, [STATIC('')]);
  assert.deepEqual(only('/').segments, [STATIC('')]);
  assert.equal(only('').key, only('/').key);
  assert.equal(only('status').key, only('/status').key);
  assert.deepEqual(only('/').rank, [100]);
  assert.equal(routeOf([''], '/'), 0);
  assert.equal(routeOf(['status'], '/status'), 0);
});

test('root: an optional first segment leaves the root', () => {
  const [root, present] = parsePattern('/:id?');
  assert.deepEqual(root.segments, [STATIC('')]);
  assert.deepEqual(root.rank, [100]);
  assert.deepEqual(present.segments, [PARAM('id')]);
  assert.deepEqual(paramsOf('/:id?', '/'), {});
  assert.deepEqual(paramsOf('/:id?', '/7'), { id: '7' });
});

test('paths: trailing and double slashes are significant (D2)', () => {
  assert.deepEqual(only('/items/').segments, [STATIC('items'), STATIC('')]);
  assert.deepEqual(only('/a//b').segments, [STATIC('a'), STATIC(''), STATIC('b')]);
  assert.equal(routeOf(['/items'], '/items/'), null);
  assert.equal(routeOf(['/items/'], '/items'), null);
  assert.equal(routeOf(['/items/'], '/items/'), 0);
  assert.equal(routeOf(['/a/b'], '/a//b'), null);
});

test('(a|b) expands in order, across segments', () => {
  assert.deepEqual(parsePattern('/(a|b)/c/(d|e)').map((v) => v.segments), [
    [STATIC('a'), STATIC('c'), STATIC('d')],
    [STATIC('a'), STATIC('c'), STATIC('e')],
    [STATIC('b'), STATIC('c'), STATIC('d')],
    [STATIC('b'), STATIC('c'), STATIC('e')],
  ]);
});

test(':x? adds its shorter variant first', () => {
  assert.deepEqual(parsePattern('/a/:b?/:c?').map((v) => v.segments), [
    [STATIC('a')],
    [STATIC('a'), PARAM('c')],
    [STATIC('a'), PARAM('b')],
    [STATIC('a'), PARAM('b'), PARAM('c')],
  ]);
  assert.deepEqual(parsePattern('/a/:b(\\d+)?').map((v) => v.segments), [
    [STATIC('a')],
    [STATIC('a'), PARAM('b', '\\d+', 10)],
  ]);
});

test('a repeated variant appears once, in its first position', () => {
  assert.deepEqual(parsePattern('/(a|b|a)').map((v) => v.segments), [[STATIC('a')], [STATIC('b')]]);
  assert.deepEqual(parsePattern('/:a?/:a?').map((v) => v.rank), [[100], [0], [0, 0]]);
});

test('wildcards: /files/* gives { "*": rest }, and /assets/:path* gives { path: rest }', () => {
  assert.deepEqual(paramsOf('/files/*', '/files/a/b/c'), { '*': 'a/b/c' });
  assert.deepEqual(paramsOf('/assets/:path*', '/assets/css/app.css'), { path: 'css/app.css' });
  assert.deepEqual(paramsOf('/*', '/a/b'), { '*': 'a/b' });
});

test('wildcards: /files/:path* also matches /files, with { path: "" }', () => {
  const [empty, whole] = parsePattern('/files/:path*');
  assert.deepEqual(empty.segments, [STATIC('files')]);
  assert.deepEqual(empty.defaults, { path: '' });
  assert.deepEqual(whole.segments, [STATIC('files'), WILDCARD('path')]);
  assert.deepEqual(whole.defaults, {});

  assert.deepEqual(paramsOf('/files/:path*', '/files'), { path: '' });
  assert.deepEqual(paramsOf('/files/*', '/files'), { '*': '' });
  assert.equal(routeOf(['/files/:path*'], '/filesystem'), null);
});

test('wildcards: /files/ matches /files/:path* with { path: "" }, because the rest is [^?]*', () => {
  assert.deepEqual(paramsOf('/files/:path*', '/files/'), { path: '' });
  assert.deepEqual(paramsOf('/files/*', '/files/'), { '*': '' });
  assert.deepEqual(paramsOf('/files/:path*', '/files//a/'), { path: '/a/' });
});

test('wildcards: end the pattern', () => {
  assert.deepEqual(parsePattern('/a/:first*/b/:second*').map((v) => v.segments), [
    [STATIC('a')],
    [STATIC('a'), WILDCARD('first')],
  ]);
  assert.deepEqual(paramsOf('/a/:first*/b/:second*', '/a/one/two/b/three/four'), {
    first: 'one/two/b/three/four',
  });
  assert.deepEqual(parsePattern('/a/*/b').map((v) => v.segments), [[STATIC('a')], [STATIC('a'), WILDCARD('*')]]);
});

test('wildcards: stop at the query string', () => {
  assert.deepEqual(paramsOf('/files/*', '/files/a/b?x=/c'), { '*': 'a/b' });
  assert.deepEqual(paramsOf('/files/*', '/files?x=/c'), { '*': '' });
});

test('wildcards: a leading wildcard has no empty variant, and still holds the root', () => {
  const root = only('/*');
  assert.deepEqual(root.segments, [WILDCARD('*')]);
  assert.deepEqual(paramsOf('/*', '/'), { '*': '' });
  assert.equal(accepts(astOf(root), ''), false);

  assert.deepEqual(parsePattern('/:a?/*').map((v) => v.segments), [
    [WILDCARD('*')],
    [PARAM('a')],
    [PARAM('a'), WILDCARD('*')],
  ]);
});

test('wildcards: a `?` after the name changes nothing', () => {
  assert.equal(only('/*').key, only('/:*').key.replace('""', '"*"'));
  assert.deepEqual(parsePattern('/a/:b*?').map((v) => v.key), parsePattern('/a/:b*').map((v) => v.key));
});

test('wildcards: the empty match keeps the -100, and loses to /files either way', () => {
  const [empty, whole] = parsePattern('/files/:path*');
  assert.deepEqual(empty.rank, [100, -100]);
  assert.deepEqual(whole.rank, [100, -100]);
  assert.ok(compareRank(only('/files'), empty) < 0);
  assertBeats('/files', '/files/:path*', '/files');
  assertBeats('/files', '/files/*', '/files');
  assert.deepEqual(tableOf(['/files', '/files/:path*'])('/files'), { route: 0, params: {} });
});

test('aliases: each compiles to its table regex and score', () => {
  const table: [string, string, number][] = [
    ['int', '[0-9]+', 40],
    ['alpha', '[A-Za-z]+', 25],
    ['slug', '[A-Za-z0-9-]+', 20],
    ['locale', '[a-z]{2}-[A-Z]{2}', 30],
    ['uuid', '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', 35],
  ];
  for (const [alias, source, score] of table) {
    assert.deepEqual(only(`/:v#${alias}`).segments, [PARAM('v', source, score)], alias);
    assert.deepEqual(only(`/:v#${alias}`).rank, [score], alias);
  }
});

test('aliases: each matches what its regex matches, and only that', () => {
  const cases: [string, string, string[]][] = [
    ['int', '0123', ['12a', 'a', '1.5', '']],
    ['alpha', 'aBc', ['alice-1', 'a1', '']],
    ['slug', 'hello-World-2', ['hello_world', 'a.b', '']],
    ['locale', 'en-US', ['en-us', 'EN-US', 'eng-US', '']],
    ['uuid', UUID, ['not-a-uuid', `${UUID}0`, UUID.replace(/-/g, ''), '']],
  ];
  for (const [alias, good, bads] of cases) {
    assert.deepEqual(paramsOf(`/x/:v#${alias}`, `/x/${good}`), { v: good }, alias);
    assert.equal(accepts(astOf(only(`/x/:v#${alias}`)), `/x/${good}`), true, alias);
    for (const bad of bads) {
      assert.equal(paramsOf(`/x/:v#${alias}`, `/x/${bad}`), undefined, `${alias}: ${bad}`);
      assert.equal(accepts(astOf(only(`/x/:v#${alias}`)), `/x/${bad}`), false, `${alias}: ${bad}`);
    }
  }
});

test('aliases: can be optional', () => {
  for (const [alias, good, bad] of [
    ['int', '123', 'abc'],
    ['alpha', 'abc', '123'],
    ['slug', 'a-1', 'a_1'],
    ['locale', 'en-GB', 'english'],
    ['uuid', UUID, 'abc'],
  ]) {
    const pattern = `/users/:id#${alias}?`;
    assert.equal(parsePattern(pattern).length, 2, alias);
    assert.deepEqual(paramsOf(pattern, '/users'), {}, alias);
    assert.deepEqual(paramsOf(pattern, `/users/${good}`), { id: good }, alias);
    assert.equal(paramsOf(pattern, `/users/${bad}`), undefined, alias);
  }
});

test('aliases: an unknown alias throws', () => {
  assert.throws(() => parsePattern('/users/:id#doesnotexist'), /Unknown validator alias/);
  assert.throws(() => parsePattern('/users/:id#doesnotexist?'), /Unknown validator alias/);
  assert.throws(() => parsePattern('/users/:id#constructor'), /Unknown validator alias/);
  assert.throws(() => parsePattern('/users/:id#'), /Unknown validator alias/);
  assert.throws(() => parsePattern('/users/:id#Int'), /Unknown validator alias/);
});

test('rank: every kind of segment gets its score', () => {
  assert.deepEqual(parsePattern('/a/:b/:c(x)/*')[1].rank, [100, 0, 10, -100]);
  const ladder = ['/s', '/:v#int', '/:v#uuid', '/:v#locale', '/:v#alpha', '/:v#slug', '/:v(x)', '/:v', '/*'];
  const scores = ladder.map((pattern) => only(pattern).rank[0]);
  assert.deepEqual(scores, [100, 40, 35, 30, 25, 20, 10, 0, -100]);
});

test('compareRank: higher wins, and the first difference decides', () => {
  assert.ok(compareRank(only('/a'), only('/:v')) < 0);
  assert.ok(compareRank(only('/:v'), only('/a')) > 0);
  assert.ok(compareRank(only('/s/:b'), only('/:a/s')) < 0);
  assert.ok(compareRank(only('/x/:a#int/:b'), only('/x/:a/:b#int')) < 0);
  assert.equal(compareRank(only('/u/:a'), only('/u/:b')), 0);
});

test('compareRank: a shorter rank counts its missing entries as 0', () => {
  assert.equal(compareRank(only('/:a'), only('/:a/:b')), 0);
  assert.ok(compareRank(only('/a'), only('/a/b')) > 0);
  assert.ok(compareRank(only('/a'), only('/a/:b#int')) > 0);
  assert.ok(compareRank(only('/a'), parsePattern('/a/*')[1]) < 0);
});

test('priority: the same ladder as the contract, in either registration order', () => {
  const ladder = [
    [':v#int', ':v#slug', '123'],
    [':v#uuid', ':v#slug', UUID],
    [':v#locale', ':v#slug', 'en-GB'],
    [':v#alpha', ':v#slug', 'abc'],
    [':v#slug', ':v(.+)', 'abc'],
    [':v(.+)', ':v', 'abc'],
    [':v', ':v*', 'abc'],
    [':v', '*', 'abc'],
    ['abc', ':v#int?', 'abc'],
  ];
  for (const [high, low, value] of ladder) assertBeats(`/x/${high}`, `/x/${low}`, `/x/${value}`);
});

test('priority: ties stay in registration order, because compareRank returns 0', () => {
  assert.equal(routeOf(['/u/:a', '/u/:b'], '/u/1'), 0);
  assert.equal(routeOf(['/x/*', '/x/:rest*'], '/x/a/b'), 0);
  assert.equal(routeOf(['/a/:x(.+)', '/a/:y(.+)/:z'], '/a/q/b'), 0);
  assert.equal(routeOf(['/a/:y(.+)/:z', '/a/:x(.+)'], '/a/q/b'), 0);
});

test('key: repeat registrations and shared variants share one', () => {
  assert.equal(only('/u/:a').key, only('/u/:a').key);
  assert.equal(parsePattern('/u/:a?')[1].key, only('/u/:a').key);
  assert.equal(parsePattern('/u/:a?')[0].key, only('/u').key);
  assert.equal(parsePattern('/(a|b)')[1].key, only('/b').key);
  assert.equal(parsePattern('/u/:a#int?')[1].key, only('/u/:a#int').key);
  assert.deepEqual(parsePattern('/f/:p*').map((v) => v.key), parsePattern('/f/:p*').map((v) => v.key));
});

test('key: a root left by an optional is the root', () => {
  assert.equal(parsePattern('/:id?')[0].key, only('/').key);
});

test('key: differs when the language, the params, or the score differ', () => {
  const distinct = [
    '/u/:a',
    '/u/:b',
    '/u/:a(.+)',
    '/u/:a(.*)',
    '/u/:a#int',
    '/u/:a([0-9]+)',
    '/u/a',
    '/u/:a/',
    '/u/*',
    '/u/:a*',
    '/u/:b*',
  ];
  const keys = distinct.flatMap((pattern) => parsePattern(pattern).map((v) => v.key));
  assert.equal(new Set(keys).size, keys.length);
});

test('key: a wildcard empty match is not the static route with the same language', () => {
  const [empty, whole] = parsePattern('/files/:path*');
  assert.notEqual(empty.key, only('/files').key);
  assert.notEqual(empty.key, parsePattern('/files/*')[0].key);
  assert.notEqual(empty.key, whole.key);
});

test('key: replaces per variant, as D11 asks', () => {
  assert.equal(routeOf(['/same', '/same'], '/same'), 1);
  assert.equal(routeOf(['/u/:a', '/u/:b', '/u/:a'], '/u/1'), 2);
  assert.equal(routeOf(['/u/:a?', '/u/:a'], '/u/1'), 1);
  assert.equal(routeOf(['/a/:x?', '/a'], '/a'), 1);
  assert.equal(routeOf(['/a', '/a/:x?'], '/a'), 1);
  assert.equal(routeOf(['/a/:x?', '/a'], '/a/1'), 0);
  assert.equal(routeOf(['/:x?', '/'], '/'), 1);
  assert.equal(routeOf(['/', '/:x?'], '/'), 1);
});

test('limit: 256 variants are fine, and 257 or more throw (D9)', () => {
  const doubling = (n: number) => '/(a|b)'.repeat(n);
  assert.equal(parsePattern(doubling(8)).length, 256);
  assert.throws(() => parsePattern(doubling(9)), /256 variants/);

  const optionals = (n: number) => Array.from({ length: n }, (_, i) => `/:p${i}?`).join('');
  assert.equal(parsePattern(optionals(8)).length, 256);
  assert.throws(() => parsePattern(optionals(9)), /256 variants/);
});

test('limit: counts wildcard empty matches, and alternatives wider than the limit', () => {
  assert.equal(parsePattern(`${'/(a|b)'.repeat(7)}/*`).length, 256);
  assert.throws(() => parsePattern(`${'/(a|b)'.repeat(8)}/*`), /256 variants/);
  const wide = (n: number) => `/(${Array.from({ length: n }, (_, i) => `c${i}`).join('|')})`;
  assert.equal(parsePattern(wide(256)).length, 256);
  assert.throws(() => parsePattern(wide(257)), /256 variants/);
});

test('variantRegExp: anchored at both ends', () => {
  const regex = variantRegExp(only('/a/:id'));
  assert.equal(regex.test('/a/1'), true);
  assert.equal(regex.test('/a/1/'), false);
  assert.equal(regex.test('x/a/1'), false);
  assert.equal(regex.test('/a/'), false);
  assert.equal(regex.test('/a/1\n'), true); // a param takes any character but `/` and `?`
  assert.equal(variantRegExp(only('/a')).test('/a\n'), false);
  assert.equal(variantRegExp(only('/a')).test('/a\n/b'), false);
});

test('variantRegExp: escapes every regex metacharacter in static text', () => {
  for (const text of ['a.b', 'a+b', 'a*b', 'a(b)', '[a]', '{1}', 'a|b', 'a^b', 'a$b', 'a\\b', 'a-b', '.*']) {
    const variant = only(`/${text}`);
    assert.equal(variant.segments.length, 1);
    assert.equal(variantRegExp(variant).test(`/${text}`), true, text);
    assert.equal(variantRegExp(variant).test('/axb'), false, text);
    assert.equal(variantRegExp(variant).test('/ab'), false, text);
  }
});

test('variantRegExp: a regex param keeps its alternation inside its segment', () => {
  const regex = variantRegExp(only('/x/:v(a|ab)/z'));
  assert.equal(regex.test('/x/a/z'), true);
  assert.equal(regex.test('/x/ab/z'), true);
  assert.equal(regex.test('/x/a'), false);
  assert.equal(regex.test('ab/z'), false);
  assert.equal(variantRegExp(only('/x/:v(a|ab)')).test('/x/abc'), false);
});

test('variantRegExp: wildcard variants are exact, and do not overlap each other', () => {
  const [empty, whole] = parsePattern('/files/:path*').map(variantRegExp);
  assert.equal(empty.test('/files'), true);
  assert.equal(empty.test('/files/'), false);
  assert.equal(whole.test('/files'), false);
  assert.equal(whole.test('/files/'), true);
  assert.equal(whole.test('/files/a/b'), true);
  assert.equal(whole.test('/filesystem'), false);
});

test('variantRegExp: exact above ASCII, where the DFA only over-accepts (D10)', () => {
  const cafe = only('/café');
  assert.equal(variantRegExp(cafe).test('/café'), true);
  assert.equal(variantRegExp(cafe).test('/cafü'), false);
  assert.equal(accepts(astOf(cafe), '/cafü'), true);

  const dot = only('/x/:v(.+)');
  assert.equal(variantRegExp(dot).test('/x/é'), true);
  assert.equal(variantRegExp(dot).test('/x/ '), false);
  assert.equal(accepts(astOf(dot), '/x/ '), true);

  const ascii = only('/x/:v([a-z]+)');
  assert.equal(variantRegExp(ascii).test('/x/é'), false);
  assert.equal(accepts(astOf(ascii), '/x/é'), false);
});

test('variantRegExp: each variant of every shape is exact', () => {
  const positive: [string, string][] = [
    ['/', '/'],
    ['/a/', '/a/'],
    ['/😀', '/😀'],
    ['/a/:b?/c', '/a/c'],
    ['/a/:b?/c', '/a/1/c'],
    ['/(x|y)/z', '/y/z'],
    ['/:v#uuid', `/${UUID}`],
    ['/*', '/'],
    ['/*', '/a/b'],
  ];
  for (const [pattern, path] of positive) {
    assert.ok(parsePattern(pattern).some((v) => variantRegExp(v).test(path)), `${pattern} on ${path}`);
  }
});

test('variantAst: static text is one symbol per code unit', () => {
  const emoji = only('/😀');
  assert.equal(accepts(astOf(emoji), '/😀'), true);
  assert.equal(accepts(astOf(emoji), '/é'), false);
  const parsed = variantAst(emoji, parse);
  assert.ok(parsed.ok);
  assert.ok(parsed.ast.t === 'cat');
  assert.equal(parsed.ast.xs.length, 3);
});

test('variantAst: names lists the captures in order', () => {
  const parsed = variantAst(parsePattern('/:a/x/:b(.+)/:c*')[1], parse);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.names, ['a', 'b', 'c']);
});

test('variantAst: passes on a fragment the parser refuses', () => {
  const refuse: ParseFragment = () => ({ ok: false, reason: 'lookahead' });
  assert.deepEqual(variantAst(only('/a/:b(?=x)'), refuse), { ok: false, reason: 'lookahead' });
  assert.equal(variantAst(only('/a/:b'), refuse).ok, true);
});

test('variantAst: agrees with variantRegExp on ASCII', () => {
  const patterns = [
    '/',
    '/a',
    '/a/',
    '/a//b',
    '/:v',
    '/a/:v?',
    '/(a|b)/:v',
    '/a.b',
    '/x/:v#int',
    '/x/:v#alpha',
    '/x/:v#slug',
    '/x/:v#locale',
    '/x/:v(.+)',
    '/x/:v([^/]+)/end',
    '/x/:v([^z]+)/end',
    '/x/:v(a|ab)',
    '/x/:v([0-9]{2,4})/y',
    '/*',
    '/a/*',
    '/a/:rest*',
    '/:a/:b*',
    '/a/:v(.+)/*',
  ];
  const paths = [
    '',
    '/',
    '//',
    '/a',
    '/a/',
    '/a//',
    '/a//b',
    '/b',
    '/b/1',
    '/a/1',
    '/a.b',
    '/axb',
    '/x',
    '/x/',
    '/x/1',
    '/x/12',
    '/x/12345',
    '/x/12/y',
    '/x/a',
    '/x/ab',
    '/x/abc',
    '/x/a-b',
    '/x/en-GB',
    '/x/a/end',
    '/x/a/b/end',
    '/x/z/end',
    '/a/b/c',
    '/a/b/',
    '/x/a/%20/~',
  ];
  let matches = 0;
  for (const pattern of patterns) {
    for (const variant of parsePattern(pattern)) {
      const ast = astOf(variant);
      const regex = variantRegExp(variant);
      for (const path of paths) {
        assert.equal(accepts(ast, path), regex.test(path), `${pattern} on ${path}`);
        if (regex.test(path)) matches += 1;
      }
    }
  }
  assert.ok(matches > 60, `only ${matches} matches, so this proves little`);
});

const SEGMENTS = [
  'a',
  'b',
  'é',
  '',
  '(a|b)',
  ':x',
  ':y',
  ':n#int',
  ':s#slug',
  ':v(.+)',
  ':c([^/]+)',
  ':f([0-9]{2})',
  ':t(x|x/y)',
  ':l(.+?)',
  ':o?',
  ':p#int?',
  ':w*',
  '*',
];
const PIECES = ['a', 'b', 'é', '12', 'x', 'x/y', 'abc-d', ''];

function randomPattern(rng: () => number): string {
  const count = 1 + Math.floor(rng() * 4);
  const out: string[] = [];
  while (out.length < count) {
    const segment = SEGMENTS[Math.floor(rng() * SEGMENTS.length)];
    // See "key: a root left by an optional is the root": the reference gives that root its own key.
    const previous = out[out.length - 1];
    if (segment === '' && (previous === undefined || previous.endsWith('?'))) continue;
    out.push(segment);
  }
  return `/${out.join('/')}`;
}

function randomUrl(rng: () => number): string {
  const count = 1 + Math.floor(rng() * 5);
  const pieces = Array.from({ length: count }, () => PIECES[Math.floor(rng() * PIECES.length)]);
  return `/${pieces.join('/')}${rng() < 0.2 ? '?q=/a/b' : ''}`;
}

test('agrees with the reference on generated route tables', () => {
  const rng = seededRng(7);
  let matched = 0;
  for (let round = 0; round < 4000; round += 1) {
    const patterns = Array.from({ length: 1 + Math.floor(rng() * 3) }, () => randomPattern(rng));
    const reference = createReference(patterns.map((path) => ({ concretePaths: [path] })));
    const table = tableOf(patterns);
    for (let i = 0; i < 24; i += 1) {
      const url = randomUrl(rng);
      const expected = reference(url);
      assert.deepEqual(table(url), expected, `${JSON.stringify(patterns)} on ${url}`);
      if (expected !== null) matched += 1;
    }
  }
  assert.ok(matched > 2000, `only ${matched} matches, so this proves little`);
});

function assertRouteSet(routes: { path: string; concretePaths: string[]; generateUrl: (rng: () => number) => string }[]) {
  const patterns = routes.map((route) => route.path);
  const reference = createReference(patterns.map((path) => ({ concretePaths: [path] })));
  const table = tableOf(patterns);
  const variants = patterns.flatMap((pattern) => parsePattern(pattern));
  const asts = variants.map(astOf);
  const regexes = variants.map(variantRegExp);
  const rng = seededRng(42);
  routes.forEach((route, id) => {
    assert.equal(parsePattern(route.path).length, new Set(route.concretePaths).size, route.path);
    for (let i = 0; i < 32; i += 1) {
      const url = route.generateUrl(rng) || '/'; // as the bench normalizes it
      assert.deepEqual(table(url), reference(url), url);
      assert.equal(table(url)?.route, id, url);
      assert.equal(table(`/__404__${url}`), null, url);
      asts.forEach((ast, k) => assert.equal(accepts(ast, url), regexes[k].test(url), url));
    }
  });
}

test('bench route set: generic', async () => {
  const { routes } = await import('../../bench/routes-generic.mjs');
  assertRouteSet(routes);
});

const specificUrl = new URL('../../bench/routes-specific.mjs', `file://${__filename}`);
const skipSpecific = existsSync(specificUrl) ? false : 'bench/routes-specific.mjs is not present';

test('bench route set: specific', { skip: skipSpecific }, async () => {
  const { routes } = await import(specificUrl.href);
  assertRouteSet(routes);
});
