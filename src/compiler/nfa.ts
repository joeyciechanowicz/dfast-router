import type { Ast, CharSet } from './types';

export class NFA {
  eps: number[][] = [];
  edges: [CharSet, number][][] = [];
  accept: number[] = [];

  add(): number {
    throw new Error('not implemented: NFA.add');
  }
}

export function frag(n: NFA, ast: Ast, from: number): number {
  throw new Error('not implemented: frag');
}
