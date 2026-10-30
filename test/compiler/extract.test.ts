import test from 'node:test';
import assert from 'node:assert/strict';
import { createReference } from '../../bench/reference.mjs';
import { buildExtractor } from '../../src/compiler/extract';
import { compareRank, parsePattern, variantRegExp } from '../../src/compiler/pattern';
import { parseFragment } from '../../src/compiler/regex-parser';
import type { Extractor, ParseFragment, Variant } from '../../src/compiler/types';

const parse: ParseFragment = parseFragment;

const extractorOf = (variant: Variant): Extractor => {
  const extract = buildExtractor(variant, parse);
  assert.notEqual(extract, null);
  return extract as Extractor;
};

const lastVariant = (pattern: string): Variant => {
  const variants = parsePattern(pattern);
  return variants[variants.length - 1];
};

/** Which of the four cases an extractor uses, read from its source. */
function methodOf(extract: Extractor): 'fixed' | 'end' | 'indexOf' | 'regexp' {
  const source = String(extract);
  if (source.includes('.exec(')) return 'regexp';
  if (source.includes('indexOf')) return 'indexOf';
  return /\be\b/.test(source.slice(source.indexOf('{'))) ? 'end' : 'fixed';
}

/**
 * The variant that wins `path`, and the params the reference's `RegExp.exec` finds for that path. The
 * extractor must find the same ones, with or without a query string after `end`.
 */
function assertSameAsRegExp(pattern: string, path: string) {
  const expected = createReference([{ concretePaths: [pattern] }])(path);
  assert.notEqual(expected, null, `${pattern} should match ${path}`);
  const variant = parsePattern(pattern).sort(compareRank).find((v) => variantRegExp(v).test(path));
  assert.ok(variant, `no variant of ${pattern} matches ${path}`);
  const extract = extractorOf(variant);
  assert.deepEqual(extract(path, path.length), expected.params, `${pattern} on ${path}`);
  assert.deepEqual(extract(`${path}?a=1/2&b=/c/d/e`, path.length), expected.params, `${pattern} on ${path}?`);
  assert.deepEqual(extract(`${path}?`, path.length), expected.params, `${pattern} on ${path}?`);
}

function seededRng(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

type Rng = () => number;

const between = (rng: Rng, min: number, max: number) => min + Math.floor(rng() * (max - min + 1));
const pick = <T>(rng: Rng, items: T[]): T => items[Math.floor(rng() * items.length)];
const repeat = (n: number, f: () => string) => Array.from({ length: n }, f).join('');

const WORD = 'abcxyzABC019.~%-_é';
const word = (rng: Rng, min = 1, max = 9) => repeat(between(rng, min, max), () => pick(rng, [...WORD]));
const digits = (rng: Rng, n: number) => repeat(n, () => String(between(rng, 0, 9)));
const deep = (rng: Rng) => repeat(between(rng, 1, 4), () => `/${word(rng)}`).slice(1);

interface Case {
  pattern: string;
  url: (rng: Rng) => string;
}

const CASES: Record<'fixed' | 'end' | 'indexOf' | 'regexp', Case[]> = {
  fixed: [
    { pattern: '/a/:id([0-9]{4})/b', url: (r) => `/a/${digits(r, 4)}/b` },
    { pattern: '/a/:id([0-9]{4})/b/:code(ab|cd)', url: (r) => `/a/${digits(r, 4)}/b/${pick(r, ['ab', 'cd'])}` },
    {
      pattern: '/:year([0-9]{4})/:month([0-9]{2})/:day([0-9]{2})',
      url: (r) => `/${digits(r, 4)}/${digits(r, 2)}/${digits(r, 2)}`,
    },
    { pattern: '/x/:span(.{3})/y', url: (r) => `/x/${pick(r, ['abc', 'a/b', '//c', '/é/'])}/y` },
    { pattern: '/é😀/:id([0-9]{2})/z', url: (r) => `/é😀/${digits(r, 2)}/z` },
    { pattern: '/:v#locale/x/:w#uuid', url: () => '/en-GB/x/550e8400-e29b-41d4-a716-446655440000' },
    { pattern: '/a/:id(x{0})/b', url: () => '/a//b' },
  ],
  end: [
    { pattern: '/a/:id', url: (r) => `/a/${word(r)}` },
    { pattern: '/a/:rest(.+)', url: (r) => `/a/${deep(r)}` },
    { pattern: '/a/:path(.+)/edit', url: (r) => `/a/${deep(r)}/edit` },
    { pattern: '/a/:path(.+)/b/:id([0-9]{2})', url: (r) => `/a/${deep(r)}/b/${digits(r, 2)}` },
    { pattern: '/:id/static/tail', url: (r) => `/${word(r)}/static/tail` },
    { pattern: '/a/:v(.*)/é', url: (r) => `/a/${r() < 0.2 ? '' : deep(r)}/é` },
    { pattern: '/files/*', url: (r) => `/files/${deep(r)}` },
    { pattern: '/files/:path*', url: (r) => `/files/${deep(r)}` },
    { pattern: '/a/:id([0-9]{2})/*', url: (r) => `/a/${digits(r, 2)}/${deep(r)}` },
  ],
  indexOf: [
    { pattern: '/:a/:b/:c', url: (r) => `/${word(r)}/${word(r)}/${word(r)}` },
    { pattern: '/x/:a/y/:b/z', url: (r) => `/x/${word(r)}/y/${word(r)}/z` },
    { pattern: '/:a([^/]+)/:b(.+)', url: (r) => `/${word(r)}/${deep(r)}` },
    { pattern: '/:a([^/]*)/:b#int/:c', url: (r) => `/${word(r, 0)}/${digits(r, 3)}/${word(r)}` },
    { pattern: '/:a/*', url: (r) => `/${word(r)}/${deep(r)}` },
    { pattern: '/:a/:b/*', url: (r) => `/${word(r)}/${word(r)}/${r() < 0.2 ? '' : deep(r)}` },
    { pattern: '/:a/é/:b([0-9]{2})/:c', url: (r) => `/${word(r)}/é/${digits(r, 2)}/${word(r)}` },
  ],
  regexp: [
    { pattern: '/:a(.+)/:b', url: (r) => `/${deep(r)}/${word(r)}` },
    { pattern: '/:a(.+)/:b(.+)', url: (r) => `/${deep(r)}/${deep(r)}` },
    { pattern: '/:a(.+?)/:b(.+)', url: (r) => `/${deep(r)}/${deep(r)}` },
    { pattern: '/s/:a([^!]+)/:b#int/:c', url: (r) => `/s/${deep(r)}/${digits(r, 3)}/${word(r)}` },
    { pattern: '/:a(.+)/x/:b([0-9]+)', url: (r) => `/${deep(r)}/x/${digits(r, between(r, 1, 4))}` },
    { pattern: '/:a(.+)/*', url: (r) => `/${deep(r)}` },
    { pattern: '/:a(.+)/b/*', url: (r) => `/${deep(r)}/b${r() < 0.5 ? '' : `/${deep(r)}`}` },
    { pattern: '/:a(x|x/y)/*', url: (r) => pick(r, ['/x', '/x/y', '/x/y/z', '/x/q']) },
  ],
};

test('case 1: fixed offsets, when every width before and through the param is known', () => {
  assert.equal(String(buildExtractor(lastVariant('/a/:id([0-9]{4})/b'), parse)).includes('s.slice(3,7)'), true);
  assert.deepEqual(extractorOf(lastVariant('/a/:id([0-9]{4})/b'))('/a/1234/b', 9), { id: '1234' });
});

test('case 2: anchors from the end, when everything after the param has a known width', () => {
  assert.equal(String(buildExtractor(lastVariant('/a/:p(.+)/edit'), parse)).includes('s.slice(3,e-5)'), true);
  assert.deepEqual(extractorOf(lastVariant('/a/:p(.+)/edit'))('/a/x/y/edit?q', 11), { p: 'x/y' });
});

test('case 3: finds the next `/`, when the param cannot hold one', () => {
  assert.equal(String(buildExtractor(lastVariant('/:a/:b'), parse)).includes('indexOf'), true);
  assert.deepEqual(extractorOf(lastVariant('/:a/:b'))('/x/y?q=/z', 4), { a: 'x', b: 'y' });
});

test('case 4: runs the RegExp, when no boundary is forced', () => {
  assert.deepEqual(extractorOf(lastVariant('/:a(.+)/:b'))('/x/y/z?q=/w', 6), { a: 'x/y', b: 'z' });
  assert.deepEqual(extractorOf(lastVariant('/:a(.+?)/:b(.+)'))('/x/y/z', 6), { a: 'x', b: 'y/z' });
});

for (const [method, cases] of Object.entries(CASES)) {
  test(`generated URLs equal RegExp.exec: ${method}`, () => {
    const rng = seededRng(method.length * 31);
    for (const { pattern, url } of cases) {
      assert.equal(methodOf(extractorOf(lastVariant(pattern))), method, pattern);
      for (let i = 0; i < 400; i += 1) assertSameAsRegExp(pattern, url(rng));
    }
  });
}

test('a variant with no params and no defaults has no extractor', () => {
  for (const pattern of ['/', '/a', '/a/b/', '/é', '/(a|b)']) {
    assert.equal(buildExtractor(parsePattern(pattern)[0], parse), null, pattern);
  }
  assert.equal(buildExtractor(parsePattern('/a/:b?')[0], parse), null);
  assert.equal(buildExtractor(parsePattern('/:b?')[0], parse), null);
});

test('an empty wildcard match still has an extractor, for its default', () => {
  const [empty] = parsePattern('/files/:path*');
  const extract = extractorOf(empty);
  assert.deepEqual(extract('/files', 6), { path: '' });
  assert.deepEqual(extract('/files?a=1', 6), { path: '' });
  assert.notEqual(extract('/files', 6), extract('/files', 6));
  assert.deepEqual(extractorOf(parsePattern('/:a/:b*')[0])('/x', 2), { a: 'x', b: '' });
  assert.deepEqual(extractorOf(parsePattern('/*')[0])('/', 1), { '*': '' });
});

test('end is the path end, so the query never leaks in', () => {
  assert.deepEqual(extractorOf(lastVariant('/a/:x'))('/a/1?b/c', 4), { x: '1' });
  assert.deepEqual(extractorOf(lastVariant('/a/*'))('/a/1/2?b/c', 6), { '*': '1/2' });
  assert.deepEqual(extractorOf(lastVariant('/:a(.+)/:b'))('/a/1/2?/c', 6), { a: 'a/1', b: '2' });
});

test('a param regex that holds groups does not shift later params', () => {
  assertSameAsRegExp('/:a((x)|(y))/:b(.+)/:c', '/y/1/2/3');
});

test('wildcards: a crossing param before them takes what the combined regex gives it', () => {
  assert.deepEqual(extractorOf(parsePattern('/:a(.+)/*')[0])('/x/y', 4), { a: 'x/y', '*': '' });
  assert.deepEqual(extractorOf(parsePattern('/:a(.+)/*')[1])('/x/y', 4), { a: 'x/y', '*': '' });

  // Alternation order and laziness give the wildcard the rest, whichever variant the DFA chose.
  for (const pattern of ['/:a(x|x/y)/*', '/:a(.+?)/*', '/:a(.+?)/b/*']) {
    for (const path of ['/x/y', '/x/b/b', '/x/b', '/x/y/b/z']) {
      const expected = createReference([{ concretePaths: [pattern] }])(path);
      if (expected === null) continue;
      for (const variant of parsePattern(pattern)) {
        if (variantRegExp(variant).test(path)) {
          assert.deepEqual(extractorOf(variant)(path, path.length), expected.params, `${pattern} on ${path}`);
        }
      }
    }
  }
});

test('names: quoted, so any text is safe in the generated code', () => {
  for (const name of ['a-b', 'a.b', 'a"b', "a'b", 'a\\b', 'class', '0', '']) {
    const pattern = `/x/:${name}/y/:other`;
    assert.deepEqual(extractorOf(lastVariant(pattern))('/x/1/y/2', 8), { [name]: '1', other: '2' }, name);
  }
});

test('names: a repeated name keeps its last capture', () => {
  assert.deepEqual(extractorOf(lastVariant('/:a/:a'))('/1/2', 4), { a: '2' });
  assert.deepEqual(extractorOf(lastVariant('/:a(.+)/:a'))('/1/2/3', 6), { a: '3' });
  assert.deepEqual(extractorOf(parsePattern('/:a/:a*')[0])('/1', 2), { a: '' });
  assert.deepEqual(extractorOf(parsePattern('/:a/:a*')[1])('/1/2', 4), { a: '2' });
  assertSameAsRegExp('/:a/:a*', '/1');
  assertSameAsRegExp('/:a/:a*', '/1/2');
});

test('names: __proto__ neither throws nor sets a prototype', () => {
  for (const pattern of ['/:__proto__', '/:__proto__/:__proto__', '/:__proto__(.+)/:__proto__']) {
    const params = extractorOf(lastVariant(pattern))('/1/2', 4);
    assert.equal(Object.getPrototypeOf(params), Object.prototype, pattern);
    assert.deepEqual(params, {}, pattern);
  }
});

test('a fragment the parser refuses falls back to what its surroundings force', () => {
  const refuse: ParseFragment = () => ({ ok: false, reason: 'lookahead' });
  const last = buildExtractor(lastVariant('/a/:b((?=x).+)'), refuse) as Extractor;
  assert.equal(methodOf(last), 'end');
  assert.deepEqual(last('/a/xy', 5), { b: 'xy' });

  const fixedEnd = buildExtractor(lastVariant('/:a((?=x)x+)/b'), refuse) as Extractor;
  assert.equal(methodOf(fixedEnd), 'end');
  assert.deepEqual(fixedEnd('/xx/b', 5), { a: 'xx' });

  const both = buildExtractor(lastVariant('/:a((?=x)x+)/:b'), refuse) as Extractor;
  assert.equal(methodOf(both), 'regexp');
  assert.deepEqual(both('/xx/y', 5), { a: 'xx', b: 'y' });
});

test('non-ASCII text counts in code units, as `s.slice` does', () => {
  assert.deepEqual(extractorOf(lastVariant('/😀/:id([0-9]{2})'))('/😀/42', 6), { id: '42' });
  assert.deepEqual(extractorOf(lastVariant('/:a/😀/:b'))('/é/😀/ü', 8), { a: 'é', b: 'ü' });
  assert.deepEqual(extractorOf(lastVariant('/x/:v'))('/x/café', 7), { v: 'café' });
});
