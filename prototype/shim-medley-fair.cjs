const { dist, expand } = require("./shim-common.cjs");
const safe = (p) => p.replace(/:([A-Za-z0-9_]+)\([^)]*\)/g, ":$1");
function createMedleyRouter() {
  const r = dist.createMedleyRouter(); const seen = new Set(); const sentinel = {};
  return {
    register(path) { // one logical store fanned out to every concrete node
      const nodes = [];
      for (const c of expand(path)) { const p = safe(c); if (!seen.has(p)) { seen.add(p); nodes.push(r.register(p)); } }
      return new Proxy(sentinel, { set(_, k, v) { for (const n of nodes) n[k] = v; return true; } });
    },
    find: (u) => r.find(u),
  };
}
module.exports = { ...dist, createMedleyRouter };
