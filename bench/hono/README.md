# Hono's router benchmarks

A port of [honojs/hono `benchmarks/routers`](https://github.com/honojs/hono/tree/main/benchmarks/routers), with dfast-router added. The routes, the URLs and each router's adapter are Hono's, turned from TypeScript into plain `.mjs`. Hono's routers come from the `hono` package in place of its source tree.

```
npm run bench:hono              # bench.mts: one lookup per iteration, per URL and all together
npm run bench:hono -- --sync    # the same, without the async wrapper (see below)
npm run bench:hono:init         # bench-includes-init.mts: build the router, then one lookup
```

Both scripts build dfast-router first, since the adapter loads `dist/`.

## What differs from Hono's suite

- **dfast-router is added twice.** `dfast-router` reads `params`, like a handler would. dfast-router builds params on first read and every other router here builds them eagerly, so leaving them unread would flatter it. `dfast-router (params unread)` shows what the lazy params save.
- **`--sync`.** Hono's bench bodies are `async`, so mitata awaits a promise on every iteration. That costs more than most of these lookups, around 100ns on Node, and it buries the differences between routers. `--sync` drops only that wrapper. Without it, the run matches Hono's.

Everything else is unchanged, including Hono's caveats: Express also runs the handler, `@medley/router` and `radix3` don't match on method, and nothing checks that a router found the right route.
