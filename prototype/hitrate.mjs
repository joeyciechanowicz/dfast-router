import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const R = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const require = createRequire(R + "/package.json");
const { routes, precomputedUrls } = await import(R + "/bench/routes.mjs");
const Medley = require("@medley/router");
const { match: ptr } = require("path-to-regexp");

const h = () => {};
const medley = new Medley();
for (const r of routes) medley.register(r.path).GET = h;

// Reference: what SHOULD match — the expanded concrete patterns, in order, via real regexes
const toRe = (p) => {
  if (p === "/") return /^\/$/;
  const src = p.replace(/\/:([A-Za-z0-9_]+)(\((?:[^()]|\([^)]*\))*\))?/g, (_, n, re) => "/" + (re ? re : "([^/]+)"));
  return new RegExp("^" + src + "$");
};
const refs = [];
for (const r of routes) for (const c of r.concretePaths) refs.push({ route: r.path, re: toRe(c) });

const N = precomputedUrls.length;
let hits = 0, refHit = 0;
const uniq = new Set();
const sample = [];
const perRoute = new Map();
for (let i = 0; i < N; i++) {
  const u = precomputedUrls[i];
  uniq.add(u);
  if (medley.find(u)) hits++;
  if (i < 300000) {           // reference linear scan is slow: sample 10%
    const m = refs.find((x) => x.re.test(u));
    if (m) { refHit++; perRoute.set(m.route, (perRoute.get(m.route) ?? 0) + 1); }
    if (!!m !== !!medley.find(u) && sample.length < 8) sample.push([u, !!m, !!medley.find(u)]);
  }
}
const pct = (x, n) => (100 * x / n).toFixed(2) + "%";
console.log({ corpus: N, unique: uniq.size, routes: routes.length, concrete: refs.length });
console.log("@medley/router hit rate:", pct(hits, N));
console.log("reference (regex) hit rate (first 300k):", pct(refHit, 300000));
console.log("disagreements sample [url, shouldMatch, medleyMatched]:"); console.table(sample);
const lens = precomputedUrls.slice(0, 200000).map(u => u.length);
console.log("mean url len", lens.reduce((a, b) => a + b) / lens.length);
console.log([...perRoute].sort((a,b)=>b[1]-a[1]).slice(0,10).map(([r,c])=>`${pct(c,300000).padStart(7)}  ${r}`).join("\n"));
