// One candidate per process: no megamorphic pollution or ordering effects between routers.
import { build, R } from "./cand.mjs";
const { routes, precomputedUrls } = await import(R + "/bench/routes.mjs");
const name = process.argv[2];
const strMode = process.argv[3] ?? "fresh";
const rounds = Number(process.argv[4] ?? 7);
const N = Math.min(Number(process.argv[5] ?? 3e6), precomputedUrls.length);
const fresh = (s) => Buffer.from(s, "latin1").toString("latin1");
const urls = strMode === "fresh" ? precomputedUrls.slice(0, N).map(fresh)
  : strMode === "sorted" ? [...precomputedUrls.slice(0, N)].sort().map(fresh)
  : precomputedUrls.slice(0, N);
const find = build(name, routes, precomputedUrls.slice(0, 300000));
globalThis.LAST = null;
const READ = process.env.READ_PARAMS === "1"; // force params so lazy results pay for extraction
function pass() { let hits = 0; for (let i = 0; i < urls.length; i++) { const m = find(urls[i]); if (m !== null) { hits++; globalThis.LAST = READ ? m.params : m; } } return hits; }
let hits = 0; for (let r = 0; r < 2; r++) hits = pass();
const ts = [];
for (let r = 0; r < rounds; r++) { const a = process.hrtime.bigint(); hits = pass(); ts.push(Number(process.hrtime.bigint() - a) / urls.length); }
ts.sort((a, b) => a - b);
const med = ts[ts.length >> 1];
const { body, ...meta } = find.meta ?? {};
console.log(`${name.padEnd(22)} ${strMode.padEnd(6)} ${med.toFixed(1).padStart(7)} ns/op  best ${ts[0].toFixed(1).padStart(6)}  ${(1e3 / med).toFixed(1).padStart(6)}M/s  hit ${(100 * hits / urls.length).toFixed(2)}%  ${Object.keys(meta).length ? JSON.stringify(meta) : ""}`);
