# Plan: table-driven DFA router

Replace the deleted router in `src/` with one DFA compiled from the whole route table, run from a typed-array table. The work is split into 13 work packages for a lead and up to 6 parallel agents.

**Status:** planned. Nothing is implemented in `src/`. The working prototype is in `prototype/` (see [Prototype](#prototype)).

**How to use this document**

- **Lead:** the session coordinating the work. Follow [Execution](#execution) from WP-0, and keep the [progress log](#progress-log) up to date.
- **Agent:** read the sections named in the [prompt template](#agent-prompt-template), then do only your work package.

## Goal

Be measurably faster than `medley-router-local` while doing the same routing work.

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
| D5 | Static-route results are shared and frozen | No allocation on static hits. Handlers must not mutate `params`. |
| D6 | Regex routes expose named groups (`(?<id>\d+)`) as params | Old regex routes returned empty params. Numbered groups stay unexposed. |
| D7 | No URL cache | The old GET cache only looks good because bench URLs are internalized literals with cached hashes. |
| D8 | `createMedleyRouter` stays exported, marked as a bench baseline | The bench needs it. |
| D9 | A route that expands to more than 256 variants throws at registration | Optional segments double the variants. A clear error is simpler than a second code path. |

## Behaviour contract

`test/router.test.ts` and `test/automaton-router.test.ts` already define most of this. The prototype covers only the first three rows, so the rest is new work.

| Behaviour | Source | Prototype |
|---|---|---|
| Static, `:param`, `:param(regex)`, `:param?`, `(a\|b)` segments | tests, route sets | Yes |
| `.` and negated classes can cross `/`, as in `:categories(.+)` | `routes-specific` | Yes |
| `?` ends the path | D3 | Yes |
| `/files/*` gives `{ '*': rest }`; `/assets/:path*` gives `{ path: rest }` | tests | **No** |
| `/files/:path*` also matches `/files`, with `{ path: '' }` | tests | **No** |
| A wildcard ends the pattern: `/a/:first*/b/:second*` captures only `first` | tests | **No** |
| `#int`, `#alpha`, `#slug`, `#locale`, `#uuid`, also with `?`; unknown alias throws `Unknown validator alias` | tests | **No** |
| Priority rules below (prototype uses registration order, which **contradicts** the tests) | tests | **No** |
| Method arrays, case and whitespace normalization, `*`, unknown methods | tests | **No** |
| Raw `RegExp` routes, deduplicated by source and flags across methods | tests | **No** |
| Leading `/` added to paths; `''` becomes `/` | tests | **No** |
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

The numbers below 100 come from `scoreEdge` in `git show c53789e:src/automaton-router.ts`. Static ranks above them all. Within a regex tier, registration order decides.

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
  index.ts             createRouter, Router, types, createMedleyRouter
  types.ts             public types
  router.ts            on(), find(), compile(), method table
  matcher.ts           hot loop and slow continuation (the only perf-critical file)
  match.ts             Match class, prebuilt static results
  medley-router.ts     restored bench baseline
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

### Param extraction

Use the cheapest method that is correct for each variant, in this order:

1. Fixed offsets, when everything before the param has a known width
2. Anchoring from the end of the path, when everything after has a known width
3. `indexOf('/')`, when the param cannot contain `/`
4. `RegExp.exec` for the variant, for anything else: `.+` before another variable segment, for example

The prototype throws on case 4.

## Shared contracts

Parallel agents code against these. WP-1 writes them into `src/compiler/types.ts`, `src/types.ts`, and stub modules. **After WP-1 they are frozen.** See [Changing a contract](#changing-a-contract).

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

/** Membership per symbol, 0 or 1. Never contains QMARK, because `?` ends the path. */
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

/** Called when the DFA gives no direct result. `row` is -1 if no state accepted. */
export type Miss = (path: string, method: number, end: number, row: number) => RouteMatch | null;
```

Module signatures:

```ts
// charset.ts: helpers named by WP-1 from the prototype's mkset
// regex-parser.ts
export function parseFragment(source: string): Parsed;   // body of :name(...), matched whole
export function parseRegExp(regex: RegExp): Parsed;      // whole path; unanchored sides add [^?]*
// pattern.ts
export function parsePattern(path: string): Variant[];   // throws on unknown alias, or over 256 variants
export function variantAst(v: Variant, parse: ParseFragment): Parsed;
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
export function createRouter(): Router;
```

## Execution

```
WP-0 → WP-1 → { WP-2  WP-3  WP-4  WP-5  WP-6  WP-7 } → G1 → WP-8 → G2 → { WP-9  WP-10 } → G3 → WP-11 → G4 → WP-12
```

| Wave | Packages | Who | Mode | Timing allowed? |
|---|---|---|---|---|
| 0 | WP-0 Preflight | Lead | Serial | No |
| 1 | WP-1 Foundation | 1 agent | Serial | No |
| 2 | WP-2 to WP-7 | 6 agents | **Parallel** | **No** |
| | **G1** | Lead | Machine idle | Yes |
| 3 | WP-8 Integration | 1 agent | Serial | Yes |
| | **G2** | Lead | Machine idle | Yes |
| 4 | WP-9, WP-10 | 2 agents | **Parallel** | **No** |
| | **G3** | Lead | Machine idle | Yes |
| 5 | WP-11 Tuning | 1 agent | Exclusive | Yes |
| | **G4** | Lead | Machine idle | Yes |
| 6 | WP-12 Docs | 1 agent | Serial | No |

### Why it's organized this way

These limits were measured on this repo and machine (Apple M1 Pro, 6 performance and 2 efficiency cores, 16GB RAM).

**Timing happens only at gates.** The same code, timed with other work running:

| Background load | Median | Distortion |
|---|---:|---:|
| Idle | 47.3ns | none |
| 3 busy processes | 49.3ns | +4% |
| 6 busy processes | 52.9ns | +12% |
| 8 busy processes | 66.9ns | +41% |

Idle runs alone span 47–51ns, and the gates have margins of about 5%, so a number taken during a parallel wave means nothing.

**At most 6 agents run at once.** That matches the performance cores. A process that loads the corpus peaks at about 800MB, so memory isn't the limit.

**A fresh worktree is not usable as it stands.** The Agent tool creates it from `main`, so the plan and prototype are missing until it fast-forwards to `dfa-router`. `node_modules`, `dist/`, and `bench/routes-specific*` are git-ignored, and uncommitted files aren't there either. `scripts/setup-worktree.sh` fixes the ignored files. Without WP-0's `.gitignore` change, a symlinked `node_modules` shows as untracked, and `git add -A` would commit it.

**`npm test` is off limits during parallel waves.** It matches everything under `test/`, including `test/router-consistency.test.mjs` and its 3M-URL corpus. Agents run only their own test files.

### Rules for every agent

1. Work only in your worktree. Start with `git merge --ff-only dfa-router`, then `bash scripts/setup-worktree.sh`.
2. Edit only the files your package owns. New test files in your owned paths are fine.
3. Do not edit `src/compiler/types.ts`, `src/types.ts`, or `prototype/`, unless your package says so.
4. Do not edit a stub another package owns, even to make something compile. If you need it, follow [Changing a contract](#changing-a-contract).
5. Do not run timing benchmarks, and do not report speed, during a parallel wave. Compile-time checks with a wide margin are allowed where a package says so.
6. Do not run `npm test` during a parallel wave. Run the commands in your package.
7. Never weaken, skip, or delete a test or gate to make it pass. Report the failure instead.
8. Commit on your branch only. The lead merges.
9. Follow `AGENTS.md` for any performance change. WP-2 to WP-7 are new code, so their speed is judged at G1 and G2, not per commit.

### Agent prompt template

Start each agent with `subagent_type: "general-purpose"` and `isolation: "worktree"`. These worktrees start from `main`, not the current branch, so the prompt's first step fast-forwards to `dfa-router`. Agents start with no context, so the prompt has to carry everything:

```
You are implementing {WP} of the balancing-router DFA plan, in your own git worktree.
Other agents may be working at the same time on other files.

1. Run `git merge --ff-only dfa-router`, then `bash scripts/setup-worktree.sh`.
   Stop if either fails.
2. Read AGENTS.md, then these PLAN.md sections: Decisions, Behaviour contract,
   Architecture, Shared contracts, Rules for every agent, and {WP}.
3. Do {WP}. Port from prototype/ where the plan says to. Its behaviour is the
   starting point, except where the Behaviour contract says otherwise.
4. Run every command under "Done when", and fix what fails.
5. Commit on your branch.

End with this report, and paste real command results. Do not summarize from memory:

WP:
Status: done | blocked
Commits:
Files changed:
Commands run, with pass/fail counts:
Contract changes needed: none | <what and why>
Deviations from the plan: none | <what and why>
Open issues:
```

Send follow-up fixes to the same agent with `SendMessage`, because a new agent would start cold.

### Merging

The lead merges each package into `dfa-router` after checking it independently. Do not rely on an agent's report alone.

```bash
git diff --name-only dfa-router...<branch>   # every file must be owned by that package
git merge --no-ff <branch>
npm run build
# then re-run that package's "Done when" commands
```

Ownership is disjoint within each wave, so merges in a wave should not conflict, and any order works. A conflict means a package left its files, so send it back. Run `/code-review high` before merging WP-3, WP-4, WP-6, and WP-8, where subtle errors would be hardest to find later.

### Changing a contract

Contract problems are expected, but silent drift between agents is what makes parallel work fail.

1. The agent stops and reports the change it needs, under `Contract changes needed`. It does not work around it.
2. The lead edits the contract in `dfa-router`, and updates this document.
3. The lead tells every running agent affected, using `SendMessage`, to merge the change.

### Running a gate

1. Confirm that no agents are running, and that the 1-minute load in `uptime` is under 2.
2. Check out `dfa-router` in the main checkout, then run `npm run build`.
3. Run the gate. Use `npm run bench:compare`, or `bench/bench.mjs` with best of 3 seeds at 3s each, so that numbers stay comparable with the tables here.
4. Add the numbers to the [progress log](#progress-log).

If a gate fails, stop the plan there. Profile, fix, and re-run. Do not start the next wave, and do not lower the gate.

## Work packages

### WP-0: Preflight

**Who:** lead. **Depends on:** the user's go-ahead to commit. **Owns:** `.gitignore`, `scripts/setup-worktree.sh`.

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

**Who:** 1 agent. **Depends on:** WP-0. **Owns:** `src/index.ts`, `src/types.ts`, `src/medley-router.ts`, `src/router.ts`, `src/matcher.ts`, `src/match.ts`, `src/compiler/*`, `bench/reference.mjs`, `test/reference.test.mjs`.

Everything in Wave 2 fans out from this, so keep it small and exact.

1. Restore the baseline: `git show c53789e:src/medley-router.ts > src/medley-router.ts`. Its compiled output is byte-identical to the current `dist/medley-router.js`.
2. Write `src/types.ts` and `src/compiler/types.ts` exactly as in [Shared contracts](#shared-contracts).
3. Add a stub for every module signature, each throwing `not implemented: <name>`, so that every worktree builds from the start.
4. Add `src/index.ts`, exporting `createRouter`, `Router`, the public types, and `createMedleyRouter`.
5. Add `bench/reference.mjs`, based on the regex scan in `prototype/verify.mjs`:
   - Export `createReference(routes)`, returning `(url) => { route, params } | null`.
   - Cut the URL at `?`, and apply the priority rules for rank and tier.
   - It must not import anything from `src/`. An independent reference is what stops it sharing a bug with the router.
6. Add `test/reference.test.mjs`, with hand-written priority cases.

**Done when:**

```bash
npm run build
npx tsx --test test/reference.test.mjs
```

`bench.mjs` will fail until WP-2 merges, because its validation calls the stubbed `createRouter`. That's expected. **The lead reviews both type files line by line against this plan before starting Wave 2.**

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
10. In `package.json`, remove `bench:gate` and `bench:matrix`, whose files no longer exist. Change `test:consistency` to `FULL_CORPUS=1 node test/router-consistency.test.mjs`.
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

**Depends on:** WP-1. **Owns:** `src/compiler/charset.ts`, `src/compiler/regex-parser.ts`, `test/compiler/regex-parser.test.ts`, `test/compiler/regex-fuzz.test.ts`, `test/helpers/ast-match.ts`.

The rule for this package: **preserve a regex's exact language, or return `{ ok: false }`. Never approximate.** A wrong parse silently changes which URLs match.

1. Port `mkset` and `parseRegex` from `prototype/rc.mjs`. Only `?` is masked out of sets, because real regexes can cross `/`.
2. Support `^`, `$`, `\d \D \w \W \s \S`, `\xHH`, `\uHHHH`, classes with escapes, lazy quantifiers (same language as greedy), named and non-capturing groups, and the `i` and `s` flags.
3. In `parseRegExp`, treat a missing `^` or `$` as `[^?]*` on that side.
4. Return `{ ok: false }` for backreferences, lookaround, `\b`, `\p{...}`, the `m` flag, `^` or `$` anywhere except the ends, and any class that includes only part of the range above ASCII.
5. Add `test/helpers/ast-match.ts`: a small AST matcher tracking sets of positions, independent of the NFA and DFA.

**Done when:**

```bash
npm run build
npx tsx --test test/compiler/regex-parser.test.ts test/compiler/regex-fuzz.test.ts
```

The fuzz test generates random regexes and strings, and requires the AST matcher to equal `RegExp.test` on at least 100k pairs, with a fixed seed printed on failure.

### WP-4: NFA and DFA

**Depends on:** WP-1. **Owns:** `src/compiler/nfa.ts`, `src/compiler/dfa.ts`, `test/compiler/dfa.test.ts`.

1. Port `NFA`, `frag`, and `compile` from `prototype/rc.mjs`.
2. Keep **full** accept sets per state, and include them in the minimization key. The prototype keeps only the lowest index, which can't support per-method results.
3. Replace Moore minimization with Hopcroft. Moore took about 94s of the 99s on 300 overlapping routes.
4. Replace the string keys built with `join` in subset construction.
5. Honour `maxStates`, returning `state-budget` promptly.
6. Test with a generator that produces each random AST alongside an equivalent regex source. That gives `RegExp` as an oracle without depending on WP-3.

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

These limits are wide enough to hold during a parallel wave.

### WP-5: Patterns and extraction

**Depends on:** WP-1. **Owns:** `src/compiler/pattern.ts`, `src/compiler/extract.ts`, `test/compiler/pattern.test.ts`, `test/compiler/extract.test.ts`.

1. Port `parseConcrete`, `expand`, `widthOf`, `mayCross`, and `extractor`.
2. Implement in `pattern.ts`:
   - `(a|b)` segments and `:name?` optionals
   - Aliases, including `#int?`, throwing `Unknown validator alias`
   - Wildcards, which end the pattern and add an empty-match variant through `defaults`
   - Rank keys and `compareRank`
   - The 256-variant limit (D9)
3. Implement the four extraction cases in `extract.ts`, including the `RegExp.exec` case the prototype throws on.
4. Keep the fast extractors as `new Function`, as in the prototype. Return `null` for variants with no params and no defaults.

Tests may import `parseRegex` from `prototype/rc.mjs` as the `ParseFragment`, because WP-3 isn't merged yet and the AST shape is the same. WP-8 replaces those imports.

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

In `test/helpers/dfa-fixture.ts`, adapt the prototype's `compile()` output to the `Dfa` contract: `T` to `trans`, `cls` to `classOf`, and `A` to single-entry `accepts`. WP-4 isn't merged yet, and this lets the matcher run on real routes now. WP-8 replaces it.

**Done when:**

```bash
npm run build
npx tsx --test test/compiler/matcher.test.ts
```

Tests must cover both bench route sets with zero mismatches against `bench/reference.mjs`, plus long params, query strings, empty paths, and non-ASCII characters. Both `find` paths must be checked: the hot loop and `slow`.

### WP-7: Contract and differential tests

**Depends on:** WP-1. **Owns:** `test/router.test.ts`, `test/automaton-router.test.ts`, `test/router-consistency.test.mjs`, `test/fixtures/*`.

Write these from the [Behaviour contract](#behaviour-contract), not from any implementation. They're an independent check on the router.

1. Move `test/automaton-router.test.ts` into `test/router.test.ts` against `createRouter`, and delete the old file.
2. Add tests for what's new: D2, D3, D5, recompiling after `on()`, non-ASCII paths, `%` left undecoded, and the priority rules across all four tiers.
3. Mark the D6 named-groups test `{ todo: 'WP-9' }`.
4. Rewrite `test/router-consistency.test.mjs` as the differential test. Compare route and params against `bench/reference.mjs`, keeping the mutations from `prototype/verify.mjs`.
   - Run a 50k-URL sample by default, and everything when `FULL_CORPUS=1`.
   - Include `routes-specific` when present, and print a visible skip message when not. This held-out set caught a real semantic bug in the prototype.
   - Support `DIFF_TARGET=prototype`, which builds the router as `cand.mjs` builds `tail-lazy`.
5. Add `test/fixtures/routes-overlap.mjs`: a route set where URLs match several routes, covering static against param, param scores, wildcards, and same-language routes with different names. Without this, the differential test can't detect a ranking bug.
6. Add a harness self-test: run the differential against a deliberately broken router, with one wrong param and one swapped priority, and require it to fail.

**Done when:**

```bash
npm run build
DIFF_TARGET=prototype FULL_CORPUS=1 node test/router-consistency.test.mjs   # bench route sets: 0 mismatches
```

Registration order and required ranking never disagree on the two bench route sets, so the prototype should pass there with no false alarms. It's expected to fail on `routes-overlap`, which is also proof that the fixture works. `test/router.test.ts` stays red until WP-8.

### G1: Foundations verified

**Lead, machine idle, all of Wave 2 merged.**

- [ ] Every Wave 2 "Done when" command passes on `dfa-router`.
- [ ] `npm run build` passes with no stubs left except `src/router.ts`.
- [ ] medley reports about 7M ops/s at about 95% hit rate on generic routes.
- [ ] Record medley and the prototype (through `prototype/shim-dfa.cjs`) in the progress log, with and without `--read-params`. Earlier numbers don't carry over, because this bench uses fresh strings.

### WP-8: Router integration

**Who:** 1 agent, with no others running. **Depends on:** G1. **Owns:** `src/router.ts`, `src/index.ts`, and the imports in the WP-5 and WP-6 tests.

1. Implement `on`: normalize methods and paths, expand patterns with `parsePattern`, and merge variants by `key` across methods.
2. Implement `compile`: sort variants with `compareRank`, build ASTs, call `buildDfa`, build per-method rows, then `buildTable` and `createMatcher`. Use a `maxStates` of 32,767 for now.
3. Implement `find`: the `GET` fast path, then the normalizing `Map`. Handle empty paths and a missing leading `/` in `miss`, so the hot loop pays nothing.
4. Keep every `RegExp` route as a residual route for now: test them in `miss` with `RegExp.test`, in tier and registration order, and deduplicate by source and flags. WP-9 compiles them into the DFA.
5. Recompile on the next `find` after `on()`.
6. Replace the prototype imports in the WP-5 and WP-6 tests with the real modules.
7. If G2's prototype comparison misses, try `new Function` for the hot loop, as the prototype does. Keep it only if it wins by more than 3%.

**Done when:**

```bash
npm test
FULL_CORPUS=1 npm run test:consistency
```

All tests pass except the `todo`, and the differential shows 0 mismatches on all three route sets, including `routes-overlap`.

### G2: Parity with the prototype

**Lead, machine idle.** Stop here if this fails: every later package builds on it.

- [ ] `balancing-router` is within 5% of the prototype, measured in the same session.
- [ ] At least 1.9× medley with `--read-params`, and at least 2.5× without, on both route sets. These sit below the prototype's 2.0× and 2.9× because methods add real work.
- [ ] `find` reaches TurboFan (see `prototype/status.mjs`).

### WP-9: Regex routes and budget policy

**Depends on:** G2. **Owns:** `src/router.ts`, `src/index.ts`.

1. Compile `RegExp` routes into the DFA through `parseRegExp` when it returns `ok`. Keep the others as residual routes.
2. Keep the priority order: compiled and residual regex routes merge by registration order within a tier. Where a residual route could outrank a compiled one, set that `rows` entry to -1, so that `miss` decides.
3. Filter residual routes with the literal prefix (`extractRegexLiteralPrefix` in `git show c53789e:src/index.ts`).
4. Clone regexes without `g` and `y`, because they make `test` stateful.
5. Expose named groups as params through `exec` on first read (D6), and remove the `todo` from that test.
6. Compile each route alone first, and demote any route over a per-route state limit to residual. Start at 4,096 states, which handles the crafted `[ab]*a[ab]{14}` case.
7. If the whole table exceeds `maxStates`, throw an error naming the routes responsible. This is the shipped behaviour unless WP-10 is a go.
8. Add a way to see how many routes were demoted, because residual routes keep backtracking and ReDoS exposure.

**Done when:** `npm test` and `FULL_CORPUS=1 npm run test:consistency` pass with no `todo` left, and a test shows that a pathological route set fails or demotes rather than hanging.

### WP-10: On-demand states spike

**Depends on:** G2. **Owns:** `src/compiler/lazy-dfa.ts` (new), and may change `src/matcher.ts` and `src/compiler/table.ts`. **Merge only on a go.**

Build DFA states on first use, as RE2 does. Unbuilt transitions hold a sentinel above `stop`, so the hot loop is unchanged. Traffic touched only 6.6% of states in the 300-route overlap case, which is why this looks promising, but it's unbuilt and unproven.

**Done when** the agent reports a working spike, plus a test of URLs crafted to force new states, and memory bounded by a fixed cap with a flush when full.

The lead decides go or no-go at G3. Go only if all of these hold:

- Lookups in the overlap case are within 2× of the eager table.
- Memory stays under the cap, including under the adversarial test. State building happens at request time, so it adds an attack surface.
- Routers that don't need it see no slowdown.

### G3: Feature complete

**Lead, machine idle, WP-9 merged.**

- [ ] All contract tests pass, and regex fuzz shows 0 mismatches.
- [ ] A router with no residual routes shows no slowdown against G2.
- [ ] The crafted route and the 1000-route overlap case neither hang nor crash.
- [ ] WP-10 go or no-go is recorded in the progress log, with its numbers.

### WP-11: Tuning

**Who:** 1 agent, machine exclusive. **Depends on:** G3. **Owns:** anything in `src/`.

Follow the `AGENTS.md` workflow exactly: profile first, make one change, run `npm run bench:compare`, keep only wins, and commit each one separately.

1. **Scale.** The lead narrows from 2.1× at 100 routes (85ns vs 181ns) to 1.4× at 3000 (190ns vs 269ns). Scan chains grow the table from 905KB to 1655KB, and thousands of rarely-run extractors may never warm up. Neither has been shown to be the cause.
2. **Scan threshold.** `scanAfter = 8` came from a small, noisy sweep. Try capping chain states on large tables.
3. **Wildcards.** Add a fast scan for `[^?]*` states.
4. **CSP.** Fall back to data-driven extraction when `new Function` throws.
5. **x86-64.** Every number so far is from one Apple M1 Pro. Re-run on x86-64 Linux, because the mispredict results that drove this design may differ there. This may need a person or CI to provide the machine. If the ranking of table against generated code changes, stop and report.

**Done when** every item has a measured result in the progress log, including items that produced no win.

### G4: Acceptance

**Lead, machine idle.** Every row of [Acceptance criteria](#acceptance-criteria) passes, on both route sets.

### WP-12: Docs and cleanup

**Depends on:** G4. **Owns:** `README.md`, `how-it-works.md`, `AGENTS.md`, `package.json`, `profile-medley-router.txt`, `prototype/`, `PLAN.md`.

1. Rewrite `README.md` and `how-it-works.md` for the new design, with D2 and D3 called out as behaviour changes.
2. Update `AGENTS.md`: replace the `src/index.ts` and rebalance guidance, and add the hit-rate and one-process-per-router rules.
3. Update the `package.json` description, and delete `profile-medley-router.txt`.
4. Check that nothing imports `prototype/`, then delete it.
5. Delete this plan last, once the progress log's final numbers are in `how-it-works.md`.

**Done when:** `npm run build`, `npm test`, and `FULL_CORPUS=1 npm run test:consistency` all pass with `prototype/` gone.

## Acceptance criteria

All of these must hold on both route sets, measured against medley given matchable routes:

| Check | Requirement | Prototype today |
|---|---:|---:|
| `npm test` | All pass | Not applicable |
| Differential, including `routes-overlap` | 0 mismatches on route and params | 0, bench route sets only |
| Regex fuzz | 0 mismatches | Not built |
| `bench.mjs --read-params` | ≥ 1.9× | 2.0× |
| `bench.mjs`, params unread | ≥ 2.5× | 2.9× |
| Near-miss 404s | ≥ 1.8× | 2.6× |
| Query strings | ≥ 1.8× | 1.9× |
| UUID and 200-char token params | ≥ 1.8× | 1.9× |
| 3000 REST routes, uniform traffic | ≥ 1.4×, compile under 1s | 1.4×, 0.54s |
| Pathological route tables | No hang; clear failure or demotion | Hangs |
| Hit rate in every benchmark | Within 0.1 points of the reference | Not enforced |
| Node 20, 22, 24, 25 | All pass | Numbers stable |

## Risks

| Risk | Mitigation |
|---|---|
| Timing numbers are corrupted by parallel work | Timing only at gates, on an idle machine |
| A contract is wrong, and parallel work is wasted | Lead reviews WP-1 line by line; [change process](#changing-a-contract) |
| Packages pass alone but fail together | WP-5 and WP-6 test against real prototype data; WP-8 runs alone |
| The router and reference share a ranking bug | Reference imports nothing from `src/`; hand-written priority tests |
| Wrong ranking passes every bench corpus | `routes-overlap` fixture and a harness self-test (WP-7) |
| The real router is slower than the prototype, because it adds methods and accept rows | G2, with room left below the prototype's ratios |
| The parser subtly changes a regex's meaning | Exact-or-rejected rule, and fuzz against `RegExp.test` |
| State explosion on real route tables | WP-9 budget, with a clear failure unless WP-10 is a go |
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
| `shim-common.cjs`, `shim-dfa.cjs`, `shim-medley-fair.cjs` | Plug routers into `bench.mjs` via `--router` |

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

The lead records every gate and merge here.

| Date | Step | Commit | Router ops/s | medley ops/s | Ratio | Hit rate | Notes |
|---|---|---|---:|---:|---:|---:|---|
