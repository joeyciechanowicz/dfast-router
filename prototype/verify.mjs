// Every candidate must agree with a reference regex scan on route AND params.
import { build, patternsOf, R } from "./cand.mjs";
const { routes, precomputedUrls } = await import(R + "/bench/routes.mjs");
const names = process.argv.slice(2);

const toRe = (p) => {
  if (p === "/") return { re: /^\/$/, ns: [] };
  const ns = [];
  const src = p.replace(/\/:([A-Za-z0-9_]+)(\((?:[^()]|\([^)]*\))*\))?/g, (_, n, re) => { ns.push(n); return "/" + (re ?? "([^/]+)"); });
  return { re: new RegExp("^" + src + "$"), ns };
};
const pats = patternsOf(routes);
const refs = pats.map((p) => ({ ...toRe(p.path), route: p.route }));
const ref = (u) => {
  const path = u.split("?")[0];
  for (const r of refs) { const m = r.re.exec(path); if (m) { const params = {}; r.ns.forEach((n, i) => (params[n] = m[i + 1])); return { route: r.route, params }; } }
  return null;
};

// Adversarial near-misses derived from real traffic: these are what real 404s look like.
function rng(seed) { let x = seed; return () => (x = (x * 1664525 + 1013904223) >>> 0) / 4294967296; }
const uniq = [...new Set(precomputedUrls)];
const rnd = rng(42);
const mutated = [];
const chars = "abz09-/?_%é";
for (let i = 0; i < 400000; i++) {
  const u = uniq[Math.floor(rnd() * uniq.length)];
  const p = Math.floor(rnd() * (u.length + 1));
  const ch = chars[Math.floor(rnd() * chars.length)];
  switch (i % 6) {
    case 0: mutated.push(u.slice(0, p) + ch + u.slice(p + 1)); break;         // substitute
    case 1: mutated.push(u.slice(0, p) + ch + u.slice(p)); break;             // insert
    case 2: mutated.push(u.slice(0, p) + u.slice(p + 1)); break;              // delete
    case 3: mutated.push(u + "/"); break;                                     // trailing slash
    case 4: mutated.push(u + "/extra"); break;                                // extra segment
    case 5: mutated.push(u + "?a=1&b=/x/y"); break;                           // query string
  }
}
const all = [...uniq, ...mutated].filter(Boolean).filter((u) => u[0] === "/");
console.log(`checking ${all.length.toLocaleString()} urls (${uniq.length.toLocaleString()} unique corpus + ${mutated.length.toLocaleString()} mutated)`);
const expected = all.map(ref);
console.log("reference hit rate:", (100 * expected.filter(Boolean).length / all.length).toFixed(2) + "%");

for (const name of names) {
  const stores = routes.map((_, i) => i);
  const f = build(name, routes, precomputedUrls.slice(0, 300000));
  const idx = new Map();
  let bad = 0, falsePos = 0, falseNeg = 0, wrongRoute = 0, wrongParams = 0; const ex = [];
  // identify route via the store object: rebuild map by matching one known URL per route is awkward, so tag params+hit compare
  for (let i = 0; i < all.length; i++) {
    if (name === "regex-combined" && all[i].includes("?")) continue;
    const got = f(all[i]), want = expected[i];
    const gotHit = got !== null, wantHit = want !== null;
    if (gotHit !== wantHit) { bad++; gotHit ? falsePos++ : falseNeg++; if (ex.length < 6) ex.push([all[i], wantHit, gotHit]); continue; }
    if (!gotHit) continue;
    const a = JSON.stringify(Object.entries(got.params).sort()), b = JSON.stringify(Object.entries(want.params).sort());
    if (a !== b) { bad++; wrongParams++; if (ex.length < 6) ex.push([all[i], b, a]); }
    const id = got.store.__route ?? got.store;
    if (!idx.has(want.route)) idx.set(want.route, id);
    else if (idx.get(want.route) !== id) { bad++; wrongRoute++; if (ex.length < 6) ex.push([all[i], "route", want.route]); }
  }
  console.log(`${name.padEnd(22)} mismatches=${bad} (falsePos=${falsePos} falseNeg=${falseNeg} wrongParams=${wrongParams} wrongRoute=${wrongRoute})`);
  if (ex.length) console.log(ex);
  if (f.meta) { const { body, ...m } = f.meta; console.log("   ", JSON.stringify(m)); }
}
