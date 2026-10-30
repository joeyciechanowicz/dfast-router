import { NON_ASCII } from '../../src/compiler/types';
import type { Ast } from '../../src/compiler/types';

/**
 * Whether `ast` matches all of `input`, by tracking the set of positions it can reach. This is
 * deliberately not the NFA or DFA, so that it can check them, and the parser, independently.
 */
export function astMatches(ast: Ast, input: string): boolean {
  return advance(ast, input, new Set([0])).has(input.length);
}

function advance(ast: Ast, input: string, from: Set<number>): Set<number> {
  switch (ast.t) {
    case 'set': {
      const reached = new Set<number>();
      for (const position of from) {
        if (position < input.length) {
          const unit = input.charCodeAt(position);
          if (ast.set[unit < NON_ASCII ? unit : NON_ASCII] === 1) reached.add(position + 1);
        }
      }
      return reached;
    }
    case 'cat': {
      let reached = from;
      for (const x of ast.xs) reached = advance(x, input, reached);
      return reached;
    }
    case 'alt': {
      const reached = new Set<number>();
      for (const x of ast.xs) {
        for (const position of advance(x, input, from)) reached.add(position);
      }
      return reached;
    }
    case 'rep':
      return advanceRepeat(ast.x, ast.min, ast.max, input, from);
  }
}

function advanceRepeat(
  x: Ast,
  min: number,
  max: number,
  input: string,
  from: Set<number>,
): Set<number> {
  let required = from;
  for (let k = 0; k < min && required.size > 0; k += 1) required = advance(x, input, required);

  // Breadth first, so a position is first seen after the fewest optional iterations. That lets
  // each pass start from new positions only, and it also ends the loop for `(a*)*`.
  const reached = new Set(required);
  let frontier = required;
  for (let k = min; k < max && frontier.size > 0; k += 1) {
    const fresh = new Set<number>();
    for (const position of advance(x, input, frontier)) {
      if (!reached.has(position)) {
        reached.add(position);
        fresh.add(position);
      }
    }
    frontier = fresh;
  }
  return reached;
}
