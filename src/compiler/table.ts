import type { Dfa, Table } from './types';

export function buildTable(
  dfa: Dfa,
  rowOf: Int32Array, // per DFA state
  options: { scanAfter: number; scanRun: number }, // prototype: 8 and 8
): Table {
  throw new Error('not implemented: buildTable');
}
