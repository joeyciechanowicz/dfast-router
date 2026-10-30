import type { Ast, CharSet } from './types';

/** Thompson NFA. `accept[state]` is the index of the input accepting there, or -1. */
export class NFA {
  eps: number[][] = [];
  edges: [CharSet, number][][] = [];
  accept: number[] = [];

  add(): number {
    this.eps.push([]);
    this.edges.push([]);
    this.accept.push(-1);
    return this.eps.length - 1;
  }
}

/** Adds `ast` to `n`, entered from state `from`, and returns the state it ends in. */
export function frag(n: NFA, ast: Ast, from: number): number {
  switch (ast.t) {
    case 'set': {
      const to = n.add();
      n.edges[from].push([ast.set, to]);
      return to;
    }
    case 'cat': {
      let s = from;
      for (const x of ast.xs) s = frag(n, x, s);
      return s;
    }
    case 'alt': {
      const end = n.add();
      for (const x of ast.xs) {
        const a = n.add();
        n.eps[from].push(a);
        n.eps[frag(n, x, a)].push(end);
      }
      return end;
    }
    case 'rep': {
      let s = from;
      for (let k = 0; k < ast.min; k += 1) s = frag(n, ast.x, s);
      if (ast.max === Infinity) {
        const loop = n.add();
        n.eps[s].push(loop);
        n.eps[frag(n, ast.x, loop)].push(loop);
        const out = n.add();
        n.eps[loop].push(out);
        return out;
      }
      const end = n.add();
      n.eps[s].push(end);
      for (let k = ast.min; k < ast.max; k += 1) {
        s = frag(n, ast.x, s);
        n.eps[s].push(end);
      }
      return end;
    }
  }
}

/**
 * An upper bound on the states `frag` adds for `ast`, without building them. A float, since
 * nested counted repeats multiply: `(?:(?:a{1000}){1000}){1000}` is a short source for 10^9.
 * Each repeat counts as at least one, so that an empty body with a huge count is bounded too.
 */
export function nfaBound(ast: Ast): number {
  switch (ast.t) {
    case 'set':
      return 1;
    case 'cat':
      return ast.xs.reduce((sum, x) => sum + nfaBound(x), 0);
    case 'alt':
      return ast.xs.reduce((sum, x) => sum + 1 + nfaBound(x), 1);
    case 'rep': {
      const body = Math.max(nfaBound(ast.x), 1);
      return ast.max === Infinity ? (ast.min + 1) * body + 2 : ast.max * body + 1;
    }
  }
}
