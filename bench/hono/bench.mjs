// Port of honojs/hono benchmarks/routers/src/bench.mts, with dfast-router added.
// Run with `npm run bench:hono` (builds first).
//
// Like Hono's, each bench body is `async`, so mitata awaits a promise per iteration. That costs
// more than most lookups here, and hides the differences between routers. `--sync` drops only
// that wrapper: `npm run bench:hono -- --sync`.
import { run, bench, group, summary } from "mitata";
import { takeSwitch } from "../flags.mjs";
import { dfastRouter, dfastRouterUnread } from "./dfast-router.mjs";
import { expressRouter } from "./express.mjs";
import { findMyWayRouter } from "./find-my-way.mjs";
import { regExpRouter, trieRouter, patternRouter } from "./hono.mjs";
import { koaRouter } from "./koa-router.mjs";
import { koaTreeRouter } from "./koa-tree-router.mjs";
import { medleyRouter } from "./medley-router.mjs";
import { memoiristRouter } from "./memoirist.mjs";
import { radix3Router } from "./radix3.mjs";
import { rou3Router } from "./rou3.mjs";
import { benchRoutes as routes } from "./tool.mjs";
import { trekRouter } from "./trek-router.mjs";

const sync = takeSwitch("--sync");
const body = sync ? (fn) => () => fn() : (fn) => async () => fn();

const routers = [
  dfastRouter,
  dfastRouterUnread,
  regExpRouter,
  trieRouter,
  patternRouter,
  medleyRouter,
  findMyWayRouter,
  koaTreeRouter,
  trekRouter,
  expressRouter,
  koaRouter,
  radix3Router,
  memoiristRouter,
  rou3Router,
];

medleyRouter.match({ method: "GET", path: "/user" });

for (const route of routes) {
  summary(() => {
    group(`${route.name} - ${route.method} ${route.path}`, () => {
      for (const router of routers) {
        bench(router.name, body(() => router.match(route)));
      }
    });
  });
}

group("all together", () => {
  summary(() => {
    for (const router of routers) {
      bench(
        router.name,
        body(() => {
          for (const route of routes) router.match(route);
        }),
      );
    }
  });
});

await run();
