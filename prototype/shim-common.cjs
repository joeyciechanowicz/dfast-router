// Plugs a router into the repo's own bench.mjs via --router, under the "balancing-router" slot.
const R = require("node:path").resolve(__dirname, "..");
const dist = require(R + "/dist/index.js");
function expand(pattern) { // same semantics as expandPathPattern in bench/routes-generic.mjs
  if (pattern === "/") return ["/"];
  let vs = [[]];
  for (const seg of pattern.split("/").slice(1)) {
    if (!seg) continue;
    if (seg.startsWith("(") && seg.endsWith(")")) { const cs = seg.slice(1, -1).split("|"); vs = vs.flatMap((v) => cs.map((c) => [...v, c])); continue; }
    if (seg.startsWith(":") && seg.endsWith("?")) { const req = seg.slice(0, -1); vs = vs.flatMap((v) => [[...v], [...v, req]]); continue; }
    for (const v of vs) v.push(seg);
  }
  return [...new Set(vs.map((p) => `/${p.join("/")}`))];
}
module.exports = { dist, expand, R };
