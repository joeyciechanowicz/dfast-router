import type { ParseFragment, Parsed, Variant } from './types';

/** Throws on an unknown alias, or over 256 variants. */
export function parsePattern(path: string): Variant[] {
  throw new Error('not implemented: parsePattern');
}

export function variantAst(v: Variant, parse: ParseFragment): Parsed {
  throw new Error('not implemented: variantAst');
}

/** Negative when `a` wins. */
export function compareRank(a: Variant, b: Variant): number {
  throw new Error('not implemented: compareRank');
}
