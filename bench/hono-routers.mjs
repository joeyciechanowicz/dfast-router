// Hono's routers, shared by bench.mjs and the parity test so the test proves the code being benched.
//
// Each is called directly, without a Hono app. `match` returns every route that fits, in registration
// order, and an app runs them in that order, so the first is the match. It finds them all regardless,
// which is part of what's measured here. Both routers build params on every lookup.
//
// RegExpRouter isn't here because it can't hold these routes: it throws UnsupportedPathError on
// `/a/:id` next to `/a/b`. An app falls back to TrieRouter when that happens, so `hono-trie` is what
// Hono runs for these routes. The parity test checks that it still throws.
import { PatternRouter } from "hono/router/pattern-router";
import { TrieRouter } from "hono/router/trie-router";

// Hono puts a param's regex between `^` and `$` as it is, so `a|b` needs a group to keep both anchored.
export function toHonoPath(path) {
  return path.replace(
    /:(\w+)\(([^/]*)\)/g,
    (_, name, pattern) => `:${name}{(?:${pattern})}`,
  );
}

function createLookup(router, routes) {
  routes.forEach((route, id) => {
    for (const path of route.concretePaths) {
      router.add("GET", toHonoPath(path), { route: id });
    }
  });
  return {
    lookup: (method, url) => {
      // An app cuts the query string before it calls the router.
      const query = url.indexOf("?");
      const path = query === -1 ? url : url.slice(0, query);
      const [handlers] = router.match(method, path);
      if (handlers.length === 0) return null;
      const [{ route }, params] = handlers[0];
      return { route, params };
    },
  };
}

export function createHonoTrie(routes) {
  return createLookup(new TrieRouter(), routes);
}

export function createHonoPattern(routes) {
  return createLookup(new PatternRouter(), routes);
}
