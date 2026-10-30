import type { RouteHandler, RouteMatch } from './types';

export class Router {
  on(method: string | string[], path: string | RegExp, handler: RouteHandler, store?: unknown): this {
    throw new Error('not implemented: Router.on');
  }

  find(method: string, path: string): RouteMatch | null {
    throw new Error('not implemented: Router.find');
  }

  compile(): void {
    throw new Error('not implemented: Router.compile');
  }
}

export function createRouter(): Router {
  throw new Error('not implemented: createRouter');
}
