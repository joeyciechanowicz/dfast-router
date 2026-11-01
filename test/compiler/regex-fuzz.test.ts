import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFragment, parseRegExp } from '../../src/compiler/regex-parser';
import { ALPHABET, QMARK } from '../../src/compiler/types';
import type { Ast, Parsed } from '../../src/compiler/types';
import { takeNumberFlag } from '../../bench/flags.mjs';
import { astMatches } from '../helpers/ast-match';

// Every regex is checked against `RegExp` on a mix of random strings and strings built to match it.
// Reproduce a failure with `tsx test/compiler/regex-fuzz.test.ts --seed <seed>`. --pairs sets the
// pairs per test. Both need that direct run, because `npm test` passes no flags to test files.
const SEED = takeNumberFlag('--seed', 20261030);
const PAIRS = takeNumberFlag('--pairs', 150_000);
const MAX_INPUT = 14;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let rng = mulberry32(SEED);
const int = (n: number) => Math.floor(rng() * n);
const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)];
const chance = (p: number) => rng() < p;

const ASCII = Array.from({ length: 128 }, (_, unit) => String.fromCharCode(unit)).filter(
  (ch) => ch !== '?',
);
const ABOVE_ASCII = [
  '\u0080', 'é', 'É', 'ß', 'ÿ', 'Ÿ', 'µ', 'ı', 'İ', 'ſ', 'K', ' ', ' ', ' ',
  ' ', ' ', ' ', ' ', '　', '﻿', '\ud83d', '\ude00', '￿',
];
const ALL_CHARS = [...ASCII, ...ABOVE_ASCII];
const FAVOURITE_CHARS = [...'abzABZ019-_/., {},\n\r\t\\[]^$|()*+\0\x01\b'];

const isAscii = (input: string) => /^[\0-\x7f]*$/.test(input);
/** `\0` next to a generated digit is a legacy octal escape, which the parser rejects on purpose. */
const LEGACY_OCTAL = /\\0\d/;
const withoutQmark = (input: string) => input.replace(/\?/g, '');

// --- Regexes the parser must accept, each with a way to build a string it matches ----------------

interface Gen {
  src: string;
  sample: () => string;
}

const fixed = (src: string, text = src): Gen => ({ src, sample: () => text });

/** Samples a character that `src` matches, found by asking `RegExp`. */
function oneCharOf(src: string): Gen {
  let hits: string[] | null = null;
  return {
    src,
    sample: () => {
      if (hits === null) {
        const regex = new RegExp(`^(?:${src})$`);
        hits = ALL_CHARS.filter((ch) => regex.test(ch));
      }
      return hits.length === 0 ? '' : pick(hits);
    },
  };
}

const ATOMS: readonly Gen[] = [
  ...[...'abzABZ019-_/., :=%~{}]'].map((ch) => fixed(ch)),
  ...[...'é€😀'].map((ch) => fixed(ch)),
  ...[...'.*+()[]{}|^$\\/-'].map((ch) => fixed(`\\${ch}`, ch)),
  ...['.', '\\d', '\\D', '\\w', '\\W', '\\s', '\\S'].map(oneCharOf),
  ...[...'aegzAEZ_ %~'].map((ch) => fixed(`\\${ch}`, ch)),
  fixed('\\?', ''),
  fixed('\\t', '\t'),
  fixed('\\n', '\n'),
  fixed('\\r', '\r'),
  fixed('\\f', '\f'),
  fixed('\\v', '\v'),
  fixed('\\0', '\0'),
  fixed('\\cA', '\x01'),
  fixed('\\cz', '\x1a'),
  fixed('\\x41', 'A'),
  fixed('\\x7a', 'z'),
  fixed('\\xe9', 'é'),
  fixed('\\x4', 'x4'),
  fixed('\\xg', 'xg'),
  fixed('\\u0041', 'A'),
  fixed('\\u007a', 'z'),
  fixed('\\u00e9', 'é'),
  fixed('\\u2028', ' '),
  fixed('\\u12', 'u12'),
  fixed('\\u{2}', 'uu'),
];

const CLASS_ENDPOINTS: readonly (readonly [string, number])[] = [
  ['a', 97], ['b', 98], ['c', 99], ['z', 122], ['A', 65], ['C', 67], ['Z', 90], ['0', 48],
  ['9', 57], ['-', 45], ['\\-', 45], ['+', 43], ['.', 46], ['/', 47], ['\\/', 47], ['_', 95],
  ['`', 96], ['[', 91], ['\\]', 93], ['\\\\', 92], ['\\^', 94], ['{', 123], [' ', 32], ['~', 126],
  ['\\t', 9], ['\\n', 10], ['\\r', 13], ['\\0', 0], ['\\b', 8], ['\\cA', 1], ['\\x41', 65],
  ['\\x7f', 127], ['\\x80', 128], ['\\xe9', 233], ['\\xff', 255], ['\\u007a', 122],
  ['\\u2028', 0x2028], ['\\ufffe', 0xfffe], ['\\uffff', 0xffff], ['é', 233], ['ſ', 0x17f],
];
const SHORTHANDS = ['\\d', '\\D', '\\w', '\\W', '\\s', '\\S'];
const CLASS_LITERALS = [...'^$.|()*+{}[', '\\.', '\\$', '\\B', '\\e', '\\_', '\\x4', '\\u12', '\\u{41}'];

function classItem(): string {
  switch (int(8)) {
    case 0:
    case 1:
      return pick(CLASS_ENDPOINTS)[0];
    case 2:
    case 3:
    case 4: {
      const a = pick(CLASS_ENDPOINTS);
      const b = pick(CLASS_ENDPOINTS);
      return a[1] <= b[1] ? `${a[0]}-${b[0]}` : `${b[0]}-${a[0]}`;
    }
    case 5:
      return pick(SHORTHANDS);
    case 6:
      return pick([
        `${pick(SHORTHANDS)}-${pick(CLASS_ENDPOINTS)[0]}`,
        `${pick(CLASS_ENDPOINTS)[0]}-${pick(SHORTHANDS)}`,
        `${pick(SHORTHANDS)}-${pick(SHORTHANDS)}`,
        '-',
      ]);
    default:
      return pick(CLASS_LITERALS);
  }
}

function charClass(): Gen {
  const items = Array.from({ length: int(4) }, classItem).join('');
  return oneCharOf(`[${chance(0.35) ? '^' : ''}${items}]`);
}

interface Quantifier {
  src: string;
  min: number;
  max: number;
  literal?: string;
}

const COUNTED: readonly Quantifier[] = [
  { src: '*', min: 0, max: 3 },
  { src: '+', min: 1, max: 3 },
  { src: '?', min: 0, max: 1 },
  { src: '*?', min: 0, max: 3 },
  { src: '+?', min: 1, max: 3 },
  { src: '??', min: 0, max: 1 },
  { src: '{0}', min: 0, max: 0 },
  { src: '{2}', min: 2, max: 2 },
  { src: '{02}', min: 2, max: 2 },
  { src: '{1,2}', min: 1, max: 2 },
  { src: '{0,2}', min: 0, max: 2 },
  { src: '{2,}', min: 2, max: 4 },
  { src: '{2}?', min: 2, max: 2 },
  { src: '{1,2}?', min: 1, max: 2 },
  { src: '{2,}?', min: 2, max: 4 },
];
/** Forms that are not quantifiers, and so are literal text. */
const LITERAL_BRACES = ['{,3}', '{,}', '{}', '{x}', '{ 2}', '{2, 3}', '{2,', '{2', '{'];

function term(depth: number, nextName: () => string): Gen {
  const a = atom(depth, nextName);
  if (chance(0.5)) return a;
  if (chance(0.1)) {
    const braces = pick(LITERAL_BRACES);
    return { src: a.src + braces, sample: () => a.sample() + braces };
  }
  const q = pick(COUNTED);
  return {
    src: a.src + q.src,
    sample: () => {
      let text = '';
      for (let k = q.min + int(q.max - q.min + 1); k > 0; k -= 1) text += a.sample();
      return text;
    },
  };
}

function atom(depth: number, nextName: () => string): Gen {
  const roll = rng();
  if (depth > 0 && roll < 0.25) {
    const inner = alternatives(depth - 1, nextName);
    const open = pick(['(', '(?:', `(?<${nextName()}>`]);
    return { src: `${open}${inner.src})`, sample: inner.sample };
  }
  if (roll < 0.5) return charClass();
  return pick(ATOMS);
}

function sequence(depth: number, nextName: () => string): Gen {
  const terms = Array.from({ length: int(4) }, () => term(depth, nextName));
  return {
    src: terms.map((x) => x.src).join(''),
    sample: () => terms.map((x) => x.sample()).join(''),
  };
}

function alternatives(depth: number, nextName: () => string): Gen {
  const xs = Array.from({ length: 1 + int(3) }, () => sequence(depth, nextName));
  return { src: xs.map((x) => x.src).join('|'), sample: () => pick(xs).sample() };
}

function counter(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `g${n}`;
  };
}

/** Every top-level alternative may carry its own anchors. */
function wholePath(): Gen {
  const nextName = counter();
  const xs = Array.from({ length: 1 + int(2) }, () => {
    const body = sequence(2, nextName);
    const start = chance(0.5);
    const end = chance(0.5);
    const pad = (anchored: boolean) => (anchored || chance(0.5) ? '' : randomString(3));
    return {
      src: `${start ? '^' : ''}${body.src}${end ? '$' : ''}`,
      sample: () => pad(start) + body.sample() + pad(end),
    };
  });
  return { src: xs.map((x) => x.src).join('|'), sample: () => pick(xs).sample() };
}

// --- Token soup: mostly the legacy syntax and rejected constructs, often invalid -----------------

const SOUP = [
  '^', '$', '|', '(', ')', '(?:', '(?<n>', '(?=', '(?!', '(?<=', '(?<!', '(?i:', '(?-i:', '[', ']',
  '[^', '-', '\\', '.', '*', '+', '?', '{', '}', ',', '{2}', '{,3}', '{2,}', '{1,2}', '{0}', '\\b',
  '\\B', '\\0', '\\00', '\\01', '\\08', '\\1', '\\2', '\\7', '\\8', '\\9', '\\12', '\\377', '\\400',
  '\\c', '\\cA', '\\ca', '\\c1', '\\c_', '\\c!', '\\x', '\\x4', '\\x41', '\\xe9', '\\u', '\\u004',
  '\\u0041', '\\u{41}', '\\k', '\\k<n>', '\\p', '\\P', '\\p{L}', '\\P{L}', '\\d', '\\D', '\\w',
  '\\W', '\\s', '\\S', '\\-', '\\/', '\\]', '\\^', '\\n', '\\r', '\\t', 'a', 'A', 'z', 'Z', '0',
  '1', '8', 'é', 'ſ', '😀', '_', '/', ' ', '\n',
];

function soup(): string {
  const body = Array.from({ length: 1 + int(7) }, () => pick(SOUP)).join('');
  return chance(0.3) ? `[${body}]` : body;
}

// --- Inputs --------------------------------------------------------------------------------------

function randomChar(): string {
  const roll = rng();
  if (roll < 0.6) return pick(FAVOURITE_CHARS);
  if (roll < 0.9) return pick(ASCII);
  return pick(ABOVE_ASCII);
}

function randomString(maxLength: number): string {
  let text = '';
  for (let k = int(maxLength + 1); k > 0; k -= 1) text += randomChar();
  return text;
}

function mutate(text: string): string {
  const at = int(text.length + 1);
  switch (int(3)) {
    case 0:
      return text.slice(0, at) + randomChar() + text.slice(at);
    case 1:
      return text.slice(0, at) + text.slice(at + 1);
    default:
      return text.slice(0, at) + randomChar() + text.slice(at + 1);
  }
}

/** Random strings, built from the characters in the source. */
function fromSource(src: string): string {
  const chars = [...src];
  let text = '';
  for (let k = int(9); k > 0; k -= 1) text += chance(0.7) ? pick(chars) : randomChar();
  return text;
}

function inputsFor(src: string, sample: () => string): string[] {
  const inputs: string[] = [];
  for (let k = 0; k < 5; k += 1) {
    const text = sample();
    inputs.push(text, mutate(text));
  }
  inputs.push(randomString(8), randomString(4), randomString(2), fromSource(src), fromSource(src));
  return inputs.map(withoutQmark).filter((input) => input.length <= MAX_INPUT);
}

// --- Checks --------------------------------------------------------------------------------------

interface Stats {
  regexes: number;
  invalid: number;
  rejected: number;
  pairs: number;
  matched: number;
  asciiPairs: number;
  nonAsciiPairs: number;
  overAccepted: number;
}

const newStats = (): Stats => ({
  regexes: 0,
  invalid: 0,
  rejected: 0,
  pairs: 0,
  matched: 0,
  asciiPairs: 0,
  nonAsciiPairs: 0,
  overAccepted: 0,
});

const describeCase = (label: string, input?: string) =>
  `seed=${SEED} ${label}${input === undefined ? '' : ` input=${JSON.stringify(input)}`}`;

function assertSetsAreWellFormed(ast: Ast, label: string): void {
  switch (ast.t) {
    case 'set':
      assert.equal(ast.set.length, ALPHABET, describeCase(label));
      assert.equal(ast.set[QMARK], 0, describeCase(label));
      break;
    case 'cat':
    case 'alt':
      for (const x of ast.xs) assertSetsAreWellFormed(x, label);
      break;
    case 'rep':
      assertSetsAreWellFormed(ast.x, label);
  }
}

function groupNames(regex: RegExp): string[] {
  const matched = new RegExp(`${regex.source}|`).exec('');
  return Object.keys(matched?.groups ?? {});
}

/** `Parsed` for a regex known to be valid, compared with `oracle` on every input. */
function compare(
  parsed: Extract<Parsed, { ok: true }>,
  oracle: RegExp,
  inputs: string[],
  label: string,
  stats: Stats,
): void {
  assertSetsAreWellFormed(parsed.ast, label);
  assert.deepEqual(parsed.names, groupNames(oracle), `names: ${describeCase(label)}`);
  for (const input of inputs) {
    const expected = oracle.test(input);
    const actual = astMatches(parsed.ast, input);
    stats.pairs += 1;
    if (expected) stats.matched += 1;
    if (isAscii(input)) {
      stats.asciiPairs += 1;
      assert.equal(actual, expected, `ASCII mismatch: ${describeCase(label, input)}`);
    } else {
      stats.nonAsciiPairs += 1;
      if (expected) assert.ok(actual, `under-accepts: ${describeCase(label, input)}`);
      else if (actual) stats.overAccepted += 1;
    }
  }
}

function report(name: string, stats: Stats): void {
  console.log(`regex fuzz ${name}: seed=${SEED} ${JSON.stringify(stats)}`);
}

function assertWorthwhile(stats: Stats): void {
  assert.ok(stats.pairs >= 100_000, `only ${stats.pairs} pairs`);
  const matchRate = stats.matched / stats.pairs;
  assert.ok(matchRate > 0.05 && matchRate < 0.95, `match rate ${matchRate} proves too little`);
  assert.ok(stats.asciiPairs > 50_000, `only ${stats.asciiPairs} ASCII pairs`);
  assert.ok(stats.nonAsciiPairs > 5_000, `only ${stats.nonAsciiPairs} non-ASCII pairs`);
}

test('fuzz: fragments the parser must accept', () => {
  rng = mulberry32(SEED);
  const stats = newStats();
  while (stats.pairs < PAIRS) {
    const { src, sample } = alternatives(2, counter());
    if (LEGACY_OCTAL.test(src)) continue;
    const label = `fragment ${JSON.stringify(src)}`;
    stats.regexes += 1;
    let oracle: RegExp;
    try {
      oracle = new RegExp(`^(?:${src})$`);
      new RegExp(src);
    } catch {
      stats.invalid += 1;
      assert.equal(parseFragment(src).ok, false, `accepts invalid: ${describeCase(label)}`);
      continue;
    }
    const parsed = parseFragment(src);
    assert.ok(parsed.ok, `rejects: ${describeCase(label)}: ${parsed.ok ? '' : parsed.reason}`);
    compare(parsed, oracle, inputsFor(src, sample), label, stats);
  }
  report('fragments', stats);
  assertWorthwhile(stats);
});

test('fuzz: whole-path regexes the parser must accept', () => {
  rng = mulberry32(SEED + 1);
  const stats = newStats();
  while (stats.pairs < PAIRS) {
    const { src, sample } = wholePath();
    if (LEGACY_OCTAL.test(src)) continue;
    const flags = pick(['', '', 'i', 's', 'is']);
    const label = `/${src}/${flags}`;
    stats.regexes += 1;
    let oracle: RegExp;
    try {
      oracle = new RegExp(src, flags);
    } catch {
      stats.invalid += 1;
      continue;
    }
    const parsed = parseRegExp(oracle);
    assert.ok(parsed.ok, `rejects: ${describeCase(label)}: ${parsed.ok ? '' : parsed.reason}`);
    compare(parsed, oracle, inputsFor(src, sample), label, stats);
  }
  report('whole paths', stats);
  assertWorthwhile(stats);
});

test('fuzz: token soup is exact, rejected, or invalid', () => {
  rng = mulberry32(SEED + 2);
  const stats = newStats();
  while (stats.pairs < PAIRS) {
    const src = soup();
    const flags = pick(['', '', 'i', 's']);
    const fragment = chance(0.5);
    const label = fragment ? `fragment ${JSON.stringify(src)}` : `/${src}/${flags}`;
    stats.regexes += 1;
    let valid: RegExp;
    let oracle: RegExp;
    try {
      valid = new RegExp(src, fragment ? '' : flags);
      oracle = fragment ? new RegExp(`^(?:${src})$`) : valid;
    } catch {
      stats.invalid += 1;
      if (fragment) assert.equal(parseFragment(src).ok, false, describeCase(label));
      continue;
    }
    const parsed = fragment ? parseFragment(src) : parseRegExp(valid);
    if (!parsed.ok) {
      stats.rejected += 1;
      continue;
    }
    const sample = () => (chance(0.5) ? fromSource(src) : randomString(5));
    compare(parsed, oracle, inputsFor(src, sample), label, stats);
  }
  report('token soup', stats);
  assertWorthwhile(stats);
});
