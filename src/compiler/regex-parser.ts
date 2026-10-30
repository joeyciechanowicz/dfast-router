import type { Parsed } from './types';

/** Body of `:name(...)`, matched whole. */
export function parseFragment(source: string): Parsed {
  throw new Error('not implemented: parseFragment');
}

/** A whole path. Unanchored sides add `[^?]*`. */
export function parseRegExp(regex: RegExp): Parsed {
  throw new Error('not implemented: parseRegExp');
}
