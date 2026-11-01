import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { takeSwitch } from "../bench/flags.mjs";
import { compile, buildFast } from "./rc.mjs";
const R = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const Medley = createRequire(R + "/package.json")("@medley/router");
function rng(seed) { let x = seed; return () => (x = (x * 1664525 + 1013904223) >>> 0) / 4294967296; }
const syll = ["ac","ver","sub","tion","pro","file","or","der","us","er","re","port","com","ment","in","voice","con","fig","data","meta"];
function word(r) { let w = ""; const k = 2 + Math.floor(r() * 3); for (let i = 0; i < k; i++) w += syll[Math.floor(r() * syll.length)]; return w; }
function restApi(n, r) { // resources/:id/subresources/:subId
  const pats = [], seen = new Set();
  while (pats.length < n) {
    const a = word(r), b = word(r);
    for (const p of [`/v1/${a}`, `/v1/${a}/:id`, `/v1/${a}/:id/${b}`, `/v1/${a}/:id/${b}/:subId`]) if (!seen.has(p)) { seen.add(p); pats.push(p); }
  }
  return pats.slice(0, n);
}
function overlap(n, r) { // params and literals at the same depth: the worst realistic case for subset construction
  const pats = [], seen = new Set(), lits = Array.from({ length: Math.max(6, Math.round(Math.sqrt(n))) }, () => word(r));
  while (pats.length < n) {
    const d = 2 + Math.floor(r() * 4); let p = "", pi = 0;
    for (let i = 0; i < d; i++) p += r() < 0.4 ? `/:p${pi++}` : `/${lits[Math.floor(r() * lits.length)]}`;
    if (!seen.has(p)) { seen.add(p); pats.push(p); }
  }
  return pats;
}
const toUrl = (p, r) => p.replace(/:[a-zA-Z0-9]+/g, () => String(1 + Math.floor(r() * 9999999)));
function measure(find, urls) {
  let s = 0; globalThis.LAST = null;
  const pass = () => { for (let i = 0; i < urls.length; i++) { const m = find(urls[i]); if (m !== null) { s++; globalThis.LAST = m; } } };
  for (let k = 0; k < 20; k++) pass();
  const ts = []; for (let k = 0; k < 9; k++) { const a = process.hrtime.bigint(); pass(); ts.push(Number(process.hrtime.bigint() - a) / urls.length); }
  return ts.sort((a, b) => a - b)[4];
}
const noMin = takeSwitch("--no-min");
const kind = process.argv[2], sizes = process.argv.slice(3).map(Number);
for (const n of sizes) {
  const r = rng(n * 7 + 1), pats = (kind === "rest" ? restApi : overlap)(n, r);
  const urls = Array.from({ length: 200000 }, () => Buffer.from(toUrl(pats[Math.floor(r() * n)], r), "latin1").toString("latin1"));
  const t0 = performance.now();
  const dfa = compile(pats.map((path, i) => ({ path, route: i })), { acceptByPattern: true, minimise: !noMin });
  const t1 = performance.now();
  // how much of the automaton does real traffic ever touch? (the case for building states lazily)
  const seen = new Set([dfa.start]);
  for (const u of urls) { let st = dfa.start; for (let i = 0; i < u.length; i++) { const c = u.charCodeAt(i); st = dfa.T[st * dfa.nc + dfa.cls[c < 128 ? c : 128]]; if (st === -1) break; seen.add(st); } }
  console.log(`   visited ${seen.size} of ${dfa.states} states (${(100 * seen.size / dfa.states).toFixed(1)}%) over ${urls.length} uniformly-random urls; determinise${noMin ? "" : "+minimise"}=${(t1 - t0).toFixed(0)}ms`);
  if (noMin) continue;
  const stores = pats.map(() => ({ GET: 1 }));
  const fast = buildFast(dfa, stores, { train: [], mode: "eager", gallop: 8, after: 8, tail: true });
  const med = new Medley(); let conflict = null;
  try { for (const p of pats) med.register(p).GET = 1; } catch (e) { conflict = e.message.split("\n")[0].slice(0, 60); }
  const a = measure(fast, urls), b = conflict ? NaN : measure((u) => med.find(u), urls);
  console.log(`${kind.padEnd(7)} routes=${String(n).padStart(5)}  nfa=${String(dfa.nfaStates).padStart(7)} raw=${String(dfa.rawStates).padStart(6)} min=${String(dfa.states).padStart(6)} cls=${String(dfa.nc).padStart(3)}  table=${String(fast.meta.tableKB).padStart(8)}KB  compile=${(t1 - t0).toFixed(0).padStart(7)}ms  dfa=${a.toFixed(1).padStart(6)}ns  medley=${conflict ? "n/a (param-name conflict)" : b.toFixed(1) + "ns"}`);
}
