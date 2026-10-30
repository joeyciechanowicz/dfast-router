// Report real bytecode length and the tier V8 ended up in.
import { build, R } from "./cand.mjs";
const { routes, precomputedUrls } = await import(R + "/bench/routes.mjs");
const urls = precomputedUrls.slice(0, 500000).map((s) => Buffer.from(s, "latin1").toString("latin1"));
const f = build(process.argv[2], routes, precomputedUrls.slice(0, 300000));
globalThis.LAST = null;
for (let r = 0; r < 12; r++) for (const u of urls) globalThis.LAST = f(u);
const st = %GetOptimizationStatus(f);
const bit = (b) => ((st >> b) & 1);
console.log(process.argv[2].padEnd(24), "status=0x" + st.toString(16), { turbofan: bit(4), maglev: bit(5), interpreted: bit(7) });
