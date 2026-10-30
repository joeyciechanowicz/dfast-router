import type { CharSet } from './types';

/** Every symbol `f` accepts. QMARK is always left out (see CharSet). */
export function mkset(f: (symbol: number) => boolean): CharSet {
  throw new Error('not implemented: mkset');
}

/** A set of one symbol. */
export function single(symbol: number): CharSet {
  throw new Error('not implemented: single');
}

/** The symbol for one character. */
export function code(ch: string): number {
  throw new Error('not implemented: code');
}

/**
 * The default param set, `[^/?]`: the prototype's `SEG`. It's a function because a
 * module-level constant built from `mkset` would throw on import while `mkset` is a stub.
 */
export function segSet(): CharSet {
  throw new Error('not implemented: segSet');
}
