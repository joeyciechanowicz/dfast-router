// Port of honojs/hono benchmarks/routers/src/bench-includes-init.mts, with dfast-router added.
// Each iteration builds the router from scratch and does one lookup. dfast-router compiles its
// whole table to a DFA up front, so this is the cost that design pays.
import MedleyRouter from "@medley/router";
import findMyWay from "find-my-way";
import { LinearRouter } from "hono/router/linear-router";
import { RegExpRouter, PreparedRegExpRouter, buildInitParams } from "hono/router/reg-exp-router";
import { TrieRouter } from "hono/router/trie-router";
import KoaRouter from "koa-tree-router";
import { run, bench, group } from "mitata";
import TrekRouter from "trek-router";
import { buildDfastRouter } from "./dfast-router.mjs";
import { routes, benchRoutes } from "./tool.mjs";

const preparedParams = buildInitParams({
  paths: routes.map((r) => r.path),
});

for (const benchRoute of benchRoutes) {
  group(`${benchRoute.method} ${benchRoute.path}`, () => {
    bench("dfast-router", () => {
      const router = buildDfastRouter();
      router.find(benchRoute.method, benchRoute.path).params;
    });
    bench("RegExpRouter", () => {
      const router = new RegExpRouter();
      for (const route of routes) {
        router.add(route.method, route.path, () => {});
      }
      router.match(benchRoute.method, benchRoute.path);
    });
    bench("PreparedRegExpRouter", () => {
      const router = new PreparedRegExpRouter(preparedParams[0], preparedParams[1]);
      for (const route of routes) {
        router.add(route.method, route.path, () => {});
      }
      router.match(benchRoute.method, benchRoute.path);
    });
    bench("TrieRouter", () => {
      const router = new TrieRouter();
      for (const route of routes) {
        router.add(route.method, route.path, () => {});
      }
      router.match(benchRoute.method, benchRoute.path);
    });
    bench("LinearRouter", () => {
      const router = new LinearRouter();
      for (const route of routes) {
        router.add(route.method, route.path, () => {});
      }
      router.match(benchRoute.method, benchRoute.path);
    });
    bench("MedleyRouter", () => {
      const router = new MedleyRouter();
      for (const route of routes) {
        const store = router.register(route.path);
        store[route.method] = () => {};
      }
      const match = router.find(benchRoute.path);
      match.store[benchRoute.method]; // get handler
    });
    bench("FindMyWay", () => {
      const router = findMyWay();
      for (const route of routes) {
        router.on(route.method, route.path, () => {});
      }
      router.find(benchRoute.method, benchRoute.path);
    });
    bench("KoaTreeRouter", () => {
      const router = new KoaRouter();
      for (const route of routes) {
        router.on(route.method, route.path.replace("*", "*foo"), () => {});
      }
      router.find(benchRoute.method, benchRoute.path);
    });
    bench("TrekRouter", () => {
      const router = new TrekRouter();
      for (const route of routes) {
        router.add(route.method, route.path, () => {});
      }
      router.find(benchRoute.method, benchRoute.path);
    });
  });
}
await run();
