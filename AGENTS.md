# AGENTS.md

This repo uses an iterative, benchmark- and profiler-driven workflow. Every performance change must be measured, compared against the previous commit, and only kept if it improves the metrics.

## Workflow

1) **Baseline**
   - Ensure a clean worktree.
   - Run `npm run bench:compare` to establish the current baseline.

2) **Profile Before Changing**
   - Use Node V8 profiler to capture hotspots:
     - `node --prof bench/bench.mjs --json`
     - `node --prof-process isolate-*.log > profile.txt`
   - Focus on `src/matcher.ts`, and read its rules in `how-it-works.md` first.

3) **Iterate in Small Steps**
   - Make a single focused change.
   - Run `npm run bench:compare`.
   - Keep only improvements; revert regressions immediately.

4) **Commit Each Win**
   - Each performance improvement is its own commit.
   - Commit message should describe the optimization.

## Benchmark Rules

- Default bench time is 1000ms per task; use `--time` for longer runs.
- Run one router per process (`--only`, or `npm run bench:compare`). Keep the machine quiet: 6 busy processes add 12%, and 8 add 41%.
- Compare a router only at its hit rate. `bench.mjs` fails a run more than 0.1 points under the reference.
- Always look at `rme` (relative margin of error) and samples.
- If `rme` is high, increase time and rerun.
- Bench traffic is generated from full route `count` values in `bench/routes.mjs`.
- URL corpora are prebuilt and shuffled once before timing; timed runs replay the shuffled corpus.
- URL generators must produce at least 2 valid variants per route.

## Bench Commands

- `npm run bench` (default 1000ms)
- `node bench/bench.mjs --time 3000`
- `npm run bench:compare`
- `npm run bench -- --routes specific` (pick a route set; the default is `generic`, and `bench:compare` takes it too)
- `npm run bench:compare -- --time 1000 --runs 1`
- `npm run bench:compare -- --fastest --read-params` (skips the previous commit, and fails unless dfast-router beats every other router; CI runs this on every corpus on each push to `main` and on every pull request)

Scripts in this repo take flags, not environment variables. `bench/flags.mjs` reads them.

## Definition of Done for Perf Changes

- Bench compare shows improvement for dfast-router.
- No functional regressions: `npm test` and `npm run test:consistency` both pass.
- Change committed with a clear message.
