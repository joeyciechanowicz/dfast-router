import { code, mkset, segSet, single } from './charset';
import type { Ast, ParseFragment, Parsed, Segment, Variant } from './types';

const MAX_VARIANTS = 256;

const SCORE = { static: 100, regex: 10, param: 0, wildcard: -100 };

const ALIASES = new Map([
  ['int', { source: '[0-9]+', score: 40 }],
  ['uuid', { source: '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', score: 35 }],
  ['locale', { source: '[a-z]{2}-[A-Z]{2}', score: 30 }],
  ['alpha', { source: '[A-Za-z]+', score: 25 }],
  ['slug', { source: '[A-Za-z0-9-]+', score: 20 }],
]);

const PARAM_SOURCE = '[^/?]+';
const WILDCARD_SOURCE = '[^?]*';

const ROOT: Segment[] = [{ kind: 'static', value: '' }];

function normalizePattern(path: string): string {
  if (path === '') return '/';
  return path[0] === '/' ? path : `/${path}`;
}

/** Splits on `/`, except inside the regex of a `:name(...)` segment, where `[^/]` must stay whole. */
function splitSegments(path: string): string[] {
  const segments: string[] = [];
  let start = 1;
  let depth = 0;
  let inClass = false;
  for (let i = 1; i < path.length; i += 1) {
    const c = path[i];
    if (c === '/' && depth === 0 && !inClass) {
      segments.push(path.slice(start, i));
      start = i + 1;
    } else if (path[start] !== ':') continue;
    else if (c === '\\') i += 1;
    else if (inClass) inClass = c !== ']';
    else if (c === '[') inClass = true;
    else if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
  }
  segments.push(path.slice(start));
  return segments;
}

function parseParam(raw: string): { segment: Segment; optional: boolean } {
  const optional = raw.endsWith('?');
  const body = raw.slice(1, optional ? -1 : undefined);
  if (body.endsWith('*')) return { segment: { kind: 'wildcard', name: body.slice(0, -1) }, optional: false };

  const nameEnd = body.search(/[(#]/);
  if (nameEnd === -1) {
    return { segment: { kind: 'param', name: body, source: null, score: SCORE.param }, optional };
  }
  const name = body.slice(0, nameEnd);
  if (body[nameEnd] === '(') {
    const source = body.slice(nameEnd + 1, body.lastIndexOf(')'));
    return { segment: { kind: 'param', name, source, score: SCORE.regex }, optional };
  }
  const alias = body.slice(nameEnd + 1);
  const known = ALIASES.get(alias);
  if (known === undefined) throw new Error(`Unknown validator alias: #${alias}`);
  return { segment: { kind: 'param', name, source: known.source, score: known.score }, optional };
}

/** What one raw segment can expand to. An optional's shorter choice comes first. */
function choicesOf(raw: string): Segment[][] {
  if (raw === '*') return [[{ kind: 'wildcard', name: '*' }]];
  if (raw[0] === '(' && raw.endsWith(')')) {
    return raw.slice(1, -1).split('|').map((value) => [{ kind: 'static', value }]);
  }
  if (raw[0] !== ':') return [[{ kind: 'static', value: raw }]];
  const { segment, optional } = parseParam(raw);
  return optional ? [[], [segment]] : [[segment]];
}

function scoreOf(segment: Segment): number {
  if (segment.kind === 'static') return SCORE.static;
  return segment.kind === 'param' ? segment.score : SCORE.wildcard;
}

function makeVariant(segments: Segment[], defaults: Record<string, string>, rank: number[]): Variant {
  return { segments, defaults, key: JSON.stringify([segments, defaults]), rank };
}

/**
 * A wildcard's empty match is its own variant, the prefix alone, ranked as the wildcard. A leading
 * wildcard has none, because `/` + `[^?]*` already holds the root, and a variant of no characters
 * would make the empty path match before it is normalized to `/`.
 */
function toVariants(expansion: Segment[]): Variant[] {
  if (expansion.length === 0) return [makeVariant(ROOT, {}, ROOT.map(scoreOf))];
  const rank = expansion.map(scoreOf);
  const prefix = expansion.slice(0, -1);
  const last = expansion[prefix.length];
  const whole = makeVariant(expansion, {}, rank);
  if (last.kind !== 'wildcard' || prefix.length === 0) return [whole];
  return [makeVariant(prefix, { [last.name]: '' }, rank), whole];
}

function checkLimit(path: string, count: number): void {
  if (count > MAX_VARIANTS) throw new Error(`Route ${path} expands to more than ${MAX_VARIANTS} variants`);
}

/** Throws on an unknown alias, or over 256 variants. */
export function parsePattern(path: string): Variant[] {
  let expansions: Segment[][] = [[]];
  for (const raw of splitSegments(normalizePattern(path))) {
    const choices = choicesOf(raw);
    expansions = expansions.flatMap((expansion) => choices.map((choice) => [...expansion, ...choice]));
    checkLimit(path, expansions.length);
    if (choices[choices.length - 1][0]?.kind === 'wildcard') break;
  }
  const variants = expansions.flatMap(toVariants);
  checkLimit(path, variants.length);
  // `(a|a)` and `/:a?/:a?` repeat a variant. A Map keeps the first position of a key.
  return [...new Map(variants.map((v) => [v.key, v] as const)).values()];
}

function pushLiteral(xs: Ast[], text: string): void {
  // By code unit, because the DFA reads code units: `😀` is two NON_ASCII symbols.
  for (let i = 0; i < text.length; i += 1) xs.push({ t: 'set', set: single(code(text[i])) });
}

export function variantAst(v: Variant, parse: ParseFragment): Parsed {
  const xs: Ast[] = [];
  const names: string[] = [];
  for (const segment of v.segments) {
    pushLiteral(xs, '/');
    if (segment.kind === 'static') {
      pushLiteral(xs, segment.value);
      continue;
    }
    names.push(segment.name);
    if (segment.kind === 'wildcard') {
      xs.push({ t: 'rep', x: { t: 'set', set: mkset(() => true) }, min: 0, max: Infinity });
    } else if (segment.source === null) {
      xs.push({ t: 'rep', x: { t: 'set', set: segSet() }, min: 1, max: Infinity });
    } else {
      const parsed = parse(segment.source);
      if (!parsed.ok) return parsed;
      xs.push(parsed.ast);
    }
  }
  return { ok: true, ast: { t: 'cat', xs }, names };
}

const escapeLiteral = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');

/** Puts capture `i` in the group `__p<i>`, so a group inside a param's regex can't shift the numbering. */
function segmentsSource(segments: Segment[], optionalWildcard: boolean): string {
  let group = 0;
  let source = '';
  for (const segment of segments) {
    if (segment.kind === 'static') {
      source += `/${escapeLiteral(segment.value)}`;
    } else if (segment.kind === 'param') {
      source += `/(?<__p${group}>${segment.source ?? PARAM_SOURCE})`;
      group += 1;
    } else {
      const capture = `/(?<__p${group}>${WILDCARD_SOURCE})`;
      source += optionalWildcard ? `(?:${capture})?` : capture;
      group += 1;
    }
  }
  return source;
}

/** An exact RegExp for the whole path. Confirms DFA candidates on non-ASCII paths. */
export function variantRegExp(v: Variant): RegExp {
  return new RegExp(`^${segmentsSource(v.segments, false)}$`);
}

/**
 * The RegExp that decides a variant's params: segment captures in order, then any wildcard name in
 * `defaults`. Both variants of a wildcard use one regex with the wildcard optional, because a param
 * that can cross `/` may let both match a path, and the backtracking order then picks the captures.
 */
export function captureRegExp(v: Variant): RegExp {
  const emptyMatch = Object.keys(v.defaults).length > 0;
  const segments: Segment[] = emptyMatch ? [...v.segments, { kind: 'wildcard', name: '' }] : v.segments;
  return new RegExp(`^${segmentsSource(segments, true)}$`);
}

/** Negative when `a` wins. A shorter rank counts its missing entries as 0. */
export function compareRank(a: Variant, b: Variant): number {
  const length = Math.max(a.rank.length, b.rank.length);
  for (let i = 0; i < length; i += 1) {
    const difference = (b.rank[i] ?? 0) - (a.rank[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
