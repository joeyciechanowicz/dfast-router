# Plan: table-driven DFA router

Replace the deleted router in `src/` with one DFA compiled from the whole route table, run from a typed-array table. The work is split into 13 work packages, done one at a time in a single session.

**Status:** implemented on `dfa-router`. Two items are open: the x86-64 re-run, and narrow misses on long params. See [Acceptance criteria](#acceptance-criteria). `PLAN.md` and `prototype/` stay until those are decided.

## Goal

Be measurably faster than medley while doing the same routing work. The tables below were measured against `medley-router-local`, a TypeScript copy of `@medley/router`. That copy was removed after G4, and the bench now uses `@medley/router` itself. On the generic routes the ratios match: see the [progress log](#progress-log).

| Router (`bench.mjs`, generic routes) | ops/s | ns | Hit rate |
|---|---:|---:|---:|
| medley as benched today | 15.14M | 66.0 | 13.7% |
| **medley given matchable routes (the real target)** | **7.04M** | **142.1** | 95% |
| Prototype, params built during `find` | 14.94M | 66.9 | 95% |
| Prototype, params deferred, not read | 20.14M | 49.7 | 95% |

Reading deferred params costs about 72ns against medley's 146ns (own harness, not `bench.mjs`).

The medley row at 13.7% is not a valid target: `bench.mjs` gives it raw regex patterns it reads as literal text. WP-2 fixes this.

## Decisions

These are settled for this plan. Changing one after G2 means reworking finished packages.

| # | Decision | Why |
|---|---|---|
| D1 | Remove `rebalance()` and the hit counters | Traffic-based state layout measured exactly zero gain (46.2ns both ways). Keeping a method that does nothing would mislead. |
| D2 | Trailing and double slashes are significant: `/items/` does not match `/items` | Matches medley and the differential reference. **Behaviour change:** the old router dropped empty segments. |
| D3 | `?` ends the path during matching | `req.url` includes the query string. **Behaviour change:** the old router did not strip it. |
| D4 | `match.params` is a lazy getter | The router is 2.9× medley when params go unread and 2× when read, and many routes have no params. `{ ...match.params }` still works. |
| D5 | Static-route results are shared, with frozen `params` | No allocation on static hits. Handlers must not mutate `params`. The result itself was frozen until 2026-10-31, when one `Match` class replaced it, to keep callers monomorphic. |
| D6 | Regex routes expose named groups (`(?<id>\d+)`) as params | Old regex routes returned empty params. Numbered groups stay unexposed. |
| D7 | No URL cache | The old GET cache only looks good because bench URLs are internalized literals with cached hashes. |
| D8 | `@medley/router` is the bench baseline, and the local copy is gone | Changed after G4: the published package is the same algorithm, so nothing needs a copy. |
| D9 | A route that expands to more than 256 variants throws at registration | Optional segments double the variants. A clear error is simpler than a second code path. |
| D10 | Paths containing a non-ASCII character are confirmed with `RegExp` | All such characters share one DFA symbol, which can't separate `/café` from `/cafü` or express `.` exactly. See [Non-ASCII paths](#non-ascii-paths). |
| D11 | Registering a variant that already exists for a method replaces it, keeping its position | Matches the old routers and medley. It applies per variant: `/a` replaces the shorter variant of an earlier `/a/:x?`. |

## Behaviour contract

`test/router.test.ts` and `test/automaton-router.test.ts` already define most of this. The prototype covers only the first three rows, so the rest is new work.

| Behaviour | Source | Prototype |
|---|---|---|
| Static, `:param`, `:param(regex)`, `:param?`, `(a\|b)` segments | tests, route sets | Yes |
| `.` and negated classes can cross `/`, as in `:categories(.+)` | `routes-specific` | Yes |
| `?` ends the path | D3 | Yes |
| `/files/*` gives `{ '*': rest }`; `/assets/:path*` gives `{ path: rest }` | tests | **No** |
| `/files/:path*` also matches `/files`, with `{ path: '' }` | tests | **No** |
| `/files/` matches `/files/:path*` with `{ path: '' }`: a wildcard's rest is `[^?]*` | reference | **No** |
| A wildcard ends the pattern: `/a/:first*/b/:second*` captures only `first` | tests | **No** |
| `#int`, `#alpha`, `#slug`, `#locale`, `#uuid`, also with `?`; unknown alias throws `Unknown validator alias` | tests | **No** |
| Priority rules below (prototype uses registration order, which **contradicts** the tests) | tests | **No** |
| Method arrays, case and whitespace normalization, `*`, unknown methods | tests | **No** |
| Raw `RegExp` routes, deduplicated by source and flags across methods | tests | **No** |
| Leading `/` added to paths; `''` becomes `/` | tests | **No** |
| `/café` does not match `/cafü`, and `.` stays exact above ASCII | D10, reference | **No** |
| `on()` returns the router and accepts `store`; `on()` after `find()` recompiles | tests, old code | **No** |

### Priority rules

For a URL and method M, try these tiers in order and stop at the first tier with a match:

1. Pattern routes registered for M
2. Pattern routes registered for `*`
3. Regex routes registered for M
4. Regex routes registered for `*`

Within a pattern tier, compare routes left to right by segment score. The first difference decides, higher wins, and ties go to registration order:

| Segment | Static | `#int` | `#uuid` | `#locale` | `#alpha` | `#slug` | `:name(regex)` | `:name` | wildcard |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Score | 100 | 40 | 35 | 30 | 25 | 20 | 10 | 0 | -100 |

The numbers below 100 come from `scoreEdge` in `git show c53789e:src/automaton-router.ts`. Static ranks above them all.

- **Unequal lengths:** when one rank is shorter, its missing entries count as 0.
- **Wildcard empty match:** that variant keeps the wildcard's -100, so `/files` beats the empty match of `/files/:path*` in either registration order.
- **Regex tiers:** order is per method, the order of that method's registrations.

**Neither bench route set exercises these rules.** On both, no URL (corpus plus 400k mutations) matches more than one route, so a router with wrong ranking would still pass every differential check on them. WP-7 adds an overlapping route set to close this gap.

Alias regexes, derived from the old validator functions:

| Alias | Regex |
|---|---|
| `#int` | `[0-9]+` |
| `#alpha` | `[A-Za-z]+` |
| `#slug` | `[A-Za-z0-9-]+` |
| `#locale` | `[a-z]{2}-[A-Z]{2}` |
| `#uuid` | `[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}` |

## Architecture

```
src/
  index.ts             createRouter, Router, types
  types.ts             public types
  router.ts            on(), find(), compile(), method table
  matcher.ts           hot loop and slow continuation (the only perf-critical file)
  match.ts             Match class, prebuilt static results
  compiler/
    types.ts           shared compiler types (frozen in WP-1)
    charset.ts         129-symbol sets: ASCII plus one bucket for everything else
    regex-parser.ts    regex source to AST, or a reason it can't be compiled
    pattern.ts         route string to variants, rank keys, aliases, wildcards
    nfa.ts             Thompson construction
    dfa.ts             subset construction, state budget, minimization
    table.ts           DFA to typed arrays and scan chains
    extract.ts         per-variant param extraction
```

Where the code comes from in `prototype/rc.mjs`:

| Prototype | Target | Change needed |
|---|---|---|
| `mkset`, set helpers | `charset.ts` | Types only |
| `parseRegex` | `regex-parser.ts` | Full `RegExp` syntax |
| `parseConcrete`, `shim-common.cjs` `expand` | `pattern.ts` | Wildcards, aliases, rank keys |
| `NFA`, `frag` | `nfa.ts` | Types only |
| `compile` | `dfa.ts` | Full accept sets, Hopcroft, state budget |
| `buildFast` (`tail: true` path only) | `table.ts`, `matcher.ts` | Add methods; drop `visits` renumbering |
| `widthOf`, `mayCross`, `extractor` | `extract.ts` | Add wildcards and a `RegExp.exec` fallback |

**Do not port:** `profile`, `buildTable`, `codegen`, `instantiate`, `buildPathTree`, `codegenHot`, `instantiateHot`, `compile2`, `codegen2`, the `direct` table mode, or the nested-loop `gal` path. Each one lost a measured comparison.

### Rules for `matcher.ts`

Each rule comes from a measurement. Breaking one needs a benchmark that justifies it.

1. **Keep one flat loop.** Nesting it in an outer loop cost 5.5ns even when the outer loop never ran.
2. **Allow one exit check per character** (`x >= STOP`). Dead states, `?`, scan states and any future unbuilt states all share it.
3. **Do not track slashes while scanning.** Recover positions after the match.
4. **Put rare work in a separate function,** never in the hot function.
5. **Do not generate routing branches.** On shuffled traffic, generated code lost 28ns to mispredicts.

Target shape:

```ts
for (; i < n; i++) {
  const c = s.charCodeAt(i);
  x = TT[(st << K) + CLS[c < 128 ? c : 128]];
  if (x >= STOP) break;
  st = x;
}
if (x >= SCAN) return slow(s, i, n, x, m);
// resolve the accept row for state st and method m
```

### Methods

Use one DFA for all methods. Keep every pattern that accepts in a state, then precompute a row per accepting state with one result per method.

- Reserve method id 0 for methods no route names, so they resolve to `*` routes only.
- `rowOf[st]` gives a row, and `rows[(row << methodBits) + m]` gives the result. That's one extra load per lookup, not per character.
- `find` checks `method === 'GET'` first, then falls back to a normalizing `Map`.

### Non-ASCII paths

Every code unit above ASCII shares the `NON_ASCII` symbol, so the DFA can't be exact above ASCII. The design makes that safe without touching the hot loop:

1. **Sets over-accept, and never under-accept.** A set includes `NON_ASCII` if it holds any code unit above ASCII. So `.`, `\s`, `\S`, and a static `é` all compile, and a missing `NON_ASCII` transition is an exact rejection.
2. **The hot loop exits on the first non-ASCII character.** `buildTable` gives `NON_ASCII` its own class and encodes all its transitions in the scan band, so `x >= scan` catches them with no new check.
3. **`slow` continues the DFA, then always calls `miss`** with the final row. It must also notice non-ASCII characters inside a galloped range, because `indexOf` skips over them.
4. **`miss` confirms the row's candidates** in priority order with `variantRegExp`.

Raw non-ASCII in `req.url` is rare, since clients percent-encode it. Confirmation only runs a few candidates' regexes, not the whole table.

### Param extraction

Use the cheapest method that is correct for each variant, in this order:

1. Fixed offsets, when everything before the param has a known width
2. Anchoring from the end of the path, when everything after has a known width
3. `indexOf('/')`, when the param cannot contain `/`
4. `RegExp.exec` for the variant, for anything else: `.+` before another variable segment, for example

The prototype throws on case 4.

## Shared contracts

These are the interfaces between modules, in `src/compiler/types.ts` and `src/types.ts`. Change the code and this section together.

`src/types.ts`:

```ts
export type RouteHandler = (req: any, res: any, params: Record<string, string>) => any;

export interface RouteMatch {
  handler: RouteHandler;
  params: Record<string, string>;
  store?: unknown;
}
```

`src/compiler/types.ts`:

```ts
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
```

Module signatures:

```ts
// charset.ts (implemented)
export function mkset(f: (symbol: number) => boolean): CharSet;
export function single(symbol: number): CharSet;
export function code(ch: string): number;                // clamps to NON_ASCII
export function segSet(): CharSet;                       // [^/?]
// regex-parser.ts
export function parseFragment(source: string): Parsed;   // body of :name(...), matched whole
export function parseRegExp(regex: RegExp): Parsed;      // whole path; unanchored sides add [^?]*
// pattern.ts
export function parsePattern(path: string): Variant[];   // throws on unknown alias, or over 256 variants
export function variantAst(v: Variant, parse: ParseFragment): Parsed;
export function variantRegExp(v: Variant): RegExp;       // exact, for non-ASCII confirmation
export function compareRank(a: Variant, b: Variant): number; // negative when a wins
// extract.ts
export function buildExtractor(v: Variant, parse: ParseFragment): Extractor | null;
// dfa.ts
export function buildDfa(inputs: DfaInput[], options: { maxStates: number }): DfaResult;
// table.ts
export function buildTable(
  dfa: Dfa,
  rowOf: Int32Array, // per DFA state
  options: { scanAfter: number; scanRun: number }, // prototype: 8 and 8
): Table;
// matcher.ts
export function createMatcher(
  table: Table, results: Results, miss: Miss,
): (path: string, method: number) => RouteMatch | null;
// router.ts
export class Router {
  on(method: string | string[], path: string | RegExp, handler: RouteHandler, store?: unknown): this;
  find(method: string, path: string): RouteMatch | null;
  compile(): void;
}
export interface RouterOptions { maxStates?: number } // default 262,144
export function createRouter(options?: RouterOptions): Router;
```

`Router.residual(): string[]` lists the routes not fully compiled into the DFA, which keep backtracking exposure (WP-9).

## Execution

Packages run strictly one at a time, in the main checkout on `dfa-router`, with no subagents or worktrees. Parallel work was tried and stopped: the partial work from WP-2 to WP-7 is carried into the packages below.

```
WP-0 → WP-1 → WP-3 → WP-4 → WP-5 → WP-6 → WP-2 → G1 → WP-7 → WP-8 → G2 → WP-9 → G3 → WP-11 → G4 → WP-12
```

WP-10 was dropped, on evidence from WP-9. See [its section](#wp-10-on-demand-states-spike).

The order follows real dependencies, so each package builds on the finished one before it rather than on a stand-in.

For each package:

1. Read its section, and make one focused change at a time.
2. Run every command under "Done when" and read the output. Do not assume a pass.
3. Commit it, with its number in the message, then update the [progress log](#progress-log).
4. If a contract has to change, change `src/compiler/types.ts` and this document together, and note why.

Rules that still apply:

- **Never weaken, skip, or delete a test or gate to make it pass.** If a gate fails, stop there, profile, and fix it.
- **`npm test` matches everything under `test/`,** including the 3M-URL differential, so run only the package's own test files until WP-8.
- **Follow `AGENTS.md` for performance changes:** profile first, change one thing, run `npm run bench:compare`, and keep only wins. WP-11 is where this applies in full.
- **Keep timing honest.** Other work on the machine distorts timing (same code: idle 47.3ns, 3 busy processes +4%, 6 +12%, 8 +41%), and idle runs alone span 47–51ns. Run timing only with nothing else running, with the 1-minute load in `uptime` under 2, and compare variants in a fixed rotation.

### Running a gate

1. Run `npm run build`.
2. Run the gate. Use `npm run bench:compare`, or `bench/bench.mjs` with best of 3 seeds at 3s each, so that numbers stay comparable with the tables here.
3. Add the numbers to the [progress log](#progress-log).

## Work packages

### WP-0: Preflight

**Owns:** `.gitignore`, `scripts/setup-worktree.sh`.

1. Create the branch: `git switch -c dfa-router`.
2. In `.gitignore`, change `node_modules/` (line 41) to `node_modules`, so a symlink also matches.
3. Add `scripts/setup-worktree.sh`, and make it executable:

   ```bash
   #!/usr/bin/env bash
   # Prepare a linked worktree: link what git ignores, then build if there is source.
   set -euo pipefail
   main="$(git worktree list --porcelain | sed -n '1s/^worktree //p')"
   here="$(git rev-parse --show-toplevel)"
   if [ "$(cd "$main" && pwd -P)" = "$(cd "$here" && pwd -P)" ]; then
     echo "Run this from a linked worktree, not the main checkout." >&2
     exit 1
   fi
   ln -sfn "$main/node_modules" "$here/node_modules"
   for f in bench/routes-specific.mjs bench/routes-specific.urls.mjs; do
     if [ -e "$main/$f" ]; then ln -sfn "$main/$f" "$here/$f"; fi
   done
   if [ -d "$here/src" ]; then
     (cd "$here" && node node_modules/typescript/bin/tsc -p tsconfig.json)
   fi
   echo "Worktree ready: $here"
   ```

4. Commit `PLAN.md`, `prototype/`, `.gitignore`, and the script. Agents can't see anything uncommitted.

**Done when:** a new worktree from `dfa-router` contains `PLAN.md` and `prototype/`, the script succeeds there, and `git status` in it is clean.

### WP-1: Foundation

**Depends on:** WP-0. **Owns:** `src/index.ts`, `src/types.ts`, `src/medley-router.ts`, `src/router.ts`, `src/matcher.ts`, `src/match.ts`, `src/compiler/*`, `bench/reference.mjs`, `test/reference.test.mjs`.

1. Restore the baseline: `git show c53789e:src/medley-router.ts > src/medley-router.ts`. Its compiled output is byte-identical to the current `dist/medley-router.js`.
2. Write `src/types.ts` and `src/compiler/types.ts` exactly as in [Shared contracts](#shared-contracts).
3. Add a stub for every module signature, each throwing `not implemented: <name>`, so that every worktree builds from the start.
4. Add `src/index.ts`, exporting `createRouter`, `Router`, the public types, and `createMedleyRouter`.
5. Add `bench/reference.mjs`, based on the regex scan in `prototype/verify.mjs`:
   - Export `createReference(routes)`, returning `(url, method = 'GET') => { route, params } | null`.
   - A route has `concretePaths`, which may hold `RegExp` entries, and an optional `method`, a string or array.
   - Cut the URL at `?`, and apply the priority rules for rank and tier.
   - It must not import anything from `src/`. An independent reference is what stops it sharing a bug with the router.
6. Add `test/reference.test.mjs`, with hand-written priority cases.

**Done when:**

```bash
npm run build
npx tsx --test test/reference.test.mjs
```

`bench.mjs` will fail until WP-2 merges, because its validation calls the stubbed `createRouter`. That's expected.

### WP-2: Bench harness

**Depends on:** WP-1. **Owns:** `bench/bench.mjs`, `bench/routes.mjs`, `bench/corpus.mjs` (new), `scripts/bench/compare.mjs`, `package.json`, `prototype/shim-dfa.cjs`.

1. Point `validateRouteDefinitions` (`bench/bench.mjs:110`) at `bench/reference.mjs`.
2. Register medley with `frameworkRouteFixtures` in `buildMedleyRouter` and `buildMedleyRouterLocal` (`bench/bench.mjs:207`, `:228`).
3. Add `["balancing-router", buildBalancingRouter]` to `routerBuilders` (`:312`), and remove its `warmup`. If `createRouter` throws, the existing `logBuildError` path should skip the router.
4. Add `hitRate` to results from a 100k-URL sample. Fail the run if a router is more than 0.1 points below the reference. Report over-matching without failing, because medley can't validate param regexes.
5. Replay fresh, flat, non-internalized strings by default: `Buffer.from(u, 'latin1').toString('latin1')`.
6. Add `--corpus near404|query|uuid36|token200`, porting the generators from `prototype/stress.mjs` to `bench/corpus.mjs`.
7. Add `--read-params`, which reads `.params` on every hit.
8. In `compare.mjs`, run each router in its own process and print each router's ratio to medley.
9. Add a `createRouter` adapter to `prototype/shim-dfa.cjs`, so that the prototype can run in the `balancing-router` slot. G2 compares against it in the same session.
10. In `package.json`, remove `bench:gate` and `bench:matrix`, whose files no longer exist. Change `test:consistency` to `FULL_CORPUS=1 tsx test/router-consistency.test.mjs`.
11. Remove `createAutomatonRouter` and `buildBalancingRouterV2` from the bench.

**Done when:** these all run without errors. Check behaviour only, because speed is judged at G1:

```bash
npm run build
node bench/bench.mjs --json --time 200 --only medley-router-local
node bench/bench.mjs --json --time 200 --only medley-router-local --read-params --corpus near404
node bench/bench.mjs --json --time 200 --only balancing-router --router "$PWD/prototype/shim-dfa.cjs"
```

`hitRate` must be about 95% for both routers on the clean corpus.

### WP-3: Regex parser

**Depends on:** WP-1. **Owns:** `src/compiler/regex-parser.ts`, `test/compiler/regex-parser.test.ts`, `test/compiler/regex-fuzz.test.ts`, `test/helpers/ast-match.ts`.

The rule for this package: **preserve a regex's exact language, or return `{ ok: false }`. Never approximate.** A wrong parse silently changes which URLs match.

1. Port `parseRegex` from `prototype/rc.mjs`, using `charset.ts`. Only `?` is masked out of sets, because real regexes can cross `/`.
2. Support `^`, `$`, `\d \D \w \W \s \S`, `\xHH`, `\uHHHH`, classes with escapes, lazy quantifiers (same language as greedy), named and non-capturing groups, and the `i` and `s` flags.
3. In `parseRegExp`, treat a missing `^` or `$` as `[^?]*` on that side.
4. Set `NON_ASCII` on any set that holds a code unit above ASCII ([Non-ASCII paths](#non-ascii-paths)). That's what lets `.`, `\s`, `\S`, and negated classes compile.
5. Return `{ ok: false }` for backreferences, lookaround, `\b`, `\p{...}`, the `m`, `u`, and `v` flags, and `^` or `$` anywhere except the ends. Case folding under `u` can map non-ASCII characters onto ASCII, which would break the over-accept guarantee.
6. Add `test/helpers/ast-match.ts`: a small AST matcher tracking sets of positions, independent of the NFA and DFA.

**Done when:**

```bash
npm run build
npx tsx --test test/compiler/regex-parser.test.ts test/compiler/regex-fuzz.test.ts
```

The fuzz test generates random regexes and strings, with a fixed seed printed on failure, on at least 100k pairs:

- On ASCII strings, the AST matcher must equal `RegExp.test`.
- On non-ASCII strings, it may over-accept, but must never reject what `RegExp.test` accepts.

### WP-4: NFA and DFA

**Depends on:** WP-1. **Owns:** `src/compiler/nfa.ts`, `src/compiler/dfa.ts`, `test/compiler/dfa.test.ts`.

1. Port `NFA`, `frag`, and `compile` from `prototype/rc.mjs`.
2. Keep **full** accept sets per state, and include them in the minimization key. The prototype keeps only the lowest index, which can't support per-method results.
3. Replace Moore minimization with Hopcroft. Moore took about 94s of the 99s on 300 overlapping routes.
4. Replace the string keys built with `join` in subset construction.
5. Honour `maxStates`, returning `state-budget` promptly.
6. Test with a generator that produces each random AST alongside an equivalent regex source, which gives `RegExp` as an oracle.

**Done when:**

```bash
npm run build
npx tsx --test test/compiler/dfa.test.ts
```

The test must show that:
- A DFA walk equals `RegExp.test` on at least 100k random pairs.
- Minimizing never changes acceptance.
- With the `overlap` generator from `prototype/scale.mjs`, 300 routes build in under 20s.
- 1000 overlapping routes return `state-budget` in under 20s.
- 3000 REST routes build in under 2s.


### WP-5: Patterns and extraction

**Depends on:** WP-1. **Owns:** `src/compiler/pattern.ts`, `src/compiler/extract.ts`, `test/compiler/pattern.test.ts`, `test/compiler/extract.test.ts`.

1. Port `parseConcrete`, `expand`, `widthOf`, `mayCross`, and `extractor`.
2. Implement in `pattern.ts`:
   - `(a|b)` segments and `:name?` optionals
   - Aliases, including `#int?`, throwing `Unknown validator alias`
   - Wildcards, which end the pattern, match `[^?]*`, and add an empty-match variant through `defaults`
   - Rank keys and `compareRank`, following the [priority rules](#priority-rules)
   - `variantRegExp`, exact for every variant, including escaped static text
   - The 256-variant limit (D9)
3. Implement the four extraction cases in `extract.ts`, including the `RegExp.exec` case the prototype throws on.
4. Keep the fast extractors as `new Function`, as in the prototype. Return `null` for variants with no params and no defaults.

**Done when:**

```bash
npm run build
npx tsx --test test/compiler/pattern.test.ts test/compiler/extract.test.ts
```

Tests must cover every wildcard and alias row of the contract, and show extraction equal to `RegExp.exec` on generated URLs for all four cases.

### WP-6: Table and matcher

**Depends on:** WP-1. **Owns:** `src/compiler/table.ts`, `src/matcher.ts`, `src/match.ts`, `test/compiler/matcher.test.ts`, `test/helpers/dfa-fixture.ts`.

1. Port the `tail: true` path of `buildFast`, without the `direct` mode, `visits` renumbering, or the nested `gal` loop.
2. Write the hot loop as a normal closure over `const` typed arrays, following the [rules for `matcher.ts`](#rules-for-matcherts).
3. Add the `Match` class with the lazy `params` getter (D4), and return `prebuilt` results where they exist (D5).
4. Use `rowOf` and `rows` for results, and call `miss` when there's no direct result.
5. Use `Int32Array` for accept data. The prototype's `Int16Array` limits it to 32,767 variants.
6. Implement [Non-ASCII paths](#non-ascii-paths) steps 2 and 3. Giving `NON_ASCII` its own class may double the table when the class count crosses a power of two. G2 checks whether that costs anything.

Build test fixtures with the real `parsePattern` and `buildDfa`, so the matcher runs on real routes.

**Done when:**

```bash
npm run build
npx tsx --test test/compiler/matcher.test.ts
```

Tests must cover both bench route sets with zero mismatches against `bench/reference.mjs`, plus long params, query strings, empty paths, and non-ASCII characters. Both `find` paths must be checked: the hot loop and `slow`. Include a non-ASCII character inside a param long enough to gallop, which must still reach `miss`.

### WP-7: Contract and differential tests

**Depends on:** WP-1. **Owns:** `test/router.test.ts`, `test/automaton-router.test.ts`, `test/router-consistency.test.mjs`, `test/fixtures/*`.

Write these from the [Behaviour contract](#behaviour-contract), not from any implementation. They're an independent check on the router.

1. Move `test/automaton-router.test.ts` into `test/router.test.ts` against `createRouter`, and delete the old file.
2. Add tests for what's new: D2, D3, D5, D10, D11, recompiling after `on()`, `%` left undecoded, and the priority rules across all four tiers. For D10, include `/café` against `/cafü`, and `.+` against a path holding `\u2028`.
3. Mark the D6 named-groups test `{ todo: 'WP-9' }`.
4. Rewrite `test/router-consistency.test.mjs` as the differential test. Compare route and params against `bench/reference.mjs`, keeping the mutations from `prototype/verify.mjs`.
   - Run a 50k-URL sample by default, and everything when `FULL_CORPUS=1`.
   - Include `routes-specific` when present, and print a visible skip message when not. This held-out set caught a real semantic bug in the prototype.
   - Support `DIFF_TARGET=prototype`, which builds the router as `cand.mjs` builds `tail-lazy`.
5. Add `test/fixtures/routes-overlap.mjs`: a route set where URLs match several routes, covering static against param, param scores, wildcards, and same-language routes with different names. Without this, the differential test can't detect a ranking bug. Use the route shape from `bench/reference.mjs`. Keep named groups out of its regex routes, because WP-8 returns empty params for them. WP-9 adds a named-group route.
6. Add a harness self-test: run the differential against a deliberately broken router, with one wrong param and one swapped priority, and require it to fail.

**Done when:**

```bash
npm run build
DIFF_TARGET=prototype npm run test:consistency   # bench route sets: 0 mismatches
```

Registration order and required ranking never disagree on the two bench route sets, so the prototype should pass there with no false alarms. It's expected to fail on `routes-overlap`, which is also proof that the fixture works. `test/router.test.ts` stays red until WP-8.

### G1: Foundations verified

**Machine idle. Runs after WP-2, once the matcher and bench exist.**

- [ ] Every "Done when" command so far still passes.
- [ ] `npm run build` passes with no stubs left except `src/router.ts`.
- [ ] medley reports about 7M ops/s at about 95% hit rate on generic routes.
- [ ] Record medley and the prototype (through `prototype/shim-dfa.cjs`) in the progress log, with and without `--read-params`. Earlier numbers don't carry over, because this bench uses fresh strings.

### WP-8: Router integration

**Depends on:** WP-7. **Owns:** `src/router.ts`, `src/index.ts`.

1. Implement `on`: normalize methods and paths, expand patterns with `parsePattern`, and merge variants by `key` across methods.
2. Implement `compile`: sort variants with `compareRank`, build ASTs, call `buildDfa`, build per-method rows, then `buildTable` and `createMatcher`. Use a `maxStates` of 32,767 for now.
3. Implement `find`: the `GET` fast path, then the normalizing `Map`. Handle empty paths and a missing leading `/` in `miss`, so the hot loop pays nothing.
4. Keep every `RegExp` route as a residual route for now: test them in `miss` with `RegExp.test`, in tier and registration order, and deduplicate by source and flags. Keep each method's own order, because the old code's shared order disagrees with the reference. WP-9 compiles them into the DFA.
5. Implement [Non-ASCII paths](#non-ascii-paths) step 4 in `miss`, keeping a per-row candidate list.
6. Apply D11 when merging by `key`.
7. Recompile on the next `find` after `on()`.
8. If G2's prototype comparison misses, try `new Function` for the hot loop, as the prototype does. Keep it only if it wins by more than 3%.

**Done when:**

```bash
npm test
FULL_CORPUS=1 npm run test:consistency
```

All tests pass except the `todo`, and the differential shows 0 mismatches on all three route sets, including `routes-overlap`.

### G2: Parity with the prototype

**Machine idle.** Stop here if this fails: every later package builds on it.

- [ ] `balancing-router` is within 5% of the prototype, measured in the same session.
- [ ] At least 1.9× medley with `--read-params`, and at least 2.5× without, on both route sets. These sit below the prototype's 2.0× and 2.9× because methods add real work.
- [ ] `find` reaches TurboFan (see `prototype/status.mjs`).

### WP-9: Regex routes and budget policy

**Depends on:** G2. **Owns:** `src/router.ts`, `src/index.ts`.

1. Compile `RegExp` routes into the DFA through `parseRegExp` when it returns `ok`. Keep the others as residual routes.
2. Keep the priority order: compiled and residual regex routes merge by registration order within a tier. Where a residual route could outrank a compiled one, set that `rows` entry to -1, so that `miss` decides.
3. Filter residual routes with the literal prefix (`extractRegexLiteralPrefix` in `git show c53789e:src/index.ts`).
4. Clone regexes without `g` and `y`, because they make `test` stateful.
5. Expose named groups as params through `exec` on first read (D6), remove the `todo` from that test, and add a named-group route to `routes-overlap`.
6. Compile each route alone first, and demote any route over a per-route state limit to residual. Start at 4,096 states, which handles the crafted `[ab]*a[ab]{14}` case.
7. If the whole table exceeds `maxStates`, throw an error naming the route that goes over.
8. Add a way to see how many routes were demoted, because residual routes keep backtracking and ReDoS exposure.

**Done when:** `npm test` and `FULL_CORPUS=1 npm run test:consistency` pass with no `todo` left, and a test shows that a pathological route set fails or demotes rather than hanging.

### WP-10: On-demand states spike

**Depends on:** WP-9. **Owns:** `src/compiler/lazy-dfa.ts` (new), and may change `src/matcher.ts` and `src/compiler/table.ts`. **Do this on a side branch, and merge only on a go.**

**Decision: not built.** Its case was that 300 overlapping routes took 99s and 1000 didn't finish. With Hopcroft, those take 0.7s and 28s, so raising the eager budget to 262,144 states (`RouterOptions.maxStates`) covers the realistic range, and past that the router fails fast and names a route. Building states at request time would add an attack surface for route tables nobody is known to have. The rest of this section records the design, in case that changes.

Build DFA states on first use, as RE2 does. Unbuilt transitions hold a sentinel above `stop`, so the hot loop is unchanged. Traffic touched only 6.6% of states in the 300-route overlap case, which is why this looks promising, but it's unbuilt and unproven.

**Done when** there's a working spike, plus a test of URLs crafted to force new states, and memory bounded by a fixed cap with a flush when full.

Decide go or no-go at G3. Go only if all of these hold:

- Lookups in the overlap case are within 2× of the eager table.
- Memory stays under the cap, including under the adversarial test. State building happens at request time, so it adds an attack surface.
- Routers that don't need it see no slowdown.

### G3: Feature complete

**Machine idle.**

- [ ] All contract tests pass, and regex fuzz shows 0 mismatches.
- [ ] A router with no residual routes shows no slowdown against G2.
- [ ] The crafted route and the 1000-route overlap case neither hang nor crash.

### WP-11: Tuning

**Depends on:** G3. **Owns:** anything in `src/`.

Follow the `AGENTS.md` workflow exactly: profile first, make one change, run `npm run bench:compare`, keep only wins, and commit each one separately.

1. **Scale.** The lead narrows from 2.1× at 100 routes (85ns vs 181ns) to 1.4× at 3000 (190ns vs 269ns). Scan chains grow the table from 905KB to 1655KB, and thousands of rarely-run extractors may never warm up. Neither has been shown to be the cause.
2. **Scan threshold.** `scanAfter = 8` came from a small, noisy sweep. Try capping chain states on large tables.
3. **Wildcards.** Add a fast scan for `[^?]*` states.
4. **CSP.** Fall back to data-driven extraction when `new Function` throws.
5. **x86-64.** Every number so far is from one Apple M1 Pro. Re-run on x86-64 Linux, because the mispredict results that drove this design may differ there. This needs a person or CI to provide the machine. If the ranking of table against generated code changes, stop and report.

**Done when** every item has a measured result in the progress log, including items that produced no win.

### G4: Acceptance

**Machine idle.** Every row of [Acceptance criteria](#acceptance-criteria) passes, on both route sets.

### WP-12: Docs and cleanup

**Depends on:** G4. **Owns:** `README.md`, `how-it-works.md`, `AGENTS.md`, `package.json`, `profile-medley-router.txt`, `prototype/`, `PLAN.md`.

1. Rewrite `README.md` and `how-it-works.md` for the new design, with D2 and D3 called out as behaviour changes.
2. Update `AGENTS.md`: replace the `src/index.ts` and rebalance guidance, and add the hit-rate and one-process-per-router rules.
3. Update the `package.json` description, and delete `profile-medley-router.txt`.
4. Check that nothing imports `prototype/`, then delete it. **Held back until the open items are decided.**
5. Delete this plan last, once the progress log's final numbers are in `how-it-works.md`. **Held back, as above.**

**Done when:** `npm run build`, `npm test`, and `FULL_CORPUS=1 npm run test:consistency` all pass with `prototype/` gone.

## Acceptance criteria

Measured at G4, in rotation against medley given matchable routes, with the 1-minute load between 2.4 and 5.5 for most of the run. Where there are two numbers, they're for the generic and held-out route sets.

| Check | Requirement | Result | |
|---|---:|---:|---|
| `npm test` | All pass | 309 of 309 | Pass |
| Differential, including `routes-overlap` | 0 mismatches on route and params | 0 of 2.7M lookups | Pass |
| Regex fuzz | 0 mismatches | 0 | Pass |
| `bench.mjs --read-params` | ≥ 1.9× | 2.05×, 2.14× | Pass |
| `bench.mjs`, params unread | ≥ 2.5× | 2.97×, 3.05× | Pass |
| Near-miss 404s | ≥ 1.8× | 2.39×, 2.44× | Pass |
| Query strings | ≥ 1.8× | 1.82×, 1.91× | Pass |
| UUID params | ≥ 1.8× | 1.75×, 1.80× | **Narrow miss** |
| 200-char token params | ≥ 1.8× | 1.76×, 1.79× | **Narrow miss** |
| Wildcard tails (added at WP-11) | Beat medley | 56ns vs 60ns at 200 chars | Pass |
| 3000 REST routes, uniform traffic | ≥ 1.4×, compile under 1s | 1.61×, 0.12s | Pass |
| Pathological route tables | No hang; clear failure or demotion | Fails in 20s, naming a route | Pass |
| Hit rate in every benchmark | Within 0.1 points of the reference | Enforced by `bench.mjs` | Pass |
| Node 20, 24, 25 | All pass | 309 of 309 on each | Pass |
| x86-64 re-run | Table design still ranks first | **Not run** | **Open** |

The two narrow misses are on a gate set from the prototype in a lighter harness. On `bench.mjs`, the prototype itself reaches 1.77×–1.85×, so the router is at the design's limit there. The gate is unchanged.

## Risks

| Risk | Mitigation |
|---|---|
| The router and reference share a ranking bug | Reference imports nothing from `src/`; hand-written priority tests |
| Wrong ranking passes every bench corpus | `routes-overlap` fixture and a harness self-test (WP-7) |
| The real router is slower than the prototype, because it adds methods and accept rows | G2, with room left below the prototype's ratios |
| The parser subtly changes a regex's meaning | Exact-or-rejected rule, and fuzz against `RegExp.test` |
| State explosion on real route tables | Budget of 262,144 states, then a fast failure naming a route |
| Residual routes keep backtracking and ReDoS exposure | Document it, and report how many routes were demoted |
| Findings don't transfer from M1 to x86-64 | WP-11 re-run before finishing |
| Moving from 13.7% to 95% hit rate changes every historical medley number | G1 records a new baseline; do not compare across it |

## Prototype

`prototype/` holds the code behind every number here, with paths made relative. Its medley comparisons need a built `dist/`: the git-ignored one in the main checkout until WP-1, then `npm run build`. It's verbatim apart from those paths and a `READ_PARAMS` switch in `run.mjs`, and keeps the rejected approaches so that the comparisons stay reproducible.

| File | Purpose |
|---|---|
| `rc.mjs` | Compiler and all engine variants (see the port map above) |
| `cand.mjs` | Builds each candidate by name |
| `verify.mjs` | Differential check on route and params |
| `run.mjs` | One-candidate timing; set `READ_PARAMS=1` to read params |
| `stress.mjs` | Near-miss 404s, query strings, long params |
| `scale.mjs` | Large route tables; `NOMIN=1` skips minimization and reports state coverage |
| `explode.mjs` | Deliberate state explosion |
| `status.mjs` | V8 tier check; run with `--allow-natives-syntax` |
| `prims.mjs` | String primitive microbenchmarks |
| `hitrate.mjs` | Router hit rates on the corpus |
| `shim-common.cjs`, `shim-dfa.cjs` | Plug the prototype into `bench.mjs` via `--router` |

`tail-eager` and `tail-lazy` are the final design, and `medley-fair` is the honest baseline. `tail-eager` builds params during `find`, and `tail-lazy` defers them.

Run from the repo root:

```bash
node prototype/verify.mjs tail-eager tail-lazy
node prototype/run.mjs tail-lazy fresh 5
node prototype/stress.mjs tail-eager token200
node prototype/scale.mjs rest 100 300 1000 3000
```

To run on the held-out routes, prefix a command with:

```bash
BENCH_ROUTES_MODULE="$PWD/bench/routes-specific.mjs" BENCH_PRECOMPUTED_URLS_MODULE="$PWD/bench/routes-specific.urls.mjs"
```

## Progress log

Record every package and gate here.

| Date | Step | Commit | Router ops/s | medley ops/s | Ratio | Hit rate | Notes |
|---|---|---|---:|---:|---:|---:|---|
| 2026-10-30 | WP-0 | 0cf2fa6 | | | | | Agent worktrees start from `main`, so agents fast-forward first |
| 2026-10-30 | WP-1 | 162eede | | | | | 40 reference tests; 18 injected bugs caught; rulings D10 and D11 added after review |
| 2026-10-30 | WP-3 to WP-8 | a1de2ab | | | | 94.95% | 290 tests pass, 1 `todo`; 0 mismatches on 2.7M lookups across three route sets |
| 2026-10-30 | G1 | 39a5399 | 19.37M unread, 12.78M read (prototype) | 6.44M | 3.0×, 2.0× | 94.95% | Hit rate passes. Timing provisional: load 7–14 from other apps |
| 2026-10-30 | WP-9 | e70d2a9 | | | | | 304 tests; regex routes compile; residual routes interleave. 300 overlapping routes compile in 0.7s, 1000 in 28s |
| 2026-10-30 | WP-10 | | | | | | Not built: Hopcroft removed its premise. Budget raised to 262,144 states |
| 2026-10-30 | G2 | a1de2ab | 19.28M unread, 12.60M read (generic); 19.91M, 13.17M (specific) | 6.51M, 6.27M; 6.45M, 6.25M | 2.96×, 2.01×; 3.09×, 2.11× | 94.95%, 94.99% | Passes provisionally, in fixed rotation at load 5–60. Within -4.9% to +1.5% of prototype. Re-measure at G4 |
| 2026-10-30 | WP-11 | 3600bd0 | | | | | Inexact-only confirmation and `byteLength` (token200 0.94× to 1.76×); shared extractors (3000 routes 1.31× to 1.46×); no chains past 1,500 states; CSP fallback; wildcard tails (418ns to 53ns). x86-64 not run |
| 2026-10-30 | G4 | 3600bd0 | 20.52M unread, 13.84M read | 6.90M, 6.76M | 2.97×, 2.05× | 94.95% | See [Acceptance criteria](#acceptance-criteria). Two narrow misses, one item open |
| 2026-10-30 | WP-12 | | | | | | Docs done. Deleting `prototype/` and this plan held back for the open items |
| 2026-10-31 | Baseline swap | | 20.53M unread, 14.15M read | 6.93M, 6.75M | 2.96×, 2.10× | 94.95% | Against `@medley/router`, generic routes. Long params 1.78×, 3000 routes 1.71× |
