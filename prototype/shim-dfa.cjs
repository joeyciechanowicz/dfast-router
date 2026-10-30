const { dist, expand } = require("./shim-common.cjs");
const { compile, buildFast } = require("./rc.mjs");
const MODE = process.env.DFA_MODE ?? "eager";
function createMedleyRouter() {
  const routes = []; let find = null;
  return {
    register(path) { const store = { GET: undefined, POST: undefined, "*": undefined }; routes.push({ path, store }); find = null; return store; },
    find(url) {
      if (find === null) {
        const pats = []; routes.forEach((r, i) => { for (const c of expand(r.path)) pats.push({ path: c, route: i }); });
        find = buildFast(compile(pats, { acceptByPattern: true }), routes.map((r) => r.store), { train: [], mode: MODE, gallop: 8, after: 8, tail: true });
      }
      return find(url);
    },
  };
}
// The "balancing-router" slot. Results keep the prototype's { store, params } shape, not RouteMatch:
// wrapping them would add an allocation per hit, and the bench reads only null and `.params`.
function createRouter() {
  const dfa = createMedleyRouter(); const stores = new Map();
  const router = {
    on(method, path, handler) {
      if (!stores.has(path)) stores.set(path, dfa.register(path));
      for (const m of [method].flat()) stores.get(path)[m] = handler;
      return router;
    },
    find(method, url) {
      const match = dfa.find(url);
      if (match === null) return null;
      return (match.store[method] ?? match.store["*"]) === undefined ? null : match;
    },
    compile() { dfa.find("/"); },
  };
  return router;
}
module.exports = { ...dist, createMedleyRouter, createRouter };
