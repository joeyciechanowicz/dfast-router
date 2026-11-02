// Hono's suite never checks what a router found, so a broken adapter just looks fast. This looks
// up each bench URL once per router, untimed, and lists the routers that got it wrong.
import { benchRoutes, handler } from "./tool.mjs";

// Express gives a wildcard as an array, and koa-tree-router keeps its leading slash.
const values = (params) =>
  Object.values(params).map((value) => [value].flat().join("/").replace(/^\//, ""));

function problem(router, route) {
  const found = router.inspect(route);
  if (!found) return "no match";
  if (found.handler !== undefined && found.handler !== handler) return "wrong handler";
  if (found.params === null) return null; // This router doesn't build params at lookup.
  const got = values(found.params ?? {}); // rou3 and Express leave a static route's params unset.
  const expected = route.path.startsWith("/static/") && router.capturesWildcard === false ? [] : route.params;
  if (got.join("\0") !== expected.join("\0")) {
    return `params ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`;
  }
  return null;
}

/** Returns one line per wrong lookup, like `rou3: GET /user: no match`. */
export function checkRouters(routers) {
  const failures = [];
  for (const router of routers) {
    for (const route of benchRoutes) {
      const reason = problem(router, route);
      if (reason) failures.push(`${router.name}: ${route.method} ${route.path}: ${reason}`);
    }
  }
  return failures;
}
