// Adversarial traffic shapes, one candidate + corpus per process.
import { build, R } from "./cand.mjs";
const { routes, precomputedUrls } = await import(R + "/bench/routes.mjs");
const [name, kind] = process.argv.slice(2);
const N = 1000000;
const base = precomputedUrls.slice(0, N);
function rng(seed) { let x = seed; return () => (x = (x * 1664525 + 1013904223) >>> 0) / 4294967296; }
const r = rng(9), hex = "0123456789abcdef";
const tok = (n) => { let s = ""; for (let i = 0; i < n; i++) s += hex[Math.floor(r() * 16)]; return s; };
const mutate = (u, i) => {
  const p = Math.floor(r() * (u.length + 1)), ch = "abz09-_"[Math.floor(r() * 7)];
  switch (i % 5) { case 0: return u.slice(0, p) + ch + u.slice(p + 1); case 1: return u.slice(0, p) + ch + u.slice(p); case 2: return u.slice(0, p) + u.slice(p + 1) || "/"; case 3: return u + "/"; default: return u + "/extra"; }
};
const maps = {
  clean: (u) => u,
  near404: mutate,
  query: (u) => `${u}?utm_source=newsletter&utm_campaign=autumn&ref=abc123`,
  uuid36: (u) => u.replace(/\d{4,}/g, () => `${tok(8)}-${tok(4)}-${tok(4)}-${tok(4)}-${tok(12)}`),
  token200: (u) => u.replace(/\d{4,}/g, () => tok(200)),
};
const urls = base.map((u, i) => Buffer.from(maps[kind](u, i), "latin1").toString("latin1"));
const find = build(name, routes, precomputedUrls.slice(0, 300000));
globalThis.LAST = null;
function pass() { let h = 0; for (let i = 0; i < urls.length; i++) { const m = find(urls[i]); if (m !== null) { h++; globalThis.LAST = m; } } return h; }
let hits = 0; for (let k = 0; k < 3; k++) hits = pass();
const ts = []; for (let k = 0; k < 7; k++) { const a = process.hrtime.bigint(); hits = pass(); ts.push(Number(process.hrtime.bigint() - a) / urls.length); }
ts.sort((a, b) => a - b);
const meanLen = urls.reduce((s, u) => s + u.length, 0) / urls.length;
console.log(`${kind.padEnd(9)} ${name.padEnd(18)} ${ts[3].toFixed(1).padStart(7)} ns  hit ${(100 * hits / urls.length).toFixed(1).padStart(5)}%  meanLen ${meanLen.toFixed(0)}`);
