import { ALPHABET, NON_ASCII, QMARK, SLASH } from './types';
import type { CharSet } from './types';

/** Every symbol `f` accepts. QMARK is always left out (see CharSet). */
export function mkset(f: (symbol: number) => boolean): CharSet {
  const set = new Uint8Array(ALPHABET);
  for (let symbol = 0; symbol < ALPHABET; symbol += 1) {
    if (symbol !== QMARK && f(symbol)) set[symbol] = 1;
  }
  return set;
}

/** A set of one symbol. */
export function single(symbol: number): CharSet {
  return mkset((s) => s === symbol);
}

/** The symbol for one character. Every character above ASCII shares NON_ASCII. */
export function code(ch: string): number {
  const c = ch.charCodeAt(0);
  return c < NON_ASCII ? c : NON_ASCII;
}

/** The default param set, `[^/?]`. */
export function segSet(): CharSet {
  return mkset((s) => s !== SLASH);
}
