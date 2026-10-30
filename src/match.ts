import type { Extractor } from './compiler/types';
import type { RouteHandler, RouteMatch } from './types';

const NO_PARAMS: Record<string, string> = Object.freeze({});

/** The shared result for a variant with no params: no allocation on a hit (D5). */
export function prebuiltMatch(handler: RouteHandler, store: unknown): RouteMatch {
  return Object.freeze({ handler, store, params: NO_PARAMS });
}

/** A result whose `params` are built on first read (D4). */
export class Match implements RouteMatch {
  readonly handler: RouteHandler;
  readonly store: unknown;
  private readonly extract: Extractor;
  private readonly path: string;
  private readonly end: number;
  private extracted: Record<string, string> | null;

  constructor(handler: RouteHandler, store: unknown, extract: Extractor, path: string, end: number) {
    this.handler = handler;
    this.store = store;
    this.extract = extract;
    this.path = path;
    this.end = end;
    this.extracted = null;
  }

  get params(): Record<string, string> {
    if (this.extracted === null) this.extracted = this.extract(this.path, this.end);
    return this.extracted;
  }
}
