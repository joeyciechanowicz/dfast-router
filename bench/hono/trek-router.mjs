import TrekRouter from "trek-router";
import { routes, handler } from "./tool.mjs";

const name = "trek-router";

// Hono's adapter, kept as it is. It registers `handler()`, which is undefined, so a match and a
// miss look the same, and trek skips filling params when it finds no handler.
const router = new TrekRouter();
for (const route of routes) {
  router.add(route.method, route.path, handler());
}

export const trekRouter = {
  name,
  match: (route) => {
    router.find(route.method, route.path);
  },
};
trekRouter.inspect = (route) => inspect(router, route);

// The same router with the handler registered. `--strict` uses this one.
const fixed = new TrekRouter();
for (const route of routes) {
  fixed.add(route.method, route.path, handler);
}

export const trekRouterFixed = {
  name,
  match: (route) => fixed.find(route.method, route.path),
  inspect: (route) => inspect(fixed, route),
};

function inspect(trek, route) {
  const [found, params] = trek.find(route.method, route.path);
  if (!found) return null;
  return { handler: found, params: Object.fromEntries(params.map((p) => [p.name, p.value])) };
}
