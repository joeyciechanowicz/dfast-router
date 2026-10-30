import type { Miss, Results, Table } from './compiler/types';
import type { RouteMatch } from './types';

export function createMatcher(
  table: Table, results: Results, miss: Miss,
): (path: string, method: number) => RouteMatch | null {
  throw new Error('not implemented: createMatcher');
}
