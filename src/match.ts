import type { Extractor } from './compiler/types';
import type { RouteHandler, RouteMatch } from './types';

/** A result whose `params` are built on first read (D4). */
export class Match implements RouteMatch {
  readonly handler: RouteHandler;
  readonly store: unknown;

  constructor(handler: RouteHandler, store: unknown, extract: Extractor, path: string, end: number) {
    throw new Error('not implemented: Match');
  }

  get params(): Record<string, string> {
    throw new Error('not implemented: Match.params');
  }
}
