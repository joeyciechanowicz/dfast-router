import type { Extractor } from './compiler/types';
import type { Params, RouteHandler, RouteMatch, StoreOf } from './types';

const NO_PARAMS: Record<string, string> = Object.freeze({});

/** What every match of one route has in common, so that a match needs only a pointer to it. */
export class MatchTarget<THandler extends RouteHandler<any> = RouteHandler> {
  readonly handler: THandler;
  readonly store: StoreOf<THandler>;
  readonly extract: Extractor | null; // null = no params
  readonly prebuilt: Match<THandler> | null; // the shared result when there are no params: no allocation on a hit (D5)

  constructor(handler: THandler, store: StoreOf<THandler>, extract: Extractor | null) {
    this.handler = handler;
    this.store = store;
    this.extract = extract;
    this.prebuilt = extract === null ? new Match(this, '', 0, NO_PARAMS) : null;
  }
}

/** A result whose `params` are built on first read (D4). One class for every route, so reads stay monomorphic. */
export class Match<THandler extends RouteHandler<any> = RouteHandler> implements RouteMatch<THandler> {
  private readonly target: MatchTarget<THandler>;
  private readonly path: string;
  private readonly end: number;
  private extracted: Record<string, string> | null;

  constructor(target: MatchTarget<THandler>, path: string, end: number, extracted: Record<string, string> | null) {
    this.target = target;
    this.path = path;
    this.end = end;
    this.extracted = extracted;
  }

  get handler(): THandler {
    return this.target.handler;
  }

  get store(): StoreOf<THandler> {
    return this.target.store;
  }

  get params(): Params {
    if (this.extracted === null) this.extracted = (this.target.extract as Extractor)(this.path, this.end);
    return this.extracted;
  }
}
