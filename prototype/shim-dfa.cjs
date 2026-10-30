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
module.exports = { ...dist, createMedleyRouter };
