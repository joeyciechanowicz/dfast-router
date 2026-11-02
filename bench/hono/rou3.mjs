import { addRoute, createRouter, findRoute } from "rou3";
import { handler, routes } from "./tool.mjs";

const name = "rou3";

// Hono's adapter, kept as it is. rou3 takes (router, method, path), so this registers each route
// under its path as the method, and every lookup misses. `ignoreParams` isn't a rou3 option.
const router = createRouter();

for (const route of routes) {
  addRoute(router, route.path, route.method, handler);
}

export const rou3Router = {
  name,
  match: (route) => {
    findRoute(router, route.path, route.method, {
      ignoreParams: false, // Don't ignore params
    });
  },
};
rou3Router.inspect = (route) => {
  const match = findRoute(router, route.path, route.method);
  return match ? { handler: match.data, params: match.params } : null;
};

// The same router, registered and looked up in the order rou3 takes. `--strict` uses this one.
const fixed = createRouter();

for (const route of routes) {
  addRoute(fixed, route.method, route.path, handler);
}

export const rou3RouterFixed = {
  name,
  match: (route) => findRoute(fixed, route.method, route.path),
  inspect: (route) => {
    const match = findRoute(fixed, route.method, route.path);
    return match ? { handler: match.data, params: match.params } : null;
  },
};
