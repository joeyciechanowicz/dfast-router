# Hono's router benchmarks

A port of [honojs/hono `benchmarks/routers`](https://github.com/honojs/hono/tree/main/benchmarks/routers), with dfast-router added. The routes, the URLs and each router's adapter are Hono's, turned from TypeScript into plain `.mjs`. Hono's routers come from the `hono` package in place of its source tree.

```
npm run bench:hono                          # Hono's bench.mts, as Hono runs it
npm run bench:hono -- --strict              # the same routers and URLs, measured properly (below)
npm run bench:hono -- --strict --time 3000  # ms per URL per router; the default is 1000
npm run bench:hono -- --strict --runs 3     # each router 3 times, interleaved; reports the median
npm run bench:hono -- --strict --only rou3  # one router, in this process
npm run bench:hono:init                     # Hono's bench-includes-init.mts: build, then one lookup
```

Both scripts build dfast-router first, since the adapter loads `dist/`. `--strict --json` prints the results as JSON.

## The default run is Hono's

It runs exactly as Hono's suite does, so its numbers line up with Hono's. It adds two things:

- **dfast-router, twice.** `dfast-router` reads `params`, like a handler would. dfast-router builds params on first read and every other router here builds them eagerly, so leaving them unread would flatter it. `dfast-router (params unread)` shows what the lazy params save.
- **A check of each match.** Before timing, `check.mjs` looks up each URL once per router, and compares the handler and the param values with what the route should give. Wrong matches print as a warning, and the run goes on.

The check finds two broken adapters in Hono's suite:

- **rou3 matches nothing.** rou3 takes `(router, method, path)`, and the adapter passes the path first, so each route is registered under its path as a method. rou3's numbers there time a miss.
- **trek-router has no handlers.** The adapter registers `handler()`, which is `undefined`, so a match can't be told from a miss, and trek skips building params.

## `--strict`

The default run doesn't measure lookups well. `--strict` keeps the routers and URLs, and changes how they're timed:

| Problem in the default run | What `--strict` does |
|---|---|
| Each bench body is `async`. mitata sees the promise it returns and awaits one every iteration, which costs about 100ns, more than most lookups here. | Bench bodies are synchronous. |
| Most adapters throw the router's result away. Once a lookup is inlined, V8 can skip building a result nobody reads. | Every result goes to mitata's `do_not_optimize`. |
| Every lookup gets the same string literal, which the engine has interned. A real path is a new string each request. | Each lookup takes the next of 64 fresh, non-interned copies of its URL. That also stops V8 treating the input as a loop constant. |
| All 14 routers share one process and one bench closure, so they share type feedback, and the JIT state a router sees depends on the routers before it. One URL measured 18ns in one run and 113ns in another. | One process per router, as AGENTS.md asks of the main bench. |
| Time per bench is mitata's default, about 640ms, with no way to change it. | `--time <ms>` per URL. Each process runs with `--expose-gc`, so mitata collects garbage after warmup, and a router's own garbage still counts against it. |
| The rou3 and trek-router adapters are broken (above). | Both are fixed, and a wrong match fails the run. |

On a 4-core VM, one URL still varied by up to 40% between runs, and "all together" by 10–25%. Use `--runs 3` or more before calling a close result.

mitata's computed params (`yield { [0]() { … }, bench(p) { … } }`) would also give each lookup a fresh input, but they cost about 15ns a lookup, against 3ns for the pool. That's the same problem as the async wrapper, only smaller.

## Caveats

These are Hono's, and both modes keep them. Express also runs the handler. `@medley/router` and `radix3` don't match on method, and radix3 returns no handler to check. koa-router's `match()` finds layers without building params, so its params aren't checked. Hono's `*` captures nothing, so its wildcard has no param to check.
