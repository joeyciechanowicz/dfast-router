import { Match } from './match';
import { NON_ASCII } from './compiler/types';
import type { Miss, Results, Table } from './compiler/types';
import type { RouteMatch } from './types';

const CHAR_CODES = 0x10000;

/**
 * Whether `s` holds a character above ASCII, which always takes more than one UTF-8 byte. Over 200
 * characters this is 12x faster than a JS loop.
 */
const hasNonAscii = (s: string): boolean => Buffer.byteLength(s) !== s.length;

/** Whether the path before `end` holds a character above ASCII, ignoring any query. */
const pathHasNonAscii = (s: string, end: number): boolean => hasNonAscii(end === s.length ? s : s.slice(0, end));

/**
 * Runs the table over a path. See "Rules for matcher.ts" in PLAN.md before changing `find`: each rule
 * there comes from a measurement. Character codes are literals because an import from a CommonJS
 * module is a property load, and `find` is the one place that could notice it.
 */
export function createMatcher(
  table: Table, results: Results, miss: Miss,
): (path: string, method: number) => RouteMatch | null {
  const TT = table.tt;
  // By char code, so that V8 can prove every read in bounds and `find` needs no check for non-ASCII.
  const CLS = new Uint8Array(CHAR_CODES).fill(table.cls[NON_ASCII]);
  CLS.set(table.cls.subarray(0, NON_ASCII));
  const K = table.shift;
  const START = table.start;
  const STOP = table.stop;
  const SCAN = table.scan;
  const RUN = table.scanRun;
  const TAIL = table.tail;
  const METHOD_BITS = results.methodBits;
  // A state with no accept row points at a row of -1, so that a lookup needs no check for it.
  const NO_ROW = results.rows.length;
  const ROW = Int32Array.from(table.rowOf, (row) => (row < 0 ? NO_ROW : row << METHOD_BITS));
  const RESULT = new Int32Array(NO_ROW + (1 << METHOD_BITS)).fill(-1);
  RESULT.set(results.rows);
  const TARGETS = results.targets;
  const INEXACT = results.inexact;

  /** `miss`, given a row as an offset into RESULT. */
  const missAt = (s: string, m: number, i: number, row: number): RouteMatch | null =>
    miss(s, m, i, row === NO_ROW ? -1 : row >> METHOD_BITS);

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
   * A stop on a non-ASCII character flags the path and steps over it. A tail state can't be left, so it
   * jumps to the end of the path. Any other stop is the end of a scan chain, so it gallops to the next
   * `/` or `?`. `indexOf` skips characters without looking at
   * them, so a path about to get an inexact direct result rechecks what was skipped.
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
      const nonAscii = s.charCodeAt(i) >= 128;
      flagged = flagged || nonAscii;
      i += 1;
      if (TAIL[st] === 1) {
        if (skipped < 0) {
          skipped = i;
          const query = s.indexOf('?', i);
          if (query >= 0) n = query;
        }
        i = n;
        break;
      }
      if (!nonAscii) {
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
        x = TT[(st << K) + CLS[c]];
        if (x >= STOP) break;
        st = x;
      }
      if (i >= n || x < SCAN) break;
    }
    if (i < n && s.charCodeAt(i) !== 63) return miss(s, m, -1, -1);
    const row = ROW[st];
    const r = RESULT[row + m];
    if (r < 0) return missAt(s, m, i, row);
    if (INEXACT[r] === 1 && (flagged || (skipped >= 0 && pathHasNonAscii(s, i)))) return missAt(s, m, i, row);
    const target = TARGETS[r];
    const prebuilt = target.prebuilt;
    return prebuilt !== null ? prebuilt : new Match(target, s, i, null);
  }

  return function find(s: string, m: number): RouteMatch | null {
    const n = s.length;
    let st = START;
    let i = 0;
    let x = 0;
    for (; i < n; i++) {
      const c = s.charCodeAt(i);
      x = TT[(st << K) + CLS[c]];
      if (x >= STOP) break;
      st = x;
    }
    if (x >= SCAN) return slow(s, i, n, x, m);
    // `?` shares its class with every symbol in no set, so a stop here may be a dead character.
    if (i < n && s.charCodeAt(i) !== 63) return miss(s, m, -1, -1);
    const row = ROW[st];
    const r = RESULT[row + m];
    if (r < 0) return missAt(s, m, i, row);
    const target = TARGETS[r];
    const prebuilt = target.prebuilt;
    return prebuilt !== null ? prebuilt : new Match(target, s, i, null);
  };
}
