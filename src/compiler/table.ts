import { ALPHABET, NON_ASCII, QMARK, SLASH } from './types';
import type { Dfa, Table } from './types';

/** A state that loops on everything except `/` and `?`, so `slow` can gallop through it. */
function isScanState(dfa: Dfa, state: number): boolean {
  const row = state * dfa.classes;
  for (let symbol = 0; symbol < ALPHABET; symbol += 1) {
    const next = dfa.trans[row + dfa.classOf[symbol]];
    const stops = symbol === SLASH || symbol === QMARK;
    if (stops ? next === state : next !== state) return false;
  }
  return true;
}

/**
 * Lays a DFA out for the hot loop. Values in `tt` fall into three bands:
 *
 *   [0, stop)      a table state: DFA states first, then their scan chains
 *   stop           dead
 *   [scan, ...)    leave for `slow`, which continues from DFA state `x - scan`
 *
 * Entering a scan state walks a chain of `scanAfter` copies of it, so short params stay in the hot
 * loop, and the end of the chain leaves for `slow` to gallop.
 *
 * `NON_ASCII` has a class of its own, and every transition on it is in the scan band, so the hot loop
 * leaves on the first non-ASCII character without a check of its own. A missing transition stays dead,
 * because sets only over-accept above ASCII, which makes that an exact rejection.
 *
 * `?` needs no handling: it is in no set, so its class has no transitions and is dead everywhere. That
 * class also holds every other symbol in no set, so the matcher re-checks the stopping character.
 */
export function buildTable(
  dfa: Dfa,
  rowOf: Int32Array, // per DFA state
  options: { scanAfter: number; scanRun: number }, // prototype: 8 and 8
): Table {
  const { states, classes, classOf, trans } = dfa;
  const { scanAfter, scanRun } = options;

  const sharedClass = classOf[NON_ASCII];
  const alone = classOf.filter((k) => k === sharedClass).length === 1;
  const nonAsciiClass = alone ? sharedClass : classes;
  const stride = alone ? classes : classes + 1;
  const cls = Uint8Array.from(classOf);
  cls[NON_ASCII] = nonAsciiClass;
  const shift = 32 - Math.clz32(stride - 1);

  const scanning = new Uint8Array(states);
  const chain = new Int32Array(states);
  let total = states;
  for (let state = 0; state < states; state += 1) {
    if (!isScanState(dfa, state)) continue;
    scanning[state] = 1;
    chain[state] = total;
    total += scanAfter;
  }

  const dead = total;
  const scan = dead + 1;
  const tt = scan + states - 1 > 0xffff ? new Uint32Array(total << shift) : new Uint16Array(total << shift);

  const enter = (state: number): number => {
    if (scanning[state] === 0) return state;
    return scanAfter > 0 ? chain[state] : scan + state;
  };

  const fillRow = (tableState: number, state: number, encode: (next: number) => number): void => {
    const to = tableState << shift;
    const from = state * classes;
    for (let k = 0; k < classes; k += 1) {
      const next = trans[from + k];
      tt[to + k] = next === -1 ? dead : encode(next);
    }
    const next = trans[from + sharedClass];
    tt[to + nonAsciiClass] = next === -1 ? dead : scan + next;
  };

  const tableRowOf = new Int32Array(total);
  for (let state = 0; state < states; state += 1) {
    tableRowOf[state] = rowOf[state];
    fillRow(state, state, enter);
    if (scanning[state] === 0) continue;
    for (let j = 0; j < scanAfter; j += 1) {
      const tableState = chain[state] + j;
      const onLoop = j + 1 < scanAfter ? tableState + 1 : scan + state;
      tableRowOf[tableState] = rowOf[state];
      fillRow(tableState, state, (next) => (next === state ? onLoop : enter(next)));
    }
  }

  return { tt, cls, shift, start: dfa.start, stop: dead, scan, rowOf: tableRowOf, scanRun };
}
