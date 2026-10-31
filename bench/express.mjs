// Express's routers, shared by bench.mjs and the parity test so the test proves the code being benched.
//
// Both go through real `Router` dispatch, because Express has no lookup on its own. A hit runs up to
// the route's handler, which doesn't call `next`, and a miss ends in `done`. Both are synchronous, so
// the result can be returned. A malformed `%` escape also ends in `done`, as an error, and counts as a
// miss. An app adds middleware, HTTP parsing and a response on top, so this is a lower bound on a
// whole Express request.
//
// Express ignores trailing slashes and case by default, and this router doesn't.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROUTER_OPTIONS = { caseSensitive: true, strict: true };

function createLookup(Router, routes, toPath) {
  const router = Router(ROUTER_OPTIONS);
  let matched = null;
  routes.forEach((route, id) => {
    router.get(toPath(route.path), (req) => {
      req.routeId = id;
      matched = req;
    });
  });

  const res = {};
  const done = () => {};
  return {
    lookup: (method, url) => {
      matched = null;
      router({ method, url }, res, done);
      return matched;
    },
  };
}

/** Express 4 takes `/(a|b)`, `:name(regex)` and `:name?` as they are. */
export function createExpress4(routes) {
  return createLookup(require("express-4").Router, routes, (path) => path);
}

/** Express 5 dropped all three from path strings. Its supported way to validate is a RegExp route. */
export function toRegExp(path) {
  const source = path
    .replace(/\/\(([^)]*)\)/g, "/(?:$1)")
    .replace(
      /\/:(\w+)(?:\(([^/]*)\))?(\?)?/g,
      (_, name, pattern = "[^/]+", optional = "") =>
        `(?:/(?<${name}>${pattern}))${optional}`,
    );
  return new RegExp(`^${source}$`);
}

export function createExpress5(routes) {
  return createLookup(require("express").Router, routes, toRegExp);
}
