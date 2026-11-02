import { PatternRouter } from "hono/router/pattern-router";
import { RegExpRouter } from "hono/router/reg-exp-router";
import { TrieRouter } from "hono/router/trie-router";
import { routes, handler } from "./tool.mjs";

const createHonoRouter = (name, router) => {
  for (const route of routes) {
    router.add(route.method, route.path, handler);
  }
  return {
    name: `Hono ${name}`,
    // Hono's `*` captures nothing: a handler reads the path instead. check.mjs reads this.
    capturesWildcard: false,
    match: (route) => {
      router.match(route.method, route.path);
    },
    // match() returns [[handler, params]...] and, for RegExpRouter, a stash that params index.
    inspect: (route) => {
      const [matched, stash] = router.match(route.method, route.path);
      if (matched.length === 0) return null;
      const [found, indexes] = matched[0];
      const params = {};
      for (const [key, index] of Object.entries(indexes)) params[key] = stash ? stash[index] : index;
      return { handler: found, params };
    },
  };
};

export const regExpRouter = createHonoRouter("RegExpRouter", new RegExpRouter());
export const trieRouter = createHonoRouter("TrieRouter", new TrieRouter());
export const patternRouter = createHonoRouter("PatternRouter", new PatternRouter());
