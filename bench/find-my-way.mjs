// find-my-way's router, shared by bench.mjs and the parity test so the test proves the code being benched.
//
// Its `find` returns the match without calling the handler, the same job as this router's `find`.
// There are two modes. The tree walk is what Fastify runs, because Fastify doesn't call `compile()`.
// Compiled generates JavaScript from the tree, and is the fastest this library gets.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const FindMyWay = require("find-my-way");

const OPTIONS = {
  // The default of 100 turns a longer param into a miss, and this router has no limit.
  maxParamLength: 65_536,
  // `find` parses the query string by default. This router leaves that to its caller.
  querystringParser: () => null,
};

const TRAILING_ANY = /:(\w+)\(\.\+\)$/;

function createRouter(routes) {
  const router = FindMyWay(OPTIONS);
  routes.forEach((route, id) => {
    for (const path of route.concretePaths) {
      // A param's regex only sees one segment, so `.+` has to be a wildcard to cross `/`.
      const store = { route: id, wildcard: TRAILING_ANY.exec(path)?.[1] };
      router.on("GET", path.replace(TRAILING_ANY, "*"), () => {}, store);
    }
  });
  return router;
}

function createLookup(router) {
  return { lookup: (method, url) => router.find(method, url) };
}

export function createFindMyWay(routes) {
  return createLookup(createRouter(routes));
}

export function createFindMyWayCompiled(routes) {
  return createLookup(createRouter(routes).compile());
}
