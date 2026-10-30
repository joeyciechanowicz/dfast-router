import test from 'node:test';
import assert from 'node:assert/strict';
import { code, mkset, segSet, single } from '../../src/compiler/charset';
import { buildDfa, determinize, minimize } from '../../src/compiler/dfa';
import { ALPHABET, NON_ASCII, QMARK, SLASH } from '../../src/compiler/types';
import type { Ast, CharSet, Dfa, DfaInput } from '../../src/compiler/types';
import { astMatches } from '../helpers/ast-match';

const SEED = 0x4f1d2c07;
const NO_LIMIT = 1_000_000;

// The compile-time limits from PLAN.md. They are pass or fail checks that hold during a
// parallel wave, not measurements. The budget is one that every case can be judged by: the
// 300-route table needs more states than the router's own budget of 32,767.
const SCALE_BUDGET = 200_000;
const OVERLAP_300_LIMIT_MS = 20_000;
const OVERLAP_1000_LIMIT_MS = 20_000;
const REST_3000_LIMIT_MS = 2_000;
const CHAIN_LIMIT_MS = 2_000;

type Random = () => number;

/** mulberry32: small, seedable, and good enough to cover the generators' choices. */
function seeded(seed: number): Random {
  let x = seed;
  return () => {
    x = (x + 0x6d2b79f5) | 0;
    let t = Math.imul(x ^ (x >>> 15), 1 | x);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (r: Random, n: number): number => Math.floor(r() * n);
const pick = <T>(r: Random, xs: readonly T[]): T => xs[int(r, xs.length)];

// --- Patterns: each random AST comes with an equivalent regex source -----------------------------

interface Pattern {
  ast: Ast;
  source: string; // always a single atom, so that it can be quantified or concatenated
}

const LITERALS = ['a', 'b', '0', '1', '/', '-', '.'];
const NON_ASCII_TEXT = ['é', 'ü', ' ', '\u{1f600}'];
const NOISE = [...LITERALS, '?', '\n', '~', 'Z'];

const quote = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
const inSet = (members: string[]) => (symbol: number): boolean =>
  members.some((member) => code(member) === symbol);

function literal(text: string): Pattern {
  return { ast: { t: 'set', set: single(code(text)) }, source: quote(text) };
}

function charset(set: CharSet, source: string): Pattern {
  return { ast: { t: 'set', set }, source };
}

function concat(parts: Pattern[]): Pattern {
  return {
    ast: { t: 'cat', xs: parts.map((part) => part.ast) },
    source: `(?:${parts.map((part) => part.source).join('')})`,
  };
}

function alternate(parts: Pattern[]): Pattern {
  return {
    ast: { t: 'alt', xs: parts.map((part) => part.ast) },
    source: `(?:${parts.map((part) => part.source).join('|')})`,
  };
}

function repeat(x: Pattern, min: number, max: number, quantifier: string): Pattern {
  return { ast: { t: 'rep', x: x.ast, min, max }, source: `(?:${x.source}${quantifier})` };
}

function randomLeaf(r: Random, unicode: boolean): Pattern {
  if (unicode && r() < 0.15) {
    return r() < 0.5 ? literal('é') : charset(mkset((s) => s === NON_ASCII), '[é-ü]');
  }
  if (r() < 0.03) return charset(mkset(() => false), '[]'); // matches nothing at all
  switch (int(r, 10)) {
    case 0:
    case 1:
    case 2:
    case 3:
      return literal(pick(r, LITERALS));
    case 4: {
      const members = [pick(r, LITERALS), pick(r, LITERALS), pick(r, LITERALS)];
      return charset(mkset(inSet(members)), `[${members.map(quote).join('')}]`);
    }
    case 5: {
      const members = [pick(r, LITERALS), pick(r, LITERALS)];
      const has = inSet(members);
      return charset(mkset((s) => !has(s)), `[^${members.map(quote).join('')}?]`);
    }
    case 6:
      return charset(segSet(), '[^/?]');
    case 7:
      return charset(mkset(() => true), '[^?]');
    case 8:
      return charset(mkset((s) => s >= 48 && s <= 57), '\\d');
    default:
      return charset(
        mkset((s) => (s >= 48 && s <= 57) || (s >= 65 && s <= 90) || (s >= 97 && s <= 122) || s === 95),
        '\\w',
      );
  }
}

function randomRepeat(x: Pattern, r: Random): Pattern {
  // A lazy quantifier matches the same language as a greedy one.
  const lazy = r() < 0.2 ? '?' : '';
  switch (int(r, 6)) {
    case 0:
      return repeat(x, 0, Infinity, `*${lazy}`);
    case 1:
      return repeat(x, 1, Infinity, `+${lazy}`);
    case 2:
      return repeat(x, 0, 1, `?${lazy}`);
    case 3: {
      const count = int(r, 4);
      return repeat(x, count, count, `{${count}}`);
    }
    case 4: {
      const min = int(r, 3);
      return repeat(x, min, Infinity, `{${min},}${lazy}`);
    }
    default: {
      const min = int(r, 3);
      const max = min + int(r, 3);
      return repeat(x, min, max, `{${min},${max}}${lazy}`);
    }
  }
}

function randomPattern(r: Random, depth: number, unicode = false): Pattern {
  if (depth === 0 || r() < 0.25) return randomLeaf(r, unicode);
  const children = (count: number): Pattern[] =>
    Array.from({ length: count }, () => randomPattern(r, depth - 1, unicode));
  switch (int(r, 3)) {
    case 0:
      return concat(children(int(r, 5)));
    case 1:
      return alternate(children(1 + int(r, 3)));
    default:
      return randomRepeat(randomPattern(r, depth - 1, unicode), r);
  }
}

/** A route's regex: routes overlap far more often than arbitrary patterns do. */
function randomRoute(r: Random): Pattern {
  const parts: Pattern[] = [];
  const segments = 1 + int(r, 3);
  for (let i = 0; i < segments; i += 1) {
    parts.push(literal('/'));
    switch (int(r, 6)) {
      case 0:
        parts.push(literal('a'));
        break;
      case 1:
        parts.push(concat([literal('a'), literal('b')]));
        break;
      case 2:
        parts.push(repeat(charset(segSet(), '[^/?]'), 1, Infinity, '+'));
        break;
      case 3:
        parts.push(repeat(charset(mkset((s) => s >= 48 && s <= 57), '\\d'), 1, Infinity, '+'));
        break;
      case 4:
        parts.push(alternate([literal('a'), concat([literal('b'), literal('a')])]));
        break;
      default:
        parts.push(repeat(charset(mkset(() => true), '[^?]'), 0, Infinity, '*'));
        break;
    }
  }
  return concat(parts);
}

const anchored = (source: string): RegExp => new RegExp(`^${source}$`);

/** Whether a repeat sits inside another, the shape that sends backtracking `RegExp` exponential. */
function nestedRepeat(ast: Ast, inRepeat = false): boolean {
  switch (ast.t) {
    case 'set':
      return false;
    case 'cat':
    case 'alt':
      return ast.xs.some((x) => nestedRepeat(x, inRepeat));
    case 'rep':
      return inRepeat || nestedRepeat(ast.x, true);
  }
}

/**
 * `RegExp`, except for nested repeats: `(?:(?:\/+){1,2})+` takes it over 20s on 29 characters.
 * Those are the riskiest NFA shapes, so they stay in the tests and use the AST matcher, which
 * stays polynomial and is fuzzed against `RegExp` in regex-fuzz.test.ts.
 */
function oracleFor(pattern: Pattern): (s: string) => boolean {
  if (nestedRepeat(pattern.ast)) return (s) => astMatches(pattern.ast, s);
  const regex = anchored(pattern.source);
  return (s) => regex.test(s);
}

// --- Strings -------------------------------------------------------------------------------------

function sampleSet(set: CharSet, r: Random, unicode: boolean): string | null {
  const symbols: number[] = [];
  for (let s = 0; s < ALPHABET; s += 1) {
    if (set[s] === 1 && (unicode || s !== NON_ASCII)) symbols.push(s);
  }
  if (symbols.length === 0) return null;
  const friendly = symbols.filter((s) => s === NON_ASCII || LITERALS.includes(String.fromCharCode(s)));
  const symbol = pick(r, friendly.length > 0 && r() < 0.85 ? friendly : symbols);
  return symbol === NON_ASCII ? pick(r, NON_ASCII_TEXT) : String.fromCharCode(symbol);
}

/** A random string in the language of `ast`, or null if the choices made reach an empty set. */
function sample(ast: Ast, r: Random, unicode: boolean): string | null {
  switch (ast.t) {
    case 'set':
      return sampleSet(ast.set, r, unicode);
    case 'cat': {
      let out = '';
      for (const x of ast.xs) {
        const part = sample(x, r, unicode);
        if (part === null) return null;
        out += part;
      }
      return out;
    }
    case 'alt':
      return sample(pick(r, ast.xs), r, unicode);
    case 'rep': {
      const extra = ast.max === Infinity ? int(r, 4) : int(r, ast.max - ast.min + 1);
      let out = '';
      for (let i = 0; i < ast.min + extra; i += 1) {
        const part = sample(ast.x, r, unicode);
        if (part === null) return null;
        out += part;
      }
      return out;
    }
  }
}

function noise(r: Random, unicode: boolean): string {
  const alphabet = unicode ? [...NOISE, ...NON_ASCII_TEXT] : NOISE;
  let out = '';
  for (let i = int(r, 9); i > 0; i -= 1) out += pick(r, alphabet);
  return out;
}

function mutate(text: string, r: Random, unicode: boolean): string {
  const at = int(r, text.length + 1);
  const ch = noise(r, unicode).slice(0, 1) || pick(r, LITERALS);
  switch (int(r, 3)) {
    case 0:
      return text.slice(0, at) + ch + text.slice(at);
    case 1:
      return text.slice(0, at) + text.slice(at + 1);
    default:
      return text.slice(0, at) + ch + text.slice(at + 1);
  }
}

function randomString(patterns: Pattern[], r: Random, unicode = false): string {
  const base = sample(pick(r, patterns).ast, r, unicode);
  const roll = r();
  if (base === null || roll < 0.1) return noise(r, unicode);
  return roll < 0.55 ? base : mutate(base, r, unicode);
}

// --- Checks --------------------------------------------------------------------------------------

function walk(dfa: Dfa, path: string): number[] {
  let state = dfa.start;
  for (let i = 0; i < path.length; i += 1) {
    const c = path.charCodeAt(i);
    state = dfa.trans[state * dfa.classes + dfa.classOf[c < NON_ASCII ? c : NON_ASCII]];
    if (state < 0) return [];
  }
  const tags = dfa.accepts[state];
  return tags === null ? [] : Array.from(tags);
}

const sameTags = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((tag, i) => tag === b[i]);

function build(inputs: DfaInput[]): Dfa {
  const result = buildDfa(inputs, { maxStates: NO_LIMIT });
  assert.ok(result.ok, 'unexpected state-budget result');
  return result.dfa;
}

function raw(inputs: DfaInput[]): Dfa {
  const result = determinize(inputs, NO_LIMIT);
  assert.ok(result.ok, 'unexpected state-budget result');
  return result.dfa;
}

const acceptsOf = (dfa: Dfa, state: number): readonly number[] =>
  state < 0 ? [] : Array.from(dfa.accepts[state] ?? []);

/** Proves that two DFAs accept the same tags on every string, by walking them in lockstep. */
function assertEquivalent(a: Dfa, b: Dfa, label: string): void {
  assert.deepEqual(a.classOf, b.classOf, label);
  const seen = new Set<number>();
  const stack: [number, number][] = [[a.start, b.start]];
  while (stack.length > 0) {
    const [x, y] = stack.pop() as [number, number];
    const key = (x + 1) * (b.states + 1) + y + 1;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!sameTags(acceptsOf(a, x), acceptsOf(b, y))) {
      assert.fail(`${label}: states ${x} and ${y} accept different tags`);
    }
    for (let c = 0; c < a.classes; c += 1) {
      const nextX = x < 0 ? -1 : a.trans[x * a.classes + c];
      const nextY = y < 0 ? -1 : b.trans[y * b.classes + c];
      if (nextX >= 0 || nextY >= 0) stack.push([nextX, nextY]);
    }
  }
}

/** Moore's algorithm, with a virtual dead state: no two states of `dfa` may be equivalent. */
function assertMinimal(dfa: Dfa, label: string): void {
  const { states, classes, trans } = dfa;
  const dead = states;
  let part = new Array<number>(states + 1);
  const renumber = (keys: string[]): number => {
    const ids = new Map<string, number>();
    keys.forEach((key, s) => {
      if (!ids.has(key)) ids.set(key, ids.size);
      part[s] = ids.get(key) as number;
    });
    return ids.size;
  };
  const initial = Array.from({ length: states + 1 }, (_, s) => acceptsOf(dfa, s < states ? s : -1).join());
  let blocks = renumber(initial);
  for (;;) {
    const keys = new Array<string>(states + 1);
    for (let s = 0; s <= states; s += 1) {
      let key = String(part[s]);
      for (let c = 0; c < classes; c += 1) {
        const t = s === dead ? -1 : trans[s * classes + c];
        key += `,${part[t < 0 ? dead : t]}`;
      }
      keys[s] = key;
    }
    part = part.slice();
    const refined = renumber(keys);
    if (refined === blocks) break;
    blocks = refined;
  }

  const empty = states === 1 && dfa.accepts[dfa.start] === null;
  assert.equal(blocks, empty ? 1 : states + 1, `${label}: a smaller DFA exists`);

  const reached = new Set([dfa.start]);
  const stack = [dfa.start];
  while (stack.length > 0) {
    const s = stack.pop() as number;
    for (let c = 0; c < classes; c += 1) {
      const t = trans[s * classes + c];
      if (t >= 0 && !reached.has(t)) {
        reached.add(t);
        stack.push(t);
      }
    }
  }
  assert.equal(reached.size, states, `${label}: unreachable states`);
}

// --- Route generators, copied from prototype/scale.mjs -------------------------------------------

function lcg(seed: number): Random {
  let x = seed;
  return () => (x = (x * 1664525 + 1013904223) >>> 0) / 4294967296;
}

const SYLLABLES = ['ac', 'ver', 'sub', 'tion', 'pro', 'file', 'or', 'der', 'us', 'er', 're', 'port', 'com', 'ment', 'in', 'voice', 'con', 'fig', 'data', 'meta'];

function word(r: Random): string {
  let out = '';
  const parts = 2 + Math.floor(r() * 3);
  for (let i = 0; i < parts; i += 1) out += SYLLABLES[Math.floor(r() * SYLLABLES.length)];
  return out;
}

function restApi(n: number, r: Random): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  while (paths.length < n) {
    const a = word(r);
    const b = word(r);
    for (const path of [`/v1/${a}`, `/v1/${a}/:id`, `/v1/${a}/:id/${b}`, `/v1/${a}/:id/${b}/:subId`]) {
      if (!seen.has(path)) {
        seen.add(path);
        paths.push(path);
      }
    }
  }
  return paths.slice(0, n);
}

function overlap(n: number, r: Random): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const literals = Array.from({ length: Math.max(6, Math.round(Math.sqrt(n))) }, () => word(r));
  while (paths.length < n) {
    const depth = 2 + Math.floor(r() * 4);
    let path = '';
    let params = 0;
    for (let i = 0; i < depth; i += 1) {
      if (r() < 0.4) {
        path += `/:p${params}`;
        params += 1;
      } else {
        path += `/${literals[Math.floor(r() * literals.length)]}`;
      }
    }
    if (!seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

/** A route's AST, built by hand because `pattern.ts` is a stub until WP-5 merges. */
function routeAst(path: string): Ast {
  const xs: Ast[] = [];
  for (const segment of path.split('/').slice(1)) {
    xs.push({ t: 'set', set: single(SLASH) });
    if (segment[0] === ':') {
      xs.push({ t: 'rep', x: { t: 'set', set: segSet() }, min: 1, max: Infinity });
    } else {
      for (const ch of segment) xs.push({ t: 'set', set: single(code(ch)) });
    }
  }
  return { t: 'cat', xs };
}

function routeRegExp(path: string): RegExp {
  const segments = path.split('/').slice(1).map((s) => (s[0] === ':' ? '[^/?]+' : s));
  return new RegExp(`^/${segments.join('/')}$`);
}

/**
 * URLs for random routes. A param takes a value that some other route has as a literal half of
 * the time, because that's what makes one URL match several routes.
 */
function routeUrls(paths: string[], count: number, r: Random): string[] {
  const literals = [...new Set(paths.flatMap((p) => p.split('/').slice(1)))].filter((s) => s[0] !== ':');
  const urls: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const url = pick(r, paths).replace(/:[a-zA-Z0-9]+/g, () =>
      r() < 0.5 ? pick(r, literals) : String(1 + int(r, 9999999)),
    );
    const roll = r();
    urls.push(roll < 0.8 ? url : roll < 0.9 ? `${url}/` : url.slice(0, -1));
  }
  return urls;
}

/** Compares accept sets against every route's regex, and returns the URLs matching 2 or more. */
function assertRouteAccepts(dfa: Dfa, paths: string[], urls: string[], label: string): number {
  const regexes = paths.map(routeRegExp);
  let several = 0;
  for (const url of urls) {
    const want: number[] = [];
    regexes.forEach((regex, tag) => {
      if (regex.test(url)) want.push(tag);
    });
    const got = walk(dfa, url);
    if (!sameTags(got, want)) assert.fail(`${label}: ${url}: got [${got}], want [${want}]`);
    if (want.length > 1) several += 1;
  }
  return several;
}

function inputsFor(paths: string[]): DfaInput[] {
  return paths.map((path, tag) => ({ ast: routeAst(path), tag }));
}

// --- Random differential tests -------------------------------------------------------------------

test('a DFA walk equals RegExp.test on at least 100k random pairs', () => {
  const r = seeded(SEED);
  let pairs = 0;
  let matched = 0;
  for (let n = 0; pairs < 120_000; n += 1) {
    const pattern = randomPattern(r, 4);
    const matches = oracleFor(pattern);
    const dfa = build([{ ast: pattern.ast, tag: 7 }]);
    for (let i = 0; i < 40; i += 1) {
      const s = randomString([pattern], r);
      const want = matches(s) ? [7] : [];
      if (!sameTags(walk(dfa, s), want)) {
        const context = `seed ${SEED} pattern ${n} ${pattern.source} on ${JSON.stringify(s)}`;
        assert.fail(`${context}: want [${want}]`);
      }
      pairs += 1;
      matched += want.length;
    }
  }
  assert.ok(matched > pairs / 5, `only ${matched} of ${pairs} pairs matched, too few to mean much`);
  assert.ok(pairs - matched > pairs / 5, `only ${pairs - matched} of ${pairs} pairs missed`);
});

test('accept sets equal an oracle listing every matching tag', () => {
  const r = seeded(SEED + 1);
  let compared = 0;
  let several = 0;
  for (let n = 0; n < 4_000; n += 1) {
    const size = 2 + int(r, 9);
    const patterns = Array.from({ length: size }, () =>
      n % 2 === 0 ? randomRoute(r) : randomPattern(r, 3),
    );

    // Sparse and shuffled, so that a tag is never mistaken for its input's position.
    const tags = patterns.map((_, i) => i * 3 + 2);
    for (let i = size - 1; i > 0; i -= 1) {
      const j = int(r, i + 1);
      [tags[i], tags[j]] = [tags[j], tags[i]];
    }
    const inputs = patterns.map((pattern, i) => ({ ast: pattern.ast, tag: tags[i] }));
    const regexes = patterns.map((pattern) => anchored(pattern.source));
    const minimal = build(inputs);
    const unminimized = raw(inputs);

    for (let i = 0; i < 25; i += 1) {
      const s = randomString(patterns, r);
      const want = tags.filter((_, k) => regexes[k].test(s)).sort((a, b) => a - b);
      for (const dfa of [minimal, unminimized]) {
        const got = walk(dfa, s);
        if (!sameTags(got, want)) {
          assert.fail(
            `seed ${SEED + 1} table ${n} on ${JSON.stringify(s)}: got [${got}], want [${want}]\n` +
              patterns.map((pattern, k) => `  ${tags[k]}: ${pattern.source}`).join('\n'),
          );
        }
      }
      compared += 1;
      if (want.length > 1) several += 1;
    }
  }
  assert.ok(several > compared / 10, `only ${several} of ${compared} strings matched 2+ patterns`);
});

test('non-ASCII strings may over-accept but never lose a tag RegExp accepts', () => {
  const r = seeded(SEED + 2);
  let confirmed = 0;
  let overAccepted = 0;
  for (let n = 0; n < 3_000; n += 1) {
    const patterns = Array.from({ length: 1 + int(r, 4) }, () => randomPattern(r, 3, true));
    const oracles = patterns.map(oracleFor);
    const dfa = build(patterns.map((pattern, tag) => ({ ast: pattern.ast, tag })));
    for (let i = 0; i < 20; i += 1) {
      const s = randomString(patterns, r, true);
      const got = walk(dfa, s);
      const ascii = /^[\0-\x7f]*$/.test(s);
      oracles.forEach((matches, tag) => {
        const want = matches(s);
        const has = got.includes(tag);
        const context = `seed ${SEED + 2} table ${n} ${patterns[tag].source} on ${JSON.stringify(s)}`;
        if (want && !has) assert.fail(`${context}: lost a tag`);
        if (ascii && has && !want) assert.fail(`${context}: over-accepted an ASCII string`);
        if (!ascii && want) confirmed += 1;
        if (has && !want) overAccepted += 1;
      });
    }
  }
  assert.ok(confirmed > 1_000, `only ${confirmed} non-ASCII strings matched a regex`);
  assert.ok(overAccepted > 100, `only ${overAccepted} over-accepts, so the case went untested`);
});

test('minimizing never changes acceptance, and leaves no equivalent states', () => {
  const r = seeded(SEED + 3);
  let merged = 0;
  for (let n = 0; n < 3_000; n += 1) {
    const size = 1 + int(r, 6);

    // A shared tag makes equal tails equivalent. Unique tags rarely leave anything to merge.
    const inputs = Array.from({ length: size }, () => ({
      ast: (n % 2 === 0 ? randomRoute(r) : randomPattern(r, 4)).ast,
      tag: int(r, 3),
    }));
    const before = raw(inputs);
    const after = minimize(before);
    const label = `seed ${SEED + 3} table ${n}`;
    assertEquivalent(before, after, label);
    assertMinimal(after, label);
    merged += before.states - after.states;
  }
  assert.ok(merged > 1_000, `only ${merged} states merged, too few to test merging`);
});

// --- Accept sets ---------------------------------------------------------------------------------

test('states stay apart when accept sets differ but the lowest tag is the same', () => {
  const pair = alternate([literal('a'), literal('b')]);
  const dfa = build([
    { ast: pair.ast, tag: 0 },
    { ast: literal('b').ast, tag: 1 },
  ]);
  assert.deepEqual(walk(dfa, 'a'), [0]);
  assert.deepEqual(walk(dfa, 'b'), [0, 1]);
  assert.equal(dfa.states, 3);
});

test('states with equal accept sets merge across different paths', () => {
  const first = concat([literal('a'), literal('x')]);
  const second = concat([literal('b'), literal('x')]);
  const inputs = [{ ast: alternate([first, second]).ast, tag: 4 }];
  // `ax` and `bx` already share a subset, through the `alt`'s end. Only `a` and `b` are left to merge.
  assert.equal(raw(inputs).states, 4);
  const dfa = build(inputs);
  assert.equal(dfa.states, 3);
  assert.deepEqual(walk(dfa, 'ax'), [4]);
  assert.deepEqual(walk(dfa, 'bx'), [4]);
  assert.deepEqual(walk(dfa, 'x'), []);
});

test('tags are ascending whatever the input order, and include negatives', () => {
  const a = literal('a').ast;
  const dfa = build([
    { ast: a, tag: 9 },
    { ast: a, tag: -3 },
    { ast: a, tag: 2 },
    { ast: a, tag: 40000 },
  ]);
  assert.deepEqual(walk(dfa, 'a'), [-3, 2, 9, 40000]);
  assert.ok(dfa.accepts.every((tags) => tags === null || tags instanceof Int32Array));
});

test('a tag given twice appears once', () => {
  const a = literal('a').ast;
  const dfa = build([
    { ast: a, tag: 5 },
    { ast: a, tag: 5 },
  ]);
  assert.deepEqual(walk(dfa, 'a'), [5]);
});

test('a table can hold every tag in one state', () => {
  const inputs = Array.from({ length: 2000 }, (_, tag) => ({ ast: routeAst('/:id'), tag }));
  const dfa = build(inputs);
  assert.deepEqual(walk(dfa, '/x'), inputs.map((input) => input.tag));
});

// --- Edge cases ----------------------------------------------------------------------------------

test('an empty table has one state that accepts nothing', () => {
  const dfa = build([]);
  assert.equal(dfa.states, 1);
  assert.equal(dfa.classes, 1);
  assert.deepEqual(walk(dfa, ''), []);
  assert.deepEqual(walk(dfa, 'a'), []);
});

test('an empty language gives the same one state', () => {
  const never: Ast = { t: 'set', set: mkset(() => false) };
  const dfa = build([{ ast: { t: 'cat', xs: [literal('a').ast, never] }, tag: 0 }]);
  assert.equal(dfa.states, 1);
  assert.deepEqual(walk(dfa, 'a'), []);
});

test('branches that can never finish are removed', () => {
  const never = charset(mkset(() => false), '[]');
  const inputs = [
    { ast: literal('a').ast, tag: 0 },
    { ast: concat([literal('b'), literal('c'), never]).ast, tag: 1 },
  ];
  const before = raw(inputs);
  const after = minimize(before);
  assertEquivalent(before, after, 'dead branch');
  assert.equal(after.states, 2);
  assert.deepEqual(walk(after, 'b'), []);
});

test('the empty string is accepted by the start state', () => {
  const dfa = build([{ ast: { t: 'cat', xs: [] }, tag: 3 }]);
  assert.deepEqual(walk(dfa, ''), [3]);
  assert.deepEqual(walk(dfa, 'a'), []);
});

test('nullable loops and zero-count repeats terminate', () => {
  const a = literal('a');
  const nested = repeat(repeat(repeat(a, 0, Infinity, '*'), 0, Infinity, '*'), 2, Infinity, '{2,}');
  const never = repeat(a, 0, 0, '{0}');
  const dfa = build([
    { ast: nested.ast, tag: 0 },
    { ast: never.ast, tag: 1 },
  ]);
  assert.deepEqual(walk(dfa, ''), [0, 1]);
  assert.deepEqual(walk(dfa, 'aaaa'), [0]);
});

test('no state has a transition on `?`, because it ends the path', () => {
  const dfa = build([{ ast: routeAst('/:a/b'), tag: 0 }]);
  const c = dfa.classOf[QMARK];
  for (let s = 0; s < dfa.states; s += 1) assert.equal(dfa.trans[s * dfa.classes + c], -1);
});

test('symbols that no pattern tells apart share a class', () => {
  const dfa = build([{ ast: routeAst('/a/:id'), tag: 0 }]);
  assert.equal(dfa.classOf.length, ALPHABET);
  assert.equal(dfa.classes, 4); // `/`, `a`, the rest of [^/?], and everything else
  assert.equal(dfa.classOf[code('b')], dfa.classOf[code('z')]);
  assert.equal(dfa.classOf[code('b')], dfa.classOf[NON_ASCII]);
  assert.notEqual(dfa.classOf[code('a')], dfa.classOf[code('b')]);
  assert.equal(dfa.trans.length, dfa.states * dfa.classes);
});

test('minimize leaves its input untouched', () => {
  const never = charset(mkset(() => false), '[]');
  const inputs = [{ ast: concat([literal('b'), never]).ast, tag: 1 }, { ast: literal('a').ast, tag: 0 }];
  const before = raw(inputs);
  const copy = before.trans.slice();
  minimize(before);
  assert.deepEqual(before.trans, copy);
});

// --- State budget --------------------------------------------------------------------------------

/** `[ab]*a[ab]{n}`: the classic table whose DFA has 2^(n+1) states. */
function exploding(n: number): DfaInput {
  const ab = charset(mkset(inSet(['a', 'b'])), '[ab]');
  const tail = repeat(ab, n, n, `{${n}}`);
  return { ast: concat([repeat(ab, 0, Infinity, '*'), literal('a'), tail]).ast, tag: 0 };
}

test('state-budget stops subset construction as soon as it is exceeded', () => {
  const result = buildDfa([exploding(40)], { maxStates: 1000 });
  assert.deepEqual(result, { ok: false, reason: 'state-budget', states: 1001 });
});

test('a table that fits its budget exactly still builds', () => {
  const inputs = [exploding(4)];
  const needed = raw(inputs).states;
  assert.equal(needed, 32);
  assert.ok(buildDfa(inputs, { maxStates: needed }).ok);
  assert.deepEqual(buildDfa(inputs, { maxStates: needed - 1 }), {
    ok: false,
    reason: 'state-budget',
    states: needed,
  });
});

test('the start state counts against the budget', () => {
  assert.deepEqual(buildDfa([], { maxStates: 0 }), { ok: false, reason: 'state-budget', states: 1 });
});

test('the budget applies before minimization', () => {
  const first = concat([literal('a'), literal('x')]);
  const second = concat([literal('b'), literal('x')]);
  const inputs = [{ ast: alternate([first, second]).ast, tag: 0 }];
  assert.equal(build(inputs).states, 3);
  assert.equal(buildDfa(inputs, { maxStates: 3 }).ok, false);
  assert.equal(buildDfa(inputs, { maxStates: 5 }).ok, true);
});

test('counted repeats too large to build fail the budget without being built', () => {
  const a = literal('a');
  const huge = repeat(repeat(repeat(a, 1000, 1000, '{1000}'), 1000, 1000, '{1000}'), 1000, 1000, '{1000}');
  const result = buildDfa([{ ast: huge.ast, tag: 0 }], { maxStates: 32767 });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason === 'state-budget' && result.states > 32767);
});

test('an empty body with a huge count fails the budget without looping', () => {
  const empty: Ast = { t: 'cat', xs: [] };
  const result = buildDfa([{ ast: { t: 'rep', x: empty, min: 1e12, max: 1e12 }, tag: 0 }], {
    maxStates: 32767,
  });
  assert.equal(result.ok, false);
});

// --- Compile-time limits -------------------------------------------------------------------------

function timed<T>(run: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = run();
  return { value, ms: performance.now() - started };
}

test('300 overlapping routes build in under 20s, with correct accept sets', () => {
  const r = lcg(300 * 7 + 1);
  const paths = overlap(300, r);
  const inputs = inputsFor(paths);
  const { value, ms } = timed(() => buildDfa(inputs, { maxStates: SCALE_BUDGET }));
  assert.ok(ms < OVERLAP_300_LIMIT_MS, 'over the 20s limit');
  assert.ok(value.ok, 'unexpected state-budget result');
  const several = assertRouteAccepts(value.dfa, paths, routeUrls(paths, 4_000, r), 'overlap 300');
  assert.ok(several > 400, `only ${several} URLs matched 2+ routes`);
});

test('1000 overlapping routes return state-budget in under 20s', () => {
  const inputs = inputsFor(overlap(1000, lcg(1000 * 7 + 1)));
  for (const maxStates of [32767, SCALE_BUDGET]) {
    const { value, ms } = timed(() => buildDfa(inputs, { maxStates }));
    assert.ok(ms < OVERLAP_1000_LIMIT_MS, `over the 20s limit at maxStates ${maxStates}`);
    assert.deepEqual(value, { ok: false, reason: 'state-budget', states: maxStates + 1 });
  }
});

test('3000 REST routes build in under 2s, with correct accept sets', () => {
  const r = lcg(3000 * 7 + 1);
  const paths = restApi(3000, r);
  const inputs = inputsFor(paths);
  const { value, ms } = timed(() => buildDfa(inputs, { maxStates: SCALE_BUDGET }));
  assert.ok(ms < REST_3000_LIMIT_MS, 'over the 2s limit');
  assert.ok(value.ok, 'unexpected state-budget result');
  assertRouteAccepts(value.dfa, paths, routeUrls(paths, 1_000, r), 'rest 3000');
});

test('a chain of 200k states minimizes under 2s, which needs the smaller split', () => {
  // Each round splits one state off a chain. Handling the larger half instead would scan the
  // whole chain every round: 200k rounds of 200k states.
  const chain: Ast = { t: 'cat', xs: Array.from({ length: 200_000 }, () => literal('a').ast) };
  const before = raw([{ ast: chain, tag: 0 }]);
  assert.equal(before.states, 200_001);
  const { value, ms } = timed(() => minimize(before));
  assert.ok(ms < CHAIN_LIMIT_MS, 'over the 2s limit');
  assert.equal(value.states, 200_001);
});

test('Hopcroft agrees with Moore on real route shapes', () => {
  const r = lcg(1);
  const tables = [overlap(60, r), restApi(120, r)];
  tables.forEach((paths, n) => {
    const before = raw(inputsFor(paths));
    const after = minimize(before);
    assertEquivalent(before, after, `route table ${n}`);
    assertMinimal(after, `route table ${n}`);

    // Giving every route the same tag leaves far more to merge.
    const shared = raw(paths.map((path) => ({ ast: routeAst(path), tag: 0 })));
    const merged = minimize(shared);
    assertEquivalent(shared, merged, `shared-tag route table ${n}`);
    assertMinimal(merged, `shared-tag route table ${n}`);
    assert.ok(merged.states < shared.states, `route table ${n} merged nothing`);
  });
});
