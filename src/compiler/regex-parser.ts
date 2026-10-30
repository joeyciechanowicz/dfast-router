import { mkset } from './charset';
import { ALPHABET, NON_ASCII } from './types';
import type { Ast, CharSet, Parsed } from './types';

/**
 * Regex source to AST, for the regexes whose language the DFA can hold.
 *
 * The AST is exact on ASCII. Above ASCII a set may over-accept but never under-accepts, as
 * "Non-ASCII paths" in PLAN.md requires. Valid JS that can't meet that returns `{ ok: false }`.
 *
 * Source is read as JS reads a regex without `u`: one code unit at a time, with the Annex B legacy
 * syntax. `RegExp` checks the syntax first, so the parser only ever sees valid source.
 */

interface Options {
  wholePath: boolean; // allow `^` and `$`, and add `[^?]*` on an unanchored side
  ignoreCase: boolean;
  dotAll: boolean;
}

/** A class escape such as `\d`. `every` means it holds every code unit above ASCII. */
interface Shorthand {
  set: CharSet;
  every: boolean;
}

/** AST nodes allowed once repeats are counted out. Past this, `a{1000000}` would hang the NFA. */
const MAX_EXPANDED_NODES = 100_000;

/** Recursion here and in the compiler stages after it would overflow the stack not far past this. */
const MAX_GROUP_DEPTH = 256;

const MAX_CODE_UNIT = 0xffff;
const BACKSPACE = 8;
const HYPHEN = 45;
const CASE_OFFSET = 32;
const CONTROL_MASK = 31;

/** `d` only records match indices. `g` and `y` make `test` stateful, so have no fixed language. */
const SUPPORTED_FLAGS = 'dis';

const QUANTIFIER = /\{(\d+)(?:,(\d*))?\}/y;
const HEX = /^[0-9a-fA-F]+$/;

const isDigit = (unit: number) => unit >= 48 && unit <= 57;
const isUpper = (unit: number) => unit >= 65 && unit <= 90;
const isLower = (unit: number) => unit >= 97 && unit <= 122;
const isLetter = (unit: number) => isUpper(unit) || isLower(unit);
const isWord = (unit: number) => isDigit(unit) || isLetter(unit) || unit === 95;
/** NON_ASCII stands in for U+00A0, U+2028, and the other spaces above ASCII. */
const isSpace = (symbol: number) =>
  (symbol >= 9 && symbol <= 13) || symbol === 32 || symbol === NON_ASCII;

const SHORTHANDS = new Map<string, Shorthand>([
  ['d', { set: mkset(isDigit), every: false }],
  ['D', { set: mkset((s) => !isDigit(s)), every: true }],
  ['w', { set: mkset(isWord), every: false }],
  ['W', { set: mkset((s) => !isWord(s)), every: true }],
  ['s', { set: mkset(isSpace), every: false }],
  ['S', { set: mkset((s) => !isSpace(s) || s === NON_ASCII), every: false }],
]);

const CONTROL_ESCAPES = new Map<string, number>([
  ['t', 9],
  ['n', 10],
  ['v', 11],
  ['f', 12],
  ['r', 13],
]);

const DOT = mkset((s) => s !== 10 && s !== 13);
const DOT_ALL = mkset(() => true);
const ANY_PATH: Ast = { t: 'rep', x: { t: 'set', set: DOT_ALL }, min: 0, max: Infinity };

/** Thrown for valid JS that has no exact AST. */
class Unsupported extends Error {}

/** A set being built. Negation needs what this holds above ASCII, which a CharSet can't say. */
class Members {
  private readonly symbols = new Uint8Array(ALPHABET);
  private every = false;

  /** Both ends are code units. They may be above ASCII. */
  addRange(low: number, high: number): void {
    for (let unit = low; unit <= high && unit < NON_ASCII; unit += 1) this.symbols[unit] = 1;
    if (high >= NON_ASCII) this.symbols[NON_ASCII] = 1;
    if (low <= NON_ASCII && high === MAX_CODE_UNIT) this.every = true;
  }

  add(item: number | Shorthand): void {
    if (typeof item === 'number') {
      this.addRange(item, item);
      return;
    }
    for (let symbol = 0; symbol < ALPHABET; symbol += 1) this.symbols[symbol] |= item.set[symbol];
    this.every = this.every || item.every;
  }

  /**
   * Under `i`, JS tests a candidate's folded form against each member's folded form, and only then
   * negates, so folding comes first. Without `u`, nothing above ASCII folds onto ASCII.
   *
   * A negated set holds something above ASCII unless this holds all of it. `every` may miss that
   * this does, as in `[\s\S]`, but then the negated set only over-accepts.
   */
  toSet(negated: boolean, ignoreCase: boolean): CharSet {
    const { symbols, every } = this;
    if (ignoreCase) {
      for (let upper = 65; upper <= 90; upper += 1) {
        const lower = upper + CASE_OFFSET;
        symbols[upper] = symbols[lower] = symbols[upper] | symbols[lower];
      }
    }
    if (!negated) return mkset((s) => symbols[s] === 1);
    return mkset((s) => (s === NON_ASCII ? !every : symbols[s] === 0));
  }
}

const allOf = (xs: Ast[]): Ast => (xs.length === 1 ? xs[0] : { t: 'cat', xs });
const eitherOf = (xs: Ast[]): Ast => (xs.length === 1 ? xs[0] : { t: 'alt', xs });

function repeat(x: Ast, min: number, max: number): Ast {
  if (max === 0) return allOf([]);
  if (min === 1 && max === 1) return x;
  return { t: 'rep', x, min, max };
}

class Parser {
  readonly names: string[] = [];
  private p = 0;
  private depth = 0;

  constructor(
    private readonly src: string,
    private readonly options: Options,
  ) {}

  parse(): Ast {
    if (!this.options.wholePath) return this.alternatives();
    const xs = [this.pathAlternative()];
    while (this.eat('|')) xs.push(this.pathAlternative());
    return eitherOf(xs);
  }

  private eat(ch: string): boolean {
    if (this.src[this.p] !== ch) return false;
    this.p += 1;
    return true;
  }

  /**
   * One top-level alternative of a whole-path regex. Anchors work here because this is the only
   * place where they mean the ends of the path. `^a|b$` anchors one side of each alternative.
   */
  private pathAlternative(): Ast {
    let anchoredStart = false;
    while (this.eat('^')) anchoredStart = true;
    const body = this.sequence(true);
    let anchoredEnd = false;
    while (this.eat('$')) anchoredEnd = true;
    const xs = [body];
    if (!anchoredStart) xs.unshift(ANY_PATH);
    if (!anchoredEnd) xs.push(ANY_PATH);
    return allOf(xs);
  }

  private alternatives(): Ast {
    const xs = [this.sequence(false)];
    while (this.eat('|')) xs.push(this.sequence(false));
    return eitherOf(xs);
  }

  private sequence(topLevel: boolean): Ast {
    const { src } = this;
    const xs: Ast[] = [];
    while (this.p < src.length && src[this.p] !== '|' && src[this.p] !== ')') {
      if (topLevel && this.atClosingAnchors()) break;
      xs.push(this.term());
    }
    return allOf(xs);
  }

  /** Whether only `$` is left in this alternative. */
  private atClosingAnchors(): boolean {
    const { src } = this;
    let q = this.p;
    while (src[q] === '$') q += 1;
    return q > this.p && (q === src.length || src[q] === '|');
  }

  private term(): Ast {
    const atom = this.atom();
    const bounds = this.quantifier();
    if (bounds === null) return atom;
    this.eat('?'); // lazy, which has the same language
    return repeat(atom, bounds.min, bounds.max);
  }

  private quantifier(): { min: number; max: number } | null {
    const { src } = this;
    const c = src[this.p];
    if (c === '*' || c === '+' || c === '?') {
      this.p += 1;
      return { min: c === '+' ? 1 : 0, max: c === '?' ? 1 : Infinity };
    }
    if (c !== '{') return null;
    QUANTIFIER.lastIndex = this.p;
    const braces = QUANTIFIER.exec(src);
    if (braces === null) return null; // a literal `{`, which the next term reads
    this.p += braces[0].length;
    const min = Number(braces[1]);
    if (braces[2] === undefined) return { min, max: min };
    return { min, max: braces[2] === '' ? Infinity : Number(braces[2]) };
  }

  private atom(): Ast {
    const { src } = this;
    switch (src[this.p]) {
      case '(':
        return this.group();
      case '[':
        return this.charClass();
      case '.':
        this.p += 1;
        return { t: 'set', set: this.options.dotAll ? DOT_ALL : DOT };
      case '\\': {
        const escape = this.escape(false);
        return typeof escape === 'number' ? this.literal(escape) : { t: 'set', set: escape.set };
      }
      case '^':
      case '$':
        throw new Unsupported(`\`${src[this.p]}\` away from the ends of a whole-path regex`);
      default:
        this.p += 1;
        return this.literal(src.charCodeAt(this.p - 1));
    }
  }

  private literal(unit: number): Ast {
    const members = new Members();
    members.add(unit);
    return { t: 'set', set: members.toSet(false, this.options.ignoreCase) };
  }

  private group(): Ast {
    const { src } = this;
    this.p += 1;
    if (src[this.p] === '?') {
      if (src[this.p + 1] === ':') {
        this.p += 2;
      } else {
        this.groupName();
      }
    }
    this.depth += 1;
    if (this.depth > MAX_GROUP_DEPTH) {
      throw new Unsupported(`groups nested past ${MAX_GROUP_DEPTH} levels`);
    }
    const inner = this.alternatives();
    this.depth -= 1;
    this.p += 1;
    return inner;
  }

  /** Reads `?<name>`, or rejects the other `(?` groups: lookaround and inline modifiers. */
  private groupName(): void {
    const { src } = this;
    const after = src[this.p + 2];
    if (src[this.p + 1] !== '<' || after === '=' || after === '!') {
      throw new Unsupported(`lookaround or inline modifier \`(${src.slice(this.p, this.p + 3)}\``);
    }
    const close = src.indexOf('>', this.p);
    const name = src.slice(this.p + 2, close);
    if (name.includes('\\')) throw new Unsupported(`escaped group name \`${name}\``);
    this.names.push(name);
    this.p = close + 1;
  }

  private charClass(): Ast {
    const { src } = this;
    this.p += 1;
    const negated = this.eat('^');
    const members = new Members();
    while (src[this.p] !== ']') {
      const low = this.classAtom();
      if (src[this.p] !== '-' || src[this.p + 1] === ']') {
        members.add(low);
        continue;
      }
      this.p += 1;
      const high = this.classAtom();
      if (typeof low === 'number' && typeof high === 'number') {
        members.addRange(low, high);
      } else {
        // A shorthand can't bound a range, so Annex B reads the `-` as itself.
        members.add(low);
        members.add(HYPHEN);
        members.add(high);
      }
    }
    this.p += 1;
    return { t: 'set', set: members.toSet(negated, this.options.ignoreCase) };
  }

  private classAtom(): number | Shorthand {
    const { src } = this;
    if (src[this.p] === '\\') return this.escape(true);
    this.p += 1;
    return src.charCodeAt(this.p - 1);
  }

  /** Reads one escape, returning its code unit or shorthand. */
  private escape(inClass: boolean): number | Shorthand {
    const { src } = this;
    const c = src[this.p + 1];
    this.p += 2;
    const shorthand = SHORTHANDS.get(c);
    if (shorthand !== undefined) return shorthand;
    const control = CONTROL_ESCAPES.get(c);
    if (control !== undefined) return control;
    switch (c) {
      case 'b':
        if (inClass) return BACKSPACE;
        throw new Unsupported('word boundary `\\b`');
      case 'B':
        if (inClass) return c.charCodeAt(0);
        throw new Unsupported('word boundary `\\B`');
      case '0':
        if (isDigit(src.charCodeAt(this.p))) throw new Unsupported('legacy octal escape');
        return 0;
      case '1':
      case '2':
      case '3':
      case '4':
      case '5':
      case '6':
      case '7':
      case '8':
      case '9':
        // Which of these it is depends on how many groups the regex has. Neither is worth keeping.
        throw new Unsupported(`backreference or legacy octal escape \`\\${c}\``);
      case 'c': {
        // Anything but a letter is legacy syntax, and differs between atoms and classes.
        const letter = src.charCodeAt(this.p);
        if (!isLetter(letter)) throw new Unsupported('`\\c` without a letter');
        this.p += 1;
        return letter & CONTROL_MASK;
      }
      case 'k':
        throw new Unsupported('named backreference `\\k`');
      case 'p':
      case 'P':
        throw new Unsupported(`property escape \`\\${c}\``);
      case 'x':
        return this.hex(2) ?? c.charCodeAt(0);
      case 'u':
        return this.hex(4) ?? c.charCodeAt(0);
      default:
        return c.charCodeAt(0);
    }
  }

  private hex(digits: number): number | null {
    const text = this.src.slice(this.p, this.p + digits);
    if (text.length !== digits || !HEX.test(text)) return null;
    this.p += digits;
    return parseInt(text, 16);
  }
}

function expandedNodes(ast: Ast): number {
  switch (ast.t) {
    case 'set':
      return 1;
    case 'cat':
    case 'alt':
      return ast.xs.reduce((total, x) => total + expandedNodes(x), 1);
    case 'rep':
      return 1 + expandedNodes(ast.x) * (ast.max === Infinity ? ast.min + 1 : ast.max);
  }
}

function parse(source: string, options: Options): Parsed {
  const parser = new Parser(source, options);
  try {
    const ast = parser.parse();
    if (expandedNodes(ast) > MAX_EXPANDED_NODES) {
      return { ok: false, reason: `repeats expand past ${MAX_EXPANDED_NODES} AST nodes` };
    }
    return { ok: true, ast, names: parser.names };
  } catch (error) {
    if (error instanceof Unsupported) return { ok: false, reason: error.message };
    throw error;
  }
}

/** Body of `:name(...)`, matched whole. */
export function parseFragment(source: string): Parsed {
  try {
    new RegExp(source);
  } catch (error) {
    return { ok: false, reason: `invalid regex: ${(error as Error).message}` };
  }
  return parse(source, { wholePath: false, ignoreCase: false, dotAll: false });
}

/** A whole path. Unanchored sides add `[^?]*`. */
export function parseRegExp(regex: RegExp): Parsed {
  for (const flag of regex.flags) {
    if (!SUPPORTED_FLAGS.includes(flag)) {
      return { ok: false, reason: `unsupported flag \`${flag}\`` };
    }
  }
  return parse(regex.source, {
    wholePath: true,
    ignoreCase: regex.ignoreCase,
    dotAll: regex.dotAll,
  });
}
