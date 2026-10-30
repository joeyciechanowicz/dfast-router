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

/** `names` lists named groups, in order. */
export type Parsed =
  | { ok: true; ast: Ast; names: string[] }
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
}

/**
 * Called when the DFA gives no direct result, and always for a path holding a non-ASCII
 * character. `row` is the final state's accept row, or -1 if it has none.
 */
export type Miss = (path: string, method: number, end: number, row: number) => RouteMatch | null;
