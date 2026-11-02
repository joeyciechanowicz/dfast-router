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
    match: (route) => {
      router.match(route.method, route.path);
    },
  };
};

export const regExpRouter = createHonoRouter("RegExpRouter", new RegExpRouter());
export const trieRouter = createHonoRouter("TrieRouter", new TrieRouter());
export const patternRouter = createHonoRouter("PatternRouter", new PatternRouter());
