import { mkset } from './compiler/charset';
import { buildDfa } from './compiler/dfa';
import { buildExtractor } from './compiler/extract';
import { compareRank, parsePattern, variantAst, variantRegExp } from './compiler/pattern';
import { parseFragment, parseRegExp } from './compiler/regex-parser';
import { buildTable } from './compiler/table';
import type { Ast, DfaInput, Extractor, Miss, Parsed, Results, Variant } from './compiler/types';
import { Match, MatchTarget } from './match';
import { createMatcher } from './matcher';
import type { RouteHandler, RouteMatch } from './types';

/** About 450 routes of heavy param and literal overlap. A REST API of 3000 routes needs 14,000. */
const DEFAULT_MAX_STATES = 262_144;
/** A route needing more than this alone is left out of the DFA, so one can't use up the table. */
const ROUTE_STATE_LIMIT = 4_096;
/**
 * Short params stay in the table for `scanAfter` characters. That's 15% faster at 34 routes, but the
 * extra states make big tables 12% slower, so tables past SCAN_CHAIN_STATES go without.
 */
const SCAN_AFTER = 8;
const SCAN_RUN = 8;
const SCAN_CHAIN_STATES = 1_500;
const ANY_METHOD = '*';

/** Stands in for a param regex the DFA can't hold. It over-accepts, so such a route is confirmed. */
const ANY_TEXT: Ast = { t: 'rep', x: { t: 'set', set: mkset(() => true) }, min: 0, max: Infinity };

interface Target {
  handler: RouteHandler;
  store: unknown;
}

interface PatternEntry extends Target {
  variant: Variant;
  path: string;
}

interface RegexEntry extends Target {
  regex: RegExp;
}

/** A regex route for one method, in the order `miss` tries them. */
interface RegexCandidate {
  regex: RegExp;
  result: number;
  tag: number; // -1 for a residual route, which the DFA knows nothing about
  prefix: string;
}

/** What a compiled table needs from `find`. */
interface Compiled {
  match: (path: string, method: number) => RouteMatch | null;
  methodIds: Map<string, number>;
  get: number;
  residual: string[];
}

function normalizeMethod(method: string): string {
  const value = String(method ?? ANY_METHOD).trim().toUpperCase();
  return value === '' ? ANY_METHOD : value;
}

/** Without `g` and `y`, which make a shared RegExp stateful. */
const statelessCopy = (regex: RegExp): RegExp => new RegExp(regex.source, regex.flags.replace(/[gy]/g, ''));
const regexKey = (regex: RegExp): string => `${regex.source}/${regex.flags}`;

/** Registers into a Map, which keeps a key's first position when it's set again (D11). */
function addTo<T>(table: Map<string, Map<string, T>>, method: string, key: string, entry: T): void {
  const entries = table.get(method);
  if (entries) entries.set(key, entry);
  else table.set(method, new Map([[key, entry]]));
}

export interface RouterOptions {
  /** Compiling fails past this. Table memory grows with it: a state is about 256 bytes at most. */
  maxStates?: number;
}

export class Router {
  private readonly maxStates: number;
  private readonly patterns = new Map<string, Map<string, PatternEntry>>();
  private readonly regexes = new Map<string, Map<string, RegexEntry>>();
  private compiled: Compiled | null = null;

  constructor(options: RouterOptions = {}) {
    this.maxStates = options.maxStates ?? DEFAULT_MAX_STATES;
  }

  on(method: string | string[], path: string | RegExp, handler: RouteHandler, store?: unknown): this {
    const methods = [method].flat().map(normalizeMethod);
    if (path instanceof RegExp) {
      const regex = statelessCopy(path);
      for (const m of methods) addTo(this.regexes, m, regexKey(regex), { regex, handler, store });
    } else {
      const variants = parsePattern(path);
      for (const m of methods) {
        for (const variant of variants) addTo(this.patterns, m, variant.key, { variant, path, handler, store });
      }
    }
    this.compiled = null;
    return this;
  }

  find(method: string, path: string): RouteMatch | null {
    const compiled = this.compiled ?? this.build();
    const id = method === 'GET' ? compiled.get : compiled.methodIds.get(method) ?? this.methodId(compiled, method);
    return compiled.match(path, id);
  }

  /** Compiles now, not on the first `find`. Registering another route undoes this. */
  compile(): void {
    this.build();
  }

  /** Routes not fully compiled into the DFA. They run `RegExp`, so they can backtrack. */
  residual(): string[] {
    return (this.compiled ?? this.build()).residual;
  }

  private build(): Compiled {
    const compiled = compileRoutes(this.patterns, this.regexes, this.maxStates);
    this.compiled = compiled;
    return compiled;
  }

  private methodId(compiled: Compiled, method: string): number {
    return compiled.methodIds.get(normalizeMethod(method)) ?? 0;
  }
}

export function createRouter(options?: RouterOptions): Router {
  return new Router(options);
}

const fitsAlone = (ast: Ast): boolean => buildDfa([{ ast, tag: 0 }], { maxStates: ROUTE_STATE_LIMIT }).ok;

/**
 * Text every match of `regex` starts with, or '' if that can't be known. Only a filter for residual
 * routes, so it stops early whenever it's unsure: before a quantifier, or at any `|` or `i` flag.
 */
function literalPrefix(regex: RegExp): string {
  const { source } = regex;
  if (source[0] !== '^' || source.includes('|') || regex.ignoreCase) return '';
  let prefix = '';
  for (let i = 1; i < source.length; i += 1) {
    let c = source[i];
    if (c === '\\') {
      if (i + 1 === source.length || /[a-zA-Z0-9]/.test(source[i + 1])) break;
      i += 1;
      c = source[i];
    } else if ('[](){}.*+?|$^'.includes(c)) break;
    if ('*+?{'.includes(source[i + 1] ?? '')) break;
    prefix += c;
  }
  return prefix;
}

/** Named groups as params (D6). Numbered groups stay unexposed. */
function regexExtractor(regex: RegExp): Extractor | null {
  if (!/\(\?<(?![=!])/.test(regex.source)) return null;
  return (path, end) => {
    const params: Record<string, string> = {};
    const groups = regex.exec(path.slice(0, end))?.groups ?? {};
    for (const [name, value] of Object.entries(groups)) if (value !== undefined) params[name] = value;
    return params;
  };
}

/** Finds where a table goes over budget, so the error can name a route. Each build is bounded. */
function firstOverBudget(inputs: DfaInput[], maxStates: number): number {
  let low = 1;
  let high = inputs.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (buildDfa(inputs.slice(0, middle), { maxStates }).ok) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

function compileRoutes(
  patterns: Map<string, Map<string, PatternEntry>>,
  regexes: Map<string, Map<string, RegexEntry>>,
  maxStates: number,
): Compiled {
  // Method 0 is `*`, and also any method no route names.
  const methodIds = new Map<string, number>([[ANY_METHOD, 0]]);
  for (const method of [...patterns.keys(), ...regexes.keys()]) {
    if (!methodIds.has(method)) methodIds.set(method, methodIds.size);
  }
  const methodBits = 32 - Math.clz32(methodIds.size - 1);
  const names = [...methodIds.keys()];
  const tiersOf = (m: number): string[] => (m === 0 ? [ANY_METHOD] : [names[m], ANY_METHOD]);

  // One tag per distinct variant across methods, then one per regex route that compiles.
  const tags = new Map<string, number>();
  const variants: Variant[] = [];
  const labels: string[] = [];
  for (const entries of patterns.values()) {
    for (const { variant, path } of entries.values()) {
      if (tags.has(variant.key)) continue;
      tags.set(variant.key, variants.length);
      variants.push(variant);
      labels.push(path);
    }
  }

  const exactRegexes: (RegExp | null)[] = variants.map(() => null);
  const exactRegex = (tag: number): RegExp => (exactRegexes[tag] ??= variantRegExp(variants[tag]));
  const confirms: boolean[] = variants.map(() => false);
  const inexact: boolean[] = [];

  const fragments = new Map<string, Parsed>();
  const compilable = (source: string): Parsed => {
    let parsed = fragments.get(source);
    if (parsed === undefined) {
      parsed = parseFragment(source);
      if (parsed.ok && !fitsAlone(parsed.ast)) parsed = { ok: false, reason: 'too many DFA states' };
      fragments.set(source, parsed);
    }
    return parsed;
  };

  const inputs: DfaInput[] = variants.map((variant, tag) => {
    const lenient = (source: string): Parsed => {
      const parsed = compilable(source);
      if (parsed.ok) return parsed;
      confirms[tag] = true;
      exactRegex(tag); // throws now if the regex is invalid, not on some later request
      return { ok: true, ast: ANY_TEXT, names: [] };
    };
    const parsed = variantAst(variant, lenient);
    if (!parsed.ok) throw new Error(`Can't compile route ${labels[tag]}: ${parsed.reason}`);
    inexact[tag] = parsed.inexact === true;
    return { ast: parsed.ast, tag };
  });

  const residual = labels.filter((_, tag) => confirms[tag]);
  const regexTags = new Map<string, number>();
  for (const entries of regexes.values()) {
    for (const [key, { regex }] of entries) {
      if (regexTags.has(key)) continue;
      const parsed = parseRegExp(regex);
      if (parsed.ok && fitsAlone(parsed.ast)) {
        const tag = labels.length;
        regexTags.set(key, tag);
        labels.push(String(regex));
        exactRegexes[tag] = regex;
        confirms[tag] = false;
        inexact[tag] = parsed.inexact === true;
        inputs.push({ ast: parsed.ast, tag });
      } else {
        regexTags.set(key, -1);
        residual.push(String(regex));
      }
    }
  }

  const built = buildDfa(inputs, { maxStates });
  if (!built.ok) {
    const fit = firstOverBudget(inputs, maxStates);
    throw new Error(
      `Routes need more than ${maxStates} DFA states: ${fit} of ${inputs.length} fit, and ${labels[inputs[fit].tag]} goes over`,
    );
  }
  const { dfa } = built;

  // Results, one per registered (route, method).
  const results: Results = {
    rows: new Int32Array(0),
    methodBits,
    targets: [],
    inexact: new Uint8Array(0),
  };
  const resultInexact: number[] = [];
  const addResult = ({ handler, store }: Target, extractor: Extractor | null, tag: number): number => {
    resultInexact.push(tag >= 0 && inexact[tag] ? 1 : 0);
    return results.targets.push(new MatchTarget(handler, store, extractor)) - 1;
  };

  // Ties follow each method's own order, so each method ranks its variants separately.
  const extractorOf = variants.map((variant) => buildExtractor(variant, parseFragment));
  const ranked = new Map<string, { result: number; priority: number }[]>();
  const tagOfResult = new Map<number, number>();
  for (const [method, entries] of patterns) {
    const sorted = [...entries.values()].sort((a, b) => compareRank(a.variant, b.variant));
    const byTag: { result: number; priority: number }[] = [];
    sorted.forEach((entry, priority) => {
      const tag = tags.get(entry.variant.key) as number;
      const result = addResult(entry, extractorOf[tag], tag);
      tagOfResult.set(result, tag);
      byTag[tag] = { result, priority };
    });
    ranked.set(method, byTag);
  }

  const regexByMethod = new Map<string, RegexCandidate[]>();
  for (const [method, entries] of regexes) {
    const list: RegexCandidate[] = [];
    for (const [key, entry] of entries) {
      const tag = regexTags.get(key) as number;
      const result = addResult(entry, regexExtractor(entry.regex), tag);
      list.push({ regex: entry.regex, result, tag, prefix: literalPrefix(entry.regex) });
    }
    regexByMethod.set(method, list);
  }
  results.inexact = Uint8Array.from(resultInexact);
  const regexTiers = names.map((_, m) => tiersOf(m).flatMap((name) => regexByMethod.get(name) ?? []));
  const hasResidual = regexTiers.map((tier) => tier.some((candidate) => candidate.tag < 0));
  const anyResidual = hasResidual.includes(true);

  // A row per distinct accept set.
  const rowIds = new Map<string, number>();
  const rowTags: Set<number>[] = [];
  const rowOf = new Int32Array(dfa.states).fill(-1);
  dfa.accepts.forEach((accepted, state) => {
    if (accepted === null) return;
    const key = accepted.join(',');
    let row = rowIds.get(key);
    if (row === undefined) {
      row = rowTags.length;
      rowIds.set(key, row);
      rowTags.push(new Set(accepted));
    }
    rowOf[state] = row;
  });

  // `rows` holds a result only where it's certain. Otherwise `miss` works through the candidates.
  results.rows = new Int32Array(rowTags.length << methodBits).fill(-1);
  const patternCandidates: Int32Array[] = new Array(rowTags.length << methodBits);
  rowTags.forEach((accepted, row) => {
    names.forEach((_, m) => {
      const list: number[] = [];
      for (const name of tiersOf(m)) {
        const byTag = ranked.get(name);
        if (byTag === undefined) continue;
        const inTier: { result: number; priority: number }[] = [];
        for (const tag of accepted) if (byTag[tag] !== undefined) inTier.push(byTag[tag]);
        inTier.sort((a, b) => a.priority - b.priority);
        for (const { result } of inTier) list.push(result);
      }
      const index = (row << methodBits) + m;
      patternCandidates[index] = Int32Array.from(list);
      if (list.length > 0) {
        if (!confirms[tagOfResult.get(list[0]) as number]) results.rows[index] = list[0];
      } else if (!hasResidual[m]) {
        const first = regexTiers[m].find((candidate) => accepted.has(candidate.tag));
        if (first !== undefined) results.rows[index] = first.result;
      }
    });
  });

  const resultAt = (r: number, path: string, end: number): RouteMatch => {
    const target = results.targets[r];
    return target.prebuilt ?? new Match(target, path, end, null);
  };

  const miss: Miss = (path, method, end, row) => {
    const code = path.length === 0 ? 0 : path.charCodeAt(0);
    if (code !== 47) return match(`/${path}`, method);
    if (row < 0 && !anyResidual) return null;

    let stop = end;
    if (stop < 0) {
      const query = path.indexOf('?');
      stop = query < 0 ? path.length : query;
    }
    const exactPath = path.slice(0, stop);
    if (row >= 0) {
      const list = patternCandidates[(row << methodBits) + method];
      for (let i = 0; i < list.length; i += 1) {
        if (exactRegex(tagOfResult.get(list[i]) as number).test(exactPath)) return resultAt(list[i], path, stop);
      }
    }
    // A compiled regex outside the row can't match, because the DFA never under-accepts.
    const tier = regexTiers[method];
    for (let i = 0; i < tier.length; i += 1) {
      const { regex, result, tag, prefix } = tier[i];
      const possible = tag < 0 ? exactPath.startsWith(prefix) : row >= 0 && rowTags[row].has(tag);
      if (possible && regex.test(exactPath)) return resultAt(result, path, stop);
    }
    return null;
  };

  const scanAfter = dfa.states > SCAN_CHAIN_STATES ? 0 : SCAN_AFTER;
  const table = buildTable(dfa, rowOf, { scanAfter, scanRun: SCAN_RUN });
  const match = createMatcher(table, results, miss);
  return { match, methodIds, get: methodIds.get('GET') ?? 0, residual };
}
