// Compiles concrete patterns with the real compiler, so that the matcher runs on real DFAs.
import { buildDfa } from '../../src/compiler/dfa';
import { parsePattern, variantAst } from '../../src/compiler/pattern';
import { parseFragment } from '../../src/compiler/regex-parser';
import type { Dfa, DfaInput } from '../../src/compiler/types';

export interface FixturePattern {
  path: string;
  route: number;
}

function inputFor({ path }: FixturePattern, tag: number): DfaInput {
  const variants = parsePattern(path);
  if (variants.length !== 1) throw new Error(`${path} is not a concrete pattern`);
  const parsed = variantAst(variants[0], parseFragment);
  if (!parsed.ok) throw new Error(`${path}: ${parsed.reason}`);
  return { ast: parsed.ast, tag };
}

/** Each accepting tag is the index of its pattern. */
export function compileFixture(patterns: FixturePattern[]): { dfa: Dfa } {
  const result = buildDfa(patterns.map(inputFor), { maxStates: 1 << 20 });
  if (!result.ok) throw new Error(`state budget: ${result.states} states`);
  return { dfa: result.dfa };
}
