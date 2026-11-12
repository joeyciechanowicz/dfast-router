// Hono's routers, shared by bench.mjs and the parity test so the test proves the code being benched.
//
// Each is called directly, without a Hono app. `match` returns every route that fits, in registration
// order, and an app runs them in that order, so the first is the match. It finds them all regardless,
// which is part of what's measured here.
//
// `hono-smart` is what a default Hono app uses. It tries RegExpRouter, and takes TrieRouter if that
// throws UnsupportedPathError, as it does on `/a/:id` next to `/a/b`. The bench routes all have that
// shape, so RegExpRouter has no entry of its own and `hono-smart` runs TrieRouter on them. The parity
// test checks both. On a `--routes` set RegExpRouter can hold, `hono-smart` runs RegExpRouter.
import { PatternRouter } from "hono/router/pattern-router";
import { RegExpRouter } from "hono/router/reg-exp-router";
import { SmartRouter } from "hono/router/smart-router";
import { TrieRouter } from "hono/router/trie-router";

// Hono puts a param's regex between `^` and `$` as it is, so `a|b` needs a group to keep both anchored.
export function toHonoPath(path) {
  return path.replace(
    /:(\w+)\(([^/]*)\)/g,
    (_, name, pattern) => `:${name}{(?:${pattern})}`,
  );
}

// RegExpRouter returns the regex match as a stash, and gives each param's index in it. Like an app, this
// reads the values on demand. TrieRouter and PatternRouter have no stash, and build params every lookup.
class StashedMatch {
  constructor(route, indexes, stash) {
    this.route = route;
    this.indexes = indexes;
    this.stash = stash;
  }

  get params() {
    const params = {};
    for (const name in this.indexes) params[name] = this.stash[this.indexes[name]];
    return params;
  }
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
      const [handlers, stash] = router.match(method, path);
      if (handlers.length === 0) return null;
      const [{ route }, params] = handlers[0];
      return stash === undefined ? { route, params } : new StashedMatch(route, params, stash);
    },
  };
}

export function createHonoTrie(routes) {
  return createLookup(new TrieRouter(), routes);
}

export function createHonoPattern(routes) {
  return createLookup(new PatternRouter(), routes);
}

export function createHonoSmart(routes) {
  const router = new SmartRouter({ routers: [new RegExpRouter(), new TrieRouter()] });
  const { lookup } = createLookup(router, routes);
  // It picks a router on the first lookup, which shouldn't be one that's measured.
  lookup("GET", "/");
  return { lookup, activeRouter: router.activeRouter.name };
}
