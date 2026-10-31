import type { Extractor } from './compiler/types';
import type { RouteHandler, RouteMatch } from './types';

const NO_PARAMS: Record<string, string> = Object.freeze({});

/** What every match of one route has in common, so that a match needs only a pointer to it. */
export class MatchTarget {
  readonly handler: RouteHandler;
  readonly store: unknown;
  readonly extract: Extractor | null; // null = no params
  readonly prebuilt: Match | null; // the shared result when there are no params: no allocation on a hit (D5)

  constructor(handler: RouteHandler, store: unknown, extract: Extractor | null) {
    this.handler = handler;
    this.store = store;
    this.extract = extract;
    this.prebuilt = extract === null ? new Match(this, '', 0, NO_PARAMS) : null;
  }
}

/** A result whose `params` are built on first read (D4). One class for every route, so reads stay monomorphic. */
export class Match implements RouteMatch {
  private readonly target: MatchTarget;
  private readonly path: string;
  private readonly end: number;
  private extracted: Record<string, string> | null;

  constructor(target: MatchTarget, path: string, end: number, extracted: Record<string, string> | null) {
    this.target = target;
    this.path = path;
    this.end = end;
    this.extracted = extracted;
  }

  get handler(): RouteHandler {
    return this.target.handler;
  }

  get store(): unknown {
    return this.target.store;
  }

  get params(): Record<string, string> {
    if (this.extracted === null) this.extracted = (this.target.extract as Extractor)(this.path, this.end);
    return this.extracted;
  }
}
