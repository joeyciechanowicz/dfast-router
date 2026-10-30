import type { RouteHandler, RouteMatch } from '../types';

export const ALPHABET = 129;  // ASCII, plus one symbol for every code unit above 127
export const NON_ASCII = 128;
export const SLASH = 47;
export const QMARK = 63;

/**
 * Membership per symbol, 0 or 1. Never contains QMARK, because `?` ends the path.
 * NON_ASCII is 1 if the set holds any code unit above ASCII, so a set is exact on ASCII
 * and may over-accept above it. See "Non-ASCII paths" in PLAN.md.
 */
export type CharSet = Uint8Array;

export type Ast =
  | { t: 'set'; set: CharSet }
  | { t: 'cat'; xs: Ast[] }
  | { t: 'alt'; xs: Ast[] }
  | { t: 'rep'; x: Ast; min: number; max: number }; // max may be Infinity

/**
 * `names` lists named groups, in order. `inexact` means a set over-accepts above ASCII, so a match
 * on a non-ASCII path needs confirming. Without it, the AST is exact on every path.
 */
export type Parsed =
  | { ok: true; ast: Ast; names: string[]; inexact?: boolean }
  | { ok: false; reason: string };

export type ParseFragment = (source: string) => Parsed;

export type Segment =
  | { kind: 'static'; value: string }
  | { kind: 'param'; name: string; source: string | null; score: number } // source null = [^/?]+
  | { kind: 'wildcard'; name: string };

export interface Variant {
  segments: Segment[];              // a wildcard, if any, is last
  defaults: Record<string, string>; // params fixed for this variant, e.g. { path: '' }
  key: string;                      // equal key = same language and same params
  rank: number[];                   // per-segment score, compared left to right
}

export interface DfaInput {
  ast: Ast;
  tag: number; // lower tag = higher priority
}

export interface Dfa {
  states: number;
  classes: number;
  classOf: Uint8Array;            // symbol to class; length ALPHABET
  trans: Int32Array;              // [state * classes + class] = next state, or -1
  start: number;
  accepts: (Int32Array | null)[]; // per state: accepting tags, ascending
}

export type DfaResult =
  | { ok: true; dfa: Dfa }
  | { ok: false; reason: 'state-budget'; states: number };

export interface Table {
  tt: Uint16Array | Uint32Array;
  cls: Uint8Array;  // symbol to class; length ALPHABET
  shift: number;    // K in the target loop
  start: number;
  stop: number;     // x >= stop leaves the hot loop
  scan: number;     // x >= scan continues in slow()
  scanRun: number;  // chars slow() checks by hand before indexOf
  tail: Uint8Array; // by DFA state: 1 = can't be left, so slow() jumps to the path's end
  rowOf: Int32Array; // table state to accept row, or -1
}

export type Extractor = (path: string, end: number) => Record<string, string>;

export interface Results {
  rows: Int32Array;                 // [(row << methodBits) + method] = result index, or -1
  methodBits: number;
  handlers: RouteHandler[];         // by result index
  stores: unknown[];
  extractors: (Extractor | null)[]; // null = no params
  prebuilt: (RouteMatch | null)[];  // frozen result when there are no params
  inexact: Uint8Array;              // 1 = a non-ASCII path must be confirmed in `miss`
}

/**
 * Called when the DFA gives no direct result, and for a non-ASCII path whose result is
 * inexact. `row` is the final state's accept row, or -1 if it has none. `end` is the
 * path's end, or -1 if the DFA stopped before reaching it: `miss` finds it only if needed.
 */
export type Miss = (path: string, method: number, end: number, row: number) => RouteMatch | null;
