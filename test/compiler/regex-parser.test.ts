import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFragment, parseRegExp } from '../../src/compiler/regex-parser';
import { ALPHABET, NON_ASCII, QMARK, SLASH } from '../../src/compiler/types';
import type { Ast, CharSet, Parsed } from '../../src/compiler/types';
import { astMatches } from '../helpers/ast-match';

const ASCII_CHARS = Array.from({ length: 128 }, (_, unit) => String.fromCharCode(unit)).filter(
  (ch) => ch !== '?',
);
const ABOVE_ASCII = [
  '\u0080', 'é', 'É', 'ß', 'ÿ', 'Ÿ', 'µ', 'ı', 'İ', 'ſ', 'K', ' ', ' ', ' ',
  ' ', ' ', ' ', ' ', '　', '﻿', '\ud83d', '\ude00', '￿',
];
const TWO_CHAR_POOL = ['a', 'b', 'A', 'B', 'z', 'Z', '0', '9', '-', '/', '_', ' ', '\n', '\r', '\t'];
const TWO_CHARS = TWO_CHAR_POOL.flatMap((x) => TWO_CHAR_POOL.map((y) => x + y));
const SWEEP = ['', ...ASCII_CHARS, ...TWO_CHARS];

const isAscii = (input: string) => /^[\0-\x7f]*$/.test(input);

function ok(parsed: Parsed, label: string): { ast: Ast; names: string[] } {
  assert.ok(parsed.ok, `${label}: ${parsed.ok ? '' : parsed.reason}`);
  return parsed;
}

/** Agreement with `oracle` on every ASCII string given, and no under-accepting above ASCII. */
function assertAgrees(ast: Ast, oracle: RegExp, extra: string[], label: string): void {
  for (const input of [...SWEEP, ...extra]) {
    if (input.includes('?')) continue;
    const message = `${label} on ${JSON.stringify(input)}`;
    const expected = oracle.test(input);
    if (isAscii(input)) assert.equal(astMatches(ast, input), expected, message);
    else if (expected) assert.ok(astMatches(ast, input), `under-accepts: ${message}`);
  }
  for (const ch of ABOVE_ASCII) {
    if (oracle.test(ch)) assert.ok(astMatches(ast, ch), `under-accepts: ${label} on ${ch}`);
  }
}

/** `no` only binds the AST on ASCII, because it may over-accept above it. */
function assertRegex(regex: RegExp, yes: string[] = [], no: string[] = []): Ast {
  const { ast } = ok(parseRegExp(regex), String(regex));
  assertAgrees(ast, regex, [...yes, ...no], String(regex));
  for (const input of yes) assert.ok(regex.test(input), `${regex} should match ${input}`);
  for (const input of no) assert.ok(!regex.test(input), `${regex} should not match ${input}`);
  for (const input of yes) assert.ok(astMatches(ast, input), `${regex} on ${input}`);
  for (const input of no.filter(isAscii)) assert.ok(!astMatches(ast, input), `${regex} on ${input}`);
  return ast;
}

function assertFragment(source: string, yes: string[] = [], no: string[] = []): Ast {
  const { ast } = ok(parseFragment(source), source);
  const oracle = new RegExp(`^(?:${source})$`);
  assertAgrees(ast, oracle, [...yes, ...no], source);
  for (const input of yes) assert.ok(oracle.test(input), `${source} should match ${input}`);
  for (const input of no) assert.ok(!oracle.test(input), `${source} should not match ${input}`);
  for (const input of yes) assert.ok(astMatches(ast, input), `${source} on ${input}`);
  for (const input of no.filter(isAscii)) {
    assert.ok(!astMatches(ast, input), `${source} on ${input}`);
  }
  return ast;
}

function setOf(ast: Ast): CharSet {
  assert.equal(ast.t, 'set');
  return (ast as { t: 'set'; set: CharSet }).set;
}

function assertRejected(parsed: Parsed, reason: RegExp, label: string): void {
  assert.equal(parsed.ok, false, `${label} should be rejected`);
  if (!parsed.ok) assert.match(parsed.reason, reason, label);
}

test('sets have one byte per symbol, and never hold `?`', () => {
  for (const source of ['.', '[^a]', '\\D', '\\W', '\\S', '[\\s\\S]', '[^]', '\\?', '[?]']) {
    const set = setOf(ok(parseFragment(source), source).ast);
    assert.equal(set.length, ALPHABET, source);
    assert.equal(set[QMARK], 0, source);
    assert.ok(set.every((bit) => bit === 0 || bit === 1), source);
  }
});

test('only `?` is masked: sets can cross `/`', () => {
  assertFragment('.+', ['a/b'], ['']);
  assertFragment('[^a]+', ['b/c'], ['a']);
  assertFragment('\\D+', ['/'], ['1']);
  assert.equal(setOf(ok(parseFragment('.'), '.').ast)[SLASH], 1);
});

test('a `?` in a regex can never match, because it ends the path', () => {
  assert.ok(!astMatches(ok(parseFragment('\\?'), '\\?').ast, ''));
  assertFragment('a\\?', [], ['a']);
  assertFragment('[?]', [], ['a', '']);
  assertFragment('a\\?*b', ['ab'], []);
  assertFragment('[^?]+', ['abc'], ['']);
  assertRegex(/\?/, [], ['a']);
});

test('^ and $ without `m` mean only the ends of the input', () => {
  assertRegex(/^a$/, ['a'], ['a\n', '\na', 'ab', 'ba', '']);
  assertRegex(/^a/, ['a', 'ab', 'a\nb'], ['ba', '\na']);
  assertRegex(/a$/, ['a', 'ba'], ['a\n', 'ab']);
  assertRegex(/^$/, [''], ['\n', 'a']);
  assertRegex(/^^a$$/, ['a'], ['a\n', 'ba']);
});

test('an unanchored side matches anything but `?`, including newlines', () => {
  assertRegex(/a/, ['a', 'xax', '\na\n', 'é a é'], ['', 'b']);
  assertRegex(new RegExp(''), ['', 'abc', '\n']);
  assertRegex(/(?:)/, ['', 'abc']);
});

test('anchors bind to their own top-level alternative', () => {
  assertRegex(/^a|b$/, ['a', 'ab', 'b', 'ab', 'xb'], ['xa', 'bx']);
  assertRegex(/^a$|^b$/, ['a', 'b'], ['ab', 'ba', 'xa']);
  assertRegex(/a|^b/, ['a', 'xa', 'b', 'bx'], ['xb']);
  assertRegex(/^|a/, ['', 'b']);
  assertRegex(/^|$/, ['', 'b']);
  assertRegex(/^a$|/, ['a', 'b', '']);
  assertRegex(/^(a|b)$/, ['a', 'b'], ['ab', 'xa']);
});

test('`.` excludes line terminators unless `s` is set', () => {
  const dot = assertFragment('.', ['a', ' ', '\t', '\0', '\x7f'], ['\n', '\r', '']);
  assert.equal(setOf(dot)[NON_ASCII], 1);
  assertRegex(/^.$/, ['é'], ['\n', '\r', ' ', ' ']);
  assertRegex(/^.$/s, ['a', '\n', '\r', ' ', ' ']);
  assertRegex(/^[^]$/, ['a', '\n', '\r', ' ']);
});

test('\\s, \\d, and \\w are exact on ASCII', () => {
  const space = setOf(assertFragment('\\s', ['\t', '\n', '\v', '\f', '\r', ' '], ['\0', '\x85']));
  assert.deepEqual(
    Array.from({ length: NON_ASCII }, (_, s) => s).filter((s) => space[s] === 1),
    [9, 10, 11, 12, 13, 32],
  );
  assert.equal(space[NON_ASCII], 1);
  assertFragment('\\S', ['a', '\0', '\x1c', '\x7f'], [' ', '\n', ' ', '﻿']);
  assertFragment('\\d', ['0', '9'], ['/', ':', 'a', '٣']);
  assertFragment('\\w', ['0', 'a', 'Z', '_'], ['-', ' ', 'é', '`', '[', '@', '{']);
  assertFragment('\\D', ['/', 'é'], ['0']);
  assertFragment('\\W', ['-', 'é'], ['_', 'a']);
});

test('quantifiers', () => {
  assertFragment('a*', ['', 'a', 'aaa'], ['b']);
  assertFragment('a+', ['a', 'aaa'], ['']);
  assertFragment('a?', ['', 'a'], ['aa']);
  assertFragment('a{2}', ['aa'], ['a', 'aaa']);
  assertFragment('a{2,}', ['aa', 'aaaaa'], ['a']);
  assertFragment('a{2,3}', ['aa', 'aaa'], ['a', 'aaaa']);
  assertFragment('a{0}', [''], ['a']);
  assertFragment('a{0}b', ['b'], ['ab']);
  assertFragment('a{0,0}', [''], ['a']);
  assertFragment('a{1}', ['a'], ['', 'aa']);
  assertFragment('a{1,1}', ['a'], ['', 'aa']);
  assertFragment('a{02}', ['aa'], ['a']);
  assertFragment('(ab){2}', ['abab'], ['ab', 'ababab']);
  assertFragment('(a|bc){2}', ['aa', 'abc', 'bca', 'bcbc'], ['a', 'bc']);
  assertFragment('[ab]{2,3}c', ['abc', 'abac'], ['ac', 'ababc']);
});

test('lazy quantifiers keep the same language', () => {
  assertFragment('a*?', ['', 'aaa'], ['b']);
  assertFragment('a+?', ['a', 'aa'], ['']);
  assertFragment('a??', ['', 'a'], ['aa']);
  assertFragment('a{2}?', ['aa'], ['a', 'aaa']);
  assertFragment('a{1,2}?b', ['ab', 'aab'], ['b', 'aaab']);
  assertFragment('a{2,}?', ['aa', 'aaa'], ['a']);
  assertRegex(/^(a+?)(a*?)$/, ['a', 'aaa'], ['']);
});

test('a `{` that is not a quantifier is literal', () => {
  assertFragment('a{,3}', ['a{,3}'], ['', 'a', 'aaa']);
  assertFragment('a{,}', ['a{,}'], ['a']);
  assertFragment('a{', ['a{'], ['a']);
  assertFragment('a{2', ['a{2'], ['aa']);
  assertFragment('a{2,', ['a{2,'], ['aa']);
  assertFragment('a{x}', ['a{x}'], ['a']);
  assertFragment('a{ 2}', ['a{ 2}'], ['aa']);
  assertFragment('a{2, 3}', ['a{2, 3}'], ['aa']);
  assertFragment('a{}', ['a{}'], ['a']);
  assertFragment('{', ['{'], ['']);
  assertFragment('}', ['}'], ['']);
  assertFragment(']', [']'], ['']);
  assertFragment('{*', ['', '{', '{{'], ['a']);
  assertFragment('{{2}', ['{{'], ['{']);
  assertFragment('a{1}{', ['a{'], ['a']);
  assertFragment('\\{2}', ['{2}'], ['{{']);
  assertFragment('a\\{2}', ['a{2}'], ['aa']);
});

test('quantifiers apply to a single atom', () => {
  assertFragment('ab+', ['ab', 'abb'], ['abab']);
  assertFragment('a|b+', ['a', 'bb'], ['aa']);
  assertFragment('\\/a+', ['/a', '/aa'], ['/a/a']);
  assertFragment('\\x41+', ['AA'], ['']);
  assertFragment('\\u0041{2}', ['AA'], ['A']);
  assertFragment('\\cA+', ['\x01\x01'], ['']);
  assertFragment('😀+', ['😀', '😀\ude00']);
});

test('classes: `-` at the edges, and next to a shorthand', () => {
  assertFragment('[-a]', ['-', 'a'], ['b']);
  assertFragment('[a-]', ['-', 'a'], ['b']);
  assertFragment('[-]', ['-'], ['a']);
  assertFragment('[--]', ['-'], ['a']);
  assertFragment('[---]', ['-'], ['a', ',', '.']);
  assertFragment('[--/]', ['-', '.', '/'], ['0', ',']);
  assertFragment('[+--]', ['+', ',', '-'], ['*', '.']);
  assertFragment('[a-c-e]', ['a', 'b', 'c', '-', 'e'], ['d']);
  assertFragment('[\\d-x]', ['0', '9', '-', 'x'], ['a', 'w']);
  assertFragment('[a-\\d]', ['a', '-', '5'], ['b']);
  assertFragment('[\\d-\\w]', ['5', '-', 'q'], [' ']);
  assertFragment('[\\w-]', ['a', '-'], [' ']);
  assertFragment('[-\\w]', ['a', '-'], [' ']);
  assertFragment('[a\\-z]', ['a', '-', 'z'], ['b']);
  assertFragment('[\\--\\/]', ['-', '.', '/'], [',']);
  assertFragment('[\\b-c]', ['\b', 'a', 'c'], ['d', '\x07']);
});

test('classes: `[]`, `[^]`, and `]`', () => {
  assertFragment('[]', [], ['', 'a', ']']);
  assertFragment('[^]', ['a', '\n', '\r', 'é'], ['']);
  assertFragment('[]a]', [], ['a]', 'a', ']']);
  assertFragment('[^]a]', ['xa]', '\na]'], ['a]']);
  assertFragment('[\\]]', [']'], ['\\']);
  assertFragment('[[]', ['['], [']']);
  assertFragment('[a[b]', ['a', '[', 'b'], [']']);
  assertFragment('[^^]', ['a'], ['^']);
  assertFragment('[a^]', ['a', '^'], ['b']);
  assertFragment('[.$|()*+{}]', ['.', '$', '|', '(', ')', '*', '+', '{', '}'], ['a']);
  assertFragment('a[]|b', ['b'], ['a']);
  assertRegex(/[]/, [], ['a', '']);
  assertRegex(/[^]/, ['a', '\n'], ['']);
});

test('class escapes', () => {
  assertFragment('[\\d]', ['5'], ['a']);
  assertFragment('[\\D]', ['a'], ['5']);
  assertFragment('[\\s\\S]', ['a', ' ', '\n'], ['']);
  assertFragment('[\\b]', ['\b'], ['b', '\\']);
  assertFragment('[\\B]', ['B'], ['\b', '\\']);
  assertFragment('[\\t\\n\\r\\f\\v\\0]', ['\t', '\n', '\r', '\f', '\v', '\0'], ['t', 'n', '0']);
  assertFragment('[\\x41-\\x43]', ['A', 'B', 'C'], ['D', 'x', '4']);
  assertFragment('[\\u0041-Z]', ['A', 'Z'], ['a', 'u']);
  assertFragment('[\\cA-\\cC]', ['\x01', '\x03'], ['\x04', 'c']);
  assertFragment('[\\ca]', ['\x01'], ['a']);
  assertFragment('[\\.\\/\\$\\^\\\\]', ['.', '/', '$', '^', '\\'], ['a']);
  assertFragment('[\\x4]', ['x', '4'], ['\x04']);
  assertFragment('[\\u{41}]', ['u', '{', '4', '1', '}'], ['A']);
  assertFragment('[\\a\\e\\g]', ['a', 'e', 'g'], ['\x07']);
  assertFragment('[\\0-\\x1f]', ['\0', '\x1f'], [' ']);
  assertFragment('[\\0-9]', ['\0', '5'], [':']);
});

test('character escapes', () => {
  assertFragment('\\/', ['/'], ['\\/', '\\']);
  assertFragment('\\-', ['-'], ['\\']);
  assertFragment('\\.\\*\\+\\(\\)\\[\\]\\{\\}\\|\\^\\$\\\\', ['.*+()[]{}|^$\\'], []);
  assertFragment('\\0', ['\0'], ['0', '']);
  assertFragment('\\0a', ['\0a'], ['0a']);
  assertFragment('\\cA', ['\x01'], ['cA', 'A']);
  assertFragment('\\ca', ['\x01'], ['ca']);
  assertFragment('\\cZ', ['\x1a'], ['cZ']);
  assertFragment('\\t\\n\\v\\f\\r', ['\t\n\v\f\r'], ['tnvfr']);
  assertFragment('\\x41', ['A'], ['x41']);
  assertFragment('\\x4', ['x4'], ['\x04']);
  assertFragment('\\xg', ['xg'], []);
  assertFragment('\\x', ['x'], ['']);
  assertFragment('\\u0041', ['A'], ['u0041']);
  assertFragment('\\u004', ['u004'], ['\x04']);
  assertFragment('\\u', ['u'], ['']);
  assertFragment('\\u{2}', ['uu'], ['u{2}', '\x02']);
  assertFragment('\\a\\e\\g\\h\\i\\j\\l\\m\\o\\q\\y\\z', ['aeghijlmoqyz'], []);
  assertFragment('\\A\\C\\E\\Z\\_\\ \\%\\~', ['ACEZ_ %~'], []);
  assertFragment('\\é', ['é']);
});

test('groups', () => {
  assertFragment('(a)', ['a'], ['']);
  assertFragment('(?:a)', ['a'], ['']);
  assertFragment('(?<x>a)', ['a'], ['']);
  assertFragment('(?:)', [''], ['a']);
  assertFragment('()', [''], ['a']);
  assertFragment('(?:)*', [''], ['a']);
  assertFragment('()+', [''], ['a']);
  assertFragment('(a|)', ['', 'a'], ['b']);
  assertFragment('(|a)', ['', 'a'], ['b']);
  assertFragment('(|)', [''], ['a']);
  assertFragment('(a*)*', ['', 'aa'], ['b']);
  assertFragment('(a|)*b', ['b', 'aab'], ['a']);
  assertFragment('(|a)+b', ['b', 'aab'], ['a']);
  assertFragment('(a*){2,}', ['', 'aaa'], ['b']);
  assertFragment('(a|ab)(c|bcd)(d*)', ['abcd', 'ac', 'abc', 'abcdd'], ['ab']);
  assertFragment('(?:(?:a|b)c){1,2}', ['ac', 'bcac'], ['c', 'acacac']);
});

test('alternatives, including empty ones', () => {
  assertFragment('a|b', ['a', 'b'], ['', 'ab']);
  assertFragment('a|', ['a', ''], ['b']);
  assertFragment('|a', ['a', ''], ['b']);
  assertFragment('|', [''], ['a']);
  assertFragment('a||b', ['a', '', 'b'], ['c']);
  assertFragment('', [''], ['a']);
  assertRegex(/a|/, ['b', '']);
  assertRegex(/|/, ['b', '']);
});

test('case folding under `i`', () => {
  assertRegex(/^a$/i, ['a', 'A'], ['b']);
  assertRegex(/^[a-c]$/i, ['a', 'B', 'c', 'C'], ['d', 'D']);
  assertRegex(/^[A-C]$/i, ['a', 'B'], ['d', 'D']);
  assertRegex(/^[Z-a]$/i, ['Z', 'z', '[', '\\', ']', '^', '_', '`', 'a', 'A'], ['b', 'y']);
  assertRegex(/^[^a]$/i, ['b'], ['a', 'A']);
  assertRegex(/^[^a-z]$/i, ['0', '`', '{', '@', '['], ['a', 'Z', 'q', 'Q']);
  assertRegex(/^[^Z-a]$/i, ['b', 'Y'], ['z', 'Z', '_', 'a', 'A']);
  assertRegex(/^\x41$/i, ['a', 'A']);
  assertRegex(/^a$/i, ['a', 'A']);
  assertRegex(/^[\x41-\x43]$/i, ['b'], ['d']);
  assertRegex(/^\w$/i, ['a', 'Z', '_'], ['-', 'ſ', 'K']);
  assertRegex(/^\W$/i, ['-', 'ſ', 'K'], ['a', 's', 'k', 'S', 'K']);
  assertRegex(/^[^\W]$/i, ['a', 'K'], ['-']);
  assertRegex(/^[^\w]$/i, ['-', 'ſ'], ['a', 'S']);
  assertRegex(/^[\W]$/i, ['-'], ['s', 'S']);
  assertRegex(/^\/Users\/[a-z]+$/i, ['/USERS/bob', '/users/BOB'], ['/users/1']);
});

test('nothing above ASCII folds onto ASCII without `u`', () => {
  assertRegex(/^ſ$/i, ['ſ'], ['s', 'S']);
  assertRegex(/^K$/i, ['K'], ['k', 'K']);
  assertRegex(/^ı$/i, ['ı'], ['i', 'I']);
  assertRegex(/^İ$/i, ['İ'], ['i', 'I']);
  assertRegex(/^[ſK]$/i, [], ['s', 'S', 'k', 'K']);
  assertRegex(/^[a-z]$/i, [], ['ſ', 'K', 'ı', 'İ']);
  assertRegex(/^é$/i, ['é', 'É'], ['e']);
});

test('sets are exact on ASCII and never under-accept, across every code unit', () => {
  const classes = [
    '.', '\\s', '\\S', '\\d', '\\D', '\\w', '\\W', '[^a]', '[^é]', '[^\\s]', '[^\\S]', '[^\\d]',
    '[^\\D]', '[^\\w]', '[^\\W]', '[\\s\\S]', '[^\\s\\S]', '[\\d\\D]', '[^\\d\\D]', '[é]', '[é-ÿ]',
    '[a-é]', '[^a-é]', '[\\x80-\\xff]', '[^\\x80-\\xff]', '[\\u0080-\\uffff]', '[^\\u0080-\\uffff]',
    '[\\u0000-\\uffff]', '[^\\u0000-\\uffff]', '[\\x7f-\\x80]', '[^\\x7f-\\x80]', '[^\\x81-\\uffff]',
    '[\\u0080-\\ufffe]', '[^\\u0080-\\ufffe]', '[^\\u00a0\\ufeff]', '[^ſ\\u212a]', '[ſ-ſ]', '[^]',
  ];
  for (const flags of ['', 'i', 's', 'is']) {
    for (const source of classes) {
      const regex = new RegExp(`^${source}$`, flags);
      const { ast } = ok(parseRegExp(regex), String(regex));
      for (let unit = 0; unit <= 0xffff; unit += 1) {
        if (unit === QMARK) continue;
        const input = String.fromCharCode(unit);
        const expected = regex.test(input);
        if (unit < NON_ASCII) assert.equal(astMatches(ast, input), expected, `${regex} on ${unit}`);
        else if (expected) assert.ok(astMatches(ast, input), `${regex} under-accepts ${unit}`);
      }
    }
  }
});

test('sets stay tight above ASCII where they can', () => {
  for (const source of ['\\d', '\\w', '[^\\D]', '[^\\W]', '[a-z]', '[^\\u0080-\\uffff]', 'a']) {
    assert.equal(setOf(ok(parseFragment(source), source).ast)[NON_ASCII], 0, source);
  }
  for (const source of ['é', '[é]', '[^é]', '[^\\s]', '[^a]', '\\s', '\\S', '\\D', '\\W', '.']) {
    assert.equal(setOf(ok(parseFragment(source), source).ast)[NON_ASCII], 1, source);
  }
});

test('non-ASCII literals are read one code unit at a time', () => {
  const ast = assertFragment('café', ['café'], ['cafe']);
  assert.ok(astMatches(ast, 'cafü'), 'NON_ASCII is one symbol, so `miss` has to confirm this');
  assertFragment('[é]', ['é'], ['e']);
  assertFragment('😀', ['😀'], ['']);
  assertRegex(/^café$/, ['café']);
});

test('names lists named groups, in order', () => {
  assert.deepEqual(ok(parseFragment('(?<a>x)(y)(?<b>z)'), '').names, ['a', 'b']);
  assert.deepEqual(ok(parseFragment('(?<a>(?<b>x)|(?<c>y))'), '').names, ['a', 'b', 'c']);
  assert.deepEqual(ok(parseFragment('(a)(?:b)'), '').names, []);
  assert.deepEqual(ok(parseFragment('(?<$_a1>x)'), '').names, ['$_a1']);
  assert.deepEqual(ok(parseFragment('(?<é>x)'), '').names, ['é']);
  assert.deepEqual(ok(parseFragment('(?<a>x){0}'), '').names, ['a']);
  assert.deepEqual(ok(parseFragment('[(?<a>x)]'), '').names, []);
  assert.deepEqual(ok(parseRegExp(/^\/v(?<major>\d+)\.(?<minor>\d+)$/), '').names, [
    'major',
    'minor',
  ]);
});

test('parseFragment matches the whole string', () => {
  assertFragment('a', ['a'], ['ab', 'ba', '']);
  assertFragment('a|bc', ['a', 'bc'], ['ac', 'abc']);
  assertFragment('[a-z]{2}-[A-Z]{2}', ['en-GB'], ['en-gb', 'en-GB-x']);
  assertFragment('(?:one|two)', ['one', 'two'], ['onetwo']);
});

test('supported flags', () => {
  assertRegex(/^a$/d, ['a'], ['b']);
  assertRegex(/^a.b$/dis, ['A\nB'], ['A\n']);
});

test('real route shapes', () => {
  assertRegex(/^\/api\/v\d+\/health$/, ['/api/v1/health', '/api/v22/health'], ['/api/v/health']);
  assertRegex(/^\/users\/\d+$/, ['/users/1'], ['/users/1/', '/users/a']);
  assertFragment('.+', ['a/b/c'], ['']);
  assertFragment('(catalog|portal)', ['catalog', 'portal'], ['catalogportal']);
  assertFragment('[0-9a-fA-F]{8}', ['deadBEEF'], ['deadBEE', 'deadBEEFa']);
  assertFragment('[A-Za-z0-9-]+', ['a-b-1'], ['a_b']);
});

test('rejects constructs with no exact AST', () => {
  const fragments: [string, RegExp][] = [
    ['(a)\\1', /backreference/],
    ['\\1(a)', /backreference/],
    ['(?<n>a)\\k<n>', /backreference/],
    ['(?=a)', /lookaround/],
    ['(?!a)', /lookaround/],
    ['(?<=a)', /lookaround/],
    ['(?<!a)', /lookaround/],
    ['(?=a)*', /lookaround/],
    ['\\b', /word boundary/],
    ['\\B', /word boundary/],
    ['\\p{L}', /property/],
    ['\\P{L}', /property/],
    ['[\\p{L}]', /property/],
    ['^a', /away from the ends/],
    ['a$', /away from the ends/],
    ['^a$', /away from the ends/],
    ['\\1', /octal/],
    ['\\12', /octal/],
    ['\\8', /octal/],
    ['\\00', /octal/],
    ['\\01', /octal/],
    ['[\\1]', /octal/],
    ['[\\8]', /octal/],
    ['[\\00]', /octal/],
    ['\\c', /`\\c`/],
    ['\\c1', /`\\c`/],
    ['[\\c]', /`\\c`/],
    ['[\\c1]', /`\\c`/],
    ['[\\c_]', /`\\c`/],
    ['\\k', /`\\k`/],
    ['[\\k]', /`\\k`/],
    ['\\k<n>', /`\\k`/],
    ['(?<\\u0061>x)', /escaped group name/],
    ['a{100001}', /repeats/],
    ['(?:a{1000}){1000}', /repeats/],
    ['(?:(?:a{1000}){1000}){1000}', /repeats/],
    ['(?:){100000000}', /repeats/],
    ['a{99999999999999999999}', /repeats/],
    ['a{1,99999999999}', /repeats/],
    [`a{${'9'.repeat(400)}}`, /repeats/],
    [`${'('.repeat(257)}a${')'.repeat(257)}`, /nested/],
    [`${'(?:'.repeat(5000)}a${')'.repeat(5000)}`, /nested/],
  ];
  for (const [source, reason] of fragments) assertRejected(parseFragment(source), reason, source);
});

test('limits sit above anything a route needs', () => {
  assertFragment('a{1,4096}b', ['ab'], ['b']);
  assertFragment(`${'('.repeat(256)}a${')'.repeat(256)}`, ['a'], ['']);
  assert.equal(parseFragment('a{99999}').ok, true);
});

test('rejects whole-path regexes with anchors away from the ends', () => {
  const regexes = [
    /a^b/, /a$b/, /(^a)/, /(a$)/, /(?:^a)/, /(?:a$)/, /a(?:^b)/, /(?:^a|b)c/, /(?:a|b$)/, /$a/,
    /$^/, /a^/, /a^|b/, /$|a$b/, /^a$b/, /(?:)^a/, /a$(?:)/, /(^)/, /($)/,
  ];
  for (const regex of regexes) assertRejected(parseRegExp(regex), /away from the ends/, `${regex}`);
});

test('rejects flags it cannot honour', () => {
  assertRejected(parseRegExp(/a/m), /flag `m`/, 'm');
  assertRejected(parseRegExp(/a/u), /flag `u`/, 'u');
  assertRejected(parseRegExp(new RegExp('a', 'v')), /flag `v`/, 'v');
  assertRejected(parseRegExp(/a/g), /flag `g`/, 'g');
  assertRejected(parseRegExp(/a/y), /flag `y`/, 'y');
  assertRejected(parseRegExp(/a/gi), /flag `g`/, 'gi');
});

test('rejects invalid fragments rather than throwing', () => {
  for (const source of ['(', ')', '[', 'a)(b', '*', '+', '?', '\\', 'a**', 'a{2,1}', '{2}', '[z-a]']) {
    assertRejected(parseFragment(source), /^invalid regex/, source);
  }
  for (const source of ['a{2}{3}', 'a+*', '(?<n>a)(?<n>b)', '(?<1>a)', '^*']) {
    assertRejected(parseFragment(source), /^invalid regex/, source);
  }
});

test('parsing keeps no state between calls, and leaves the regex alone', () => {
  assert.equal(parseFragment('a{2}').ok, true);
  assert.equal(parseFragment('a{').ok, true);
  assert.equal(parseFragment('a{2}').ok, true);
  const regex = /a/;
  regex.lastIndex = 5;
  assert.equal(parseRegExp(regex).ok, true);
  assert.equal(regex.lastIndex, 5);
});

test('inexact: reported for sets that hold only part of the range above ASCII', () => {
  const inexact = (source: string): boolean => {
    const parsed = parseFragment(source);
    assert.ok(parsed.ok, source);
    return parsed.inexact === true;
  };
  for (const source of ['.', '.+', 'a.b', '\\s', '\\S', '[\\s]', '[\\S]', '[^\\s]', 'é', '[é]', '[^é]', '[^/é]', '\\u00e9', '[a-\\u00ff]', '(?:a|é)']) {
    assert.equal(inexact(source), true, source);
  }
  for (const source of ['a', 'a+', '\\d+', '\\w', '\\D', '\\W', '[a-z]', '[^/]+', '[^a]', '[\\D]', '[^\\d]', '[\\x00-\\uffff]']) {
    assert.equal(inexact(source), false, source);
  }
});

test('inexact: `.` is exact under `s`, and a whole-path regex reports too', () => {
  const inexact = (regex: RegExp): boolean => {
    const parsed = parseRegExp(regex);
    assert.ok(parsed.ok, String(regex));
    return parsed.inexact === true;
  };
  assert.equal(inexact(/^a.b$/s), false);
  assert.equal(inexact(/^a.b$/), true);
  assert.equal(inexact(/^\/users\/\d+$/), false);
  assert.equal(inexact(/users/), false);
});
