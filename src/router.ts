import { mkset } from './compiler/charset';
import { buildDfa } from './compiler/dfa';
import { buildExtractor } from './compiler/extract';
import { compareRank, parsePattern, variantAst, variantRegExp } from './compiler/pattern';
import { parseFragment } from './compiler/regex-parser';
import { buildTable } from './compiler/table';
import type { Ast, DfaInput, Miss, Parsed, Results, Variant } from './compiler/types';
import { Match, prebuiltMatch } from './match';
import { createMatcher } from './matcher';
import type { RouteHandler, RouteMatch } from './types';

const MAX_STATES = 32_767;
const SCAN = { scanAfter: 8, scanRun: 8 };
const ANY_METHOD = '*';

/** Stands in for a param regex the DFA can't hold. It over-accepts, so such a route is confirmed. */
const ANY_TEXT: Ast = { t: 'rep', x: { t: 'set', set: mkset(() => true) }, min: 0, max: Infinity };

interface Target {
  handler: RouteHandler;
  store: unknown;
}

interface PatternEntry extends Target {
  variant: Variant;
}

interface RegexEntry {
  regex: RegExp;
  match: RouteMatch;
}

/** What a compiled table needs from `find`. */
interface Compiled {
  match: (path: string, method: number) => RouteMatch | null;
  methodIds: Map<string, number>;
  get: number;
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

export class Router {
  private readonly patterns = new Map<string, Map<string, PatternEntry>>();
  private readonly regexes = new Map<string, Map<string, RegexEntry>>();
  private compiled: Compiled | null = null;

  on(method: string | string[], path: string | RegExp, handler: RouteHandler, store?: unknown): this {
    const methods = [method].flat().map(normalizeMethod);
    if (path instanceof RegExp) {
      const regex = statelessCopy(path);
      const match = prebuiltMatch(handler, store);
      for (const m of methods) addTo(this.regexes, m, regexKey(regex), { regex, match });
    } else {
      const variants = parsePattern(path);
      for (const m of methods) {
        for (const variant of variants) addTo(this.patterns, m, variant.key, { variant, handler, store });
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

  private build(): Compiled {
    const compiled = compileRoutes(this.patterns, this.regexes);
    this.compiled = compiled;
    return compiled;
  }

  private methodId(compiled: Compiled, method: string): number {
    return compiled.methodIds.get(normalizeMethod(method)) ?? 0;
  }
}

export function createRouter(): Router {
  return new Router();
}

function compileRoutes(
  patterns: Map<string, Map<string, PatternEntry>>,
  regexes: Map<string, Map<string, RegexEntry>>,
): Compiled {
  // Method 0 is `*`, and also any method no route names.
  const methodIds = new Map<string, number>([[ANY_METHOD, 0]]);
  for (const method of [...patterns.keys(), ...regexes.keys()]) {
    if (!methodIds.has(method)) methodIds.set(method, methodIds.size);
  }
  const methodBits = 32 - Math.clz32(methodIds.size - 1);
  const names = [...methodIds.keys()];

  // One tag per distinct variant, across methods.
  const tags = new Map<string, number>();
  const variants: Variant[] = [];
  for (const entries of patterns.values()) {
    for (const { variant } of entries.values()) {
      if (tags.has(variant.key)) continue;
      tags.set(variant.key, variants.length);
      variants.push(variant);
    }
  }

  const regexOf: (RegExp | null)[] = variants.map(() => null);
  const exactRegex = (tag: number): RegExp => (regexOf[tag] ??= variantRegExp(variants[tag]));

  const confirms = new Uint8Array(variants.length);
  const inputs: DfaInput[] = variants.map((variant, tag) => {
    const lenient = (source: string): Parsed => {
      const parsed = parseFragment(source);
      if (parsed.ok) return parsed;
      confirms[tag] = 1;
      exactRegex(tag); // throws now if the regex is invalid, not on some later request
      return { ok: true, ast: ANY_TEXT, names: [] };
    };
    const parsed = variantAst(variant, lenient);
    if (!parsed.ok) throw new Error(`Can't compile route: ${parsed.reason}`);
    return { ast: parsed.ast, tag };
  });

  const built = buildDfa(inputs, { maxStates: MAX_STATES });
  if (!built.ok) throw new Error(`Routes need more than ${MAX_STATES} DFA states`);
  const { dfa } = built;

  // Results, one per registered (variant, method). Ties follow each method's own order, so each
  // method ranks its variants separately.
  const results: Results = { rows: new Int32Array(0), methodBits, handlers: [], stores: [], extractors: [], prebuilt: [] };
  const tagOfResult: number[] = [];
  const extractorOf = variants.map((variant) => buildExtractor(variant, parseFragment));
  const ranked = new Map<string, { result: number; priority: number }[]>();
  for (const [method, entries] of patterns) {
    const sorted = [...entries.values()].sort((a, b) => compareRank(a.variant, b.variant));
    const byTag: { result: number; priority: number }[] = [];
    sorted.forEach(({ variant, handler, store }, priority) => {
      const tag = tags.get(variant.key) as number;
      const extractor = extractorOf[tag];
      const result = results.handlers.length;
      results.handlers.push(handler);
      results.stores.push(store);
      results.extractors.push(extractor);
      results.prebuilt.push(extractor === null ? prebuiltMatch(handler, store) : null);
      tagOfResult.push(tag);
      byTag[tag] = { result, priority };
    });
    ranked.set(method, byTag);
  }

  // A row per distinct accept set. `candidates` keeps every result in priority order for `miss`.
  const rowIds = new Map<string, number>();
  const rowTags: Int32Array[] = [];
  const rowOf = new Int32Array(dfa.states).fill(-1);
  dfa.accepts.forEach((accepted, state) => {
    if (accepted === null) return;
    const key = accepted.join(',');
    let row = rowIds.get(key);
    if (row === undefined) {
      row = rowTags.length;
      rowIds.set(key, row);
      rowTags.push(accepted);
    }
    rowOf[state] = row;
  });

  results.rows = new Int32Array(rowTags.length << methodBits).fill(-1);
  const candidates: Int32Array[] = new Array(rowTags.length << methodBits);
  rowTags.forEach((accepted, row) => {
    names.forEach((name, m) => {
      const list: number[] = [];
      for (const tierName of m === 0 ? [ANY_METHOD] : [name, ANY_METHOD]) {
        const byTag = ranked.get(tierName);
        if (byTag === undefined) continue;
        const inTier: { result: number; priority: number }[] = [];
        for (const tag of accepted) if (byTag[tag] !== undefined) inTier.push(byTag[tag]);
        inTier.sort((a, b) => a.priority - b.priority);
        for (const { result } of inTier) list.push(result);
      }
      const index = (row << methodBits) + m;
      candidates[index] = Int32Array.from(list);
      if (list.length > 0 && confirms[tagOfResult[list[0]]] === 0) results.rows[index] = list[0];
    });
  });

  // The regex tiers, for each method: its own routes, then those for `*`.
  const regexTiers = names.map((name, m) => {
    const tiers = m === 0 ? [ANY_METHOD] : [name, ANY_METHOD];
    return tiers.flatMap((tierName) => [...(regexes.get(tierName)?.values() ?? [])]);
  });
  const anyRegex = regexTiers.some((tier) => tier.length > 0);

  const miss: Miss = (path, method, end, row) => {
    const code = path.length === 0 ? 0 : path.charCodeAt(0);
    if (code !== 47) return match(`/${path}`, method);
    if (row < 0 && !anyRegex) return null;

    let stop = end;
    if (stop < 0) {
      const query = path.indexOf('?');
      stop = query < 0 ? path.length : query;
    }
    const exactPath = path.slice(0, stop);
    if (row >= 0) {
      const list = candidates[(row << methodBits) + method];
      for (let i = 0; i < list.length; i += 1) {
        const r = list[i];
        if (!exactRegex(tagOfResult[r]).test(exactPath)) continue;
        return results.prebuilt[r] ?? new Match(results.handlers[r], results.stores[r], results.extractors[r]!, path, stop);
      }
    }
    const tier = regexTiers[method];
    for (let i = 0; i < tier.length; i += 1) {
      if (tier[i].regex.test(exactPath)) return tier[i].match;
    }
    return null;
  };

  const table = buildTable(dfa, rowOf, SCAN);
  const match = createMatcher(table, results, miss);
  return { match, methodIds, get: methodIds.get('GET') ?? 0 };
}
