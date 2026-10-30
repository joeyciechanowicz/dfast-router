import { Match } from './match';
import type { Extractor, Miss, Results, Table } from './compiler/types';
import type { RouteMatch } from './types';

/** Whether [from, to) holds a character above ASCII. */
function hasNonAscii(s: string, from: number, to: number): boolean {
  for (let i = from; i < to; i += 1) {
    if (s.charCodeAt(i) >= 128) return true;
  }
  return false;
}

/**
 * Runs the table over a path. See "Rules for matcher.ts" in PLAN.md before changing `find`: each rule
 * there comes from a measurement. Character codes are literals because an import from a CommonJS
 * module is a property load, and `find` is the one place that could notice it.
 */
export function createMatcher(
  table: Table, results: Results, miss: Miss,
): (path: string, method: number) => RouteMatch | null {
  const TT = table.tt;
  const CLS = table.cls;
  const K = table.shift;
  const START = table.start;
  const STOP = table.stop;
  const SCAN = table.scan;
  const RUN = table.scanRun;
  const ROW = table.rowOf;
  const RESULT = results.rows;
  const METHOD_BITS = results.methodBits;
  const HANDLERS = results.handlers;
  const STORES = results.stores;
  const EXTRACTORS = results.extractors;
  const PREBUILT = results.prebuilt;

  /**
   * The next `/`, `?` or non-ASCII character within RUN characters of i, or n at the end of the input.
   * Returns -1 if the run finds none, which is when `indexOf` starts to pay for itself. Stopping on a
   * non-ASCII character sends it back through the table, so `slow` flags it like any other.
   */
  function seek(s: string, i: number, n: number): number {
    const run = i + RUN < n ? i + RUN : n;
    for (; i < run; i++) {
      const c = s.charCodeAt(i);
      if (c === 47 || c === 63 || c >= 128) return i;
    }
    return i < n ? -1 : n;
  }

  /**
   * Continues from a scan-band exit at i. It owns the outer loop so that `find` stays one flat loop.
   *
   * A stop on a non-ASCII character flags the path and steps over it. Any other stop is the end of a
   * scan chain, so it gallops to the next `/` or `?`. `indexOf` skips characters without looking at
   * them, so a path about to get a direct result rechecks what was skipped.
   *
   * `?` is searched for at most once: narrowing n to the end of the path means that a path of many
   * long segments doesn't rescan to its end at each one.
   */
  function slow(s: string, i: number, n: number, x: number, m: number): RouteMatch | null {
    let st = 0;
    let flagged = false;
    let skipped = -1; // where `indexOf` first took over; n is the path's end once this is set
    for (;;) {
      st = x - SCAN;
      if (s.charCodeAt(i) >= 128) {
        flagged = true;
        i += 1;
      } else {
        i += 1;
        const stop = seek(s, i, n);
        if (stop >= 0) {
          i = stop;
        } else {
          i += RUN;
          if (skipped < 0) {
            skipped = i;
            const query = s.indexOf('?', i);
            if (query >= 0) n = query;
          }
          const slash = s.indexOf('/', i);
          i = slash >= 0 && slash < n ? slash : n;
        }
      }
      x = 0;
      for (; i < n; i++) {
        const c = s.charCodeAt(i);
        x = TT[(st << K) + CLS[c < 128 ? c : 128]];
        if (x >= STOP) break;
        st = x;
      }
      if (i >= n || x < SCAN) break;
    }
    if (i < n && s.charCodeAt(i) !== 63) return miss(s, m, -1, -1);
    const row = ROW[st];
    const r = row < 0 ? -1 : RESULT[(row << METHOD_BITS) + m];
    if (r < 0 || flagged || (skipped >= 0 && hasNonAscii(s, skipped, i))) return miss(s, m, i, row);
    const prebuilt = PREBUILT[r];
    return prebuilt !== null ? prebuilt : new Match(HANDLERS[r], STORES[r], EXTRACTORS[r] as Extractor, s, i);
  }

  return function find(s: string, m: number): RouteMatch | null {
    const n = s.length;
    let st = START;
    let i = 0;
    let x = 0;
    for (; i < n; i++) {
      const c = s.charCodeAt(i);
      x = TT[(st << K) + CLS[c < 128 ? c : 128]];
      if (x >= STOP) break;
      st = x;
    }
    if (x >= SCAN) return slow(s, i, n, x, m);
    // `?` shares its class with every symbol in no set, so a stop here may be a dead character.
    if (i < n && s.charCodeAt(i) !== 63) return miss(s, m, -1, -1);
    const row = ROW[st];
    const r = row < 0 ? -1 : RESULT[(row << METHOD_BITS) + m];
    if (r < 0) return miss(s, m, i, row);
    const prebuilt = PREBUILT[r];
    return prebuilt !== null ? prebuilt : new Match(HANDLERS[r], STORES[r], EXTRACTORS[r] as Extractor, s, i);
  };
}
