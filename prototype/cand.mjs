import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { takeNumberFlag } from "../bench/flags.mjs";
import { compile, profile, buildTable, codegen, instantiate, buildPathTree, codegenHot, instantiateHot, compile2, codegen2, buildFast } from "./rc.mjs";
const afterFlag = takeNumberFlag("--after");
const gallopFlag = takeNumberFlag("--gallop", 8);
export const R = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const require = createRequire(R + "/package.json");
const Medley = require("@medley/router");
const h = () => {};
export const safe = (p) => p.replace(/:([A-Za-z0-9_]+)\([^)]*\)/g, ":$1");
const newStore = () => ({ GET: h, POST: undefined, PUT: undefined, DELETE: undefined, PATCH: undefined });

export function patternsOf(routes) {
  const out = [];
  routes.forEach((r, i) => { for (const c of r.concretePaths) out.push({ path: c, route: i }); });
  return out;
}
const adapt = (routes) => routes.map(newStore);

export function build(name, routes, trainUrls) {
  const pats = patternsOf(routes);
  switch (name) {
    case "medley-as-benched": { // the number the repo currently reports
      const r = new Medley(); for (const x of routes) r.register(x.path).GET = h;
      return (u) => r.find(u);
    }
    case "medley-fair": { // same router, but given routes it can actually match
      const r = new Medley();
      const seen = new Set();
      for (const x of pats) { const p = safe(x.path); if (seen.has(p)) continue; seen.add(p); const st = r.register(p); st.GET = h; st.__route = x.route; }
      return (u) => r.find(u);
    }
    case "regex-combined": return combinedRegex(pats, adapt(routes));
    case "dfa-table": {
      const dfa = compile(pats), stores = adapt(routes);
      const factories = dfa.specs.map((sp) => {
        if (!sp.params.length) { const o = { store: stores[sp.route], params: {} }; return () => o; }
        const f = sp.params.map(([n, k]) => `${n}:s.slice(SL[${k}]+1,${k + 1 < 64 ? `Math.min(SL[${k + 1}],e)` : "e"})`).join(",");
        return new Function("st", "SL", `return (s,e,d)=>({store:st,params:{${f}}})`)(stores[sp.route], null);
      });
      return buildTable(dfa, (SL) => {
        const fs = dfa.specs.map((sp) => {
          if (!sp.params.length) { const o = { store: stores[sp.route], params: {} }; return () => o; }
          const f = sp.params.map(([n, k]) => `${n}:s.slice(SL[${k}]+1,${k + 1 < sp.depth ? `SL[${k + 1}]` : "e"})`).join(",");
          return new Function("st", "SL", `return (s,e)=>({store:st,params:{${f}}})`)(stores[sp.route], SL);
        });
        dfa.specs.forEach((sp, i) => { sp.depth = dfa.patterns[i].path === "/" ? 1 : dfa.patterns[i].path.split("/").length - 1; });
        const gs = dfa.specs.map((sp) => {
          if (!sp.params.length) { const o = { store: stores[sp.route], params: {} }; return () => o; }
          const f = sp.params.map(([n, k]) => `${n}:s.slice(SL[${k}]+1,${k + 1 < sp.depth ? `SL[${k + 1}]` : "e"})`).join(",");
          return new Function("st", "SL", `return (s,e)=>({store:st,params:{${f}}})`)(stores[sp.route], SL);
        });
        return (a, s, e) => gs[a](s, e);
      });
    }
    case "plain-notrain": return buildFast(compile(pats, { acceptByPattern: true }), adapt(routes), { train: [], mode: "lazy" });
    case "tail-lazy": case "tail-eager": {
      const mode = name.split("-")[1];
      return buildFast(compile(pats, { acceptByPattern: true }), adapt(routes), { train: [], mode, gallop: 8, after: afterFlag ?? 8, tail: true });
    }
    case "gallop-lazy": case "gallop-eager": {
      const mode = name.split("-")[1];
      return buildFast(compile(pats, { acceptByPattern: true }), adapt(routes), { train: [], mode, gallop: gallopFlag, after: afterFlag ?? 0 });
    }
    case "fast-class-lazy": case "fast-class-eager": case "fast-class-index":
    case "fast-direct-lazy": case "fast-direct-eager": case "fast-direct-index": {
      const [, kind, mode] = name.split("-");
      return buildFast(compile(pats, { acceptByPattern: true }), adapt(routes), { train: trainUrls, direct: kind === "direct", mode });
    }
    case "floor": return (u) => (u.charCodeAt(0) === 0 ? u : null); // harness + string-access cost only
    case "two-level": return codegen2(compile2(pats), adapt(routes));
    default: {
      const hm = /^dfa-hot(?:-(eager|lazy|index))?(?:-min(\d+))?$/.exec(name);
      if (hm) {
        const mode = hm[1] ?? "eager", minCount = +(hm[2] ?? 1);
        const dfa = compile(pats), stores = adapt(routes);
        const cold = buildTableCold(dfa, stores);
        const tree = buildPathTree(dfa, trainUrls);
        const gen = codegenHot(dfa, tree, { mode, minCount });
        const f = instantiateHot(dfa, gen, stores, cold);
        f.meta = { min: dfa.states, tree: gen.tree, src: gen.body.length, body: gen.body };
        return f;
      }
      const m = /^dfa-code(-pgo)?(?:-(eager|lazy|index))?$/.exec(name);
      if (!m) throw new Error("unknown candidate " + name);
      const dfa = compile(pats), mode = m[2] ?? "eager";
      const weights = m[1] ? profile(dfa, trainUrls) : null;
      const gen = codegen(dfa, { weights, mode });
      const f = instantiate(dfa, gen, adapt(routes), mode);
      f.meta = { nfa: dfa.nfaStates, raw: dfa.rawStates, min: dfa.states, classes: dfa.nc, tree: gen.tree, src: gen.body.length, body: gen.body };
      return f;
    }
  }
}

function buildTableCold(dfa, stores) {
  dfa.specs.forEach((sp, i) => { sp.depth = dfa.patterns[i].path === "/" ? 1 : dfa.patterns[i].path.split("/").length - 1; });
  return buildTable(dfa, (SL) => {
    const gs = dfa.specs.map((sp) => {
      if (!sp.params.length) { const o = { store: stores[sp.route], params: {} }; return () => o; }
      const f = sp.params.map(([n, k]) => `${n}:s.slice(SL[${k}]+1,${k + 1 < sp.depth ? `SL[${k + 1}]` : "e"})`).join(",");
      return new Function("st", "SL", `return (s,e)=>({store:st,params:{${f}}})`)(stores[sp.route], SL);
    });
    return (a, s, e) => gs[a](s, e);
  });
}

// Hono-style: one big trie-shaped RegExp with empty marker groups.
function combinedRegex(pats, stores) {
  const root = { kids: new Map(), leaf: null };
  pats.forEach((p, idx) => {
    let n = root;
    const toks = p.path === "/" ? [""] : p.path.split("/").slice(1);
    toks.forEach((t, k) => { if (!n.kids.has(t)) n.kids.set(t, { kids: new Map(), leaf: null }); n = n.kids.get(t); });
    if (n.leaf === null) n.leaf = idx;
  });
  let group = 0;
  const markers = new Map(), names = [];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&");
  function emit(n) {
    const alts = [];
    if (n.leaf !== null) { const g = ++group; markers.set(g, n.leaf); alts.push(`()`); }
    for (const [tok, kid] of n.kids) {
      let t;
      if (tok[0] === ":") {
        const a = tok.indexOf("(");
        const nm = a === -1 ? tok.slice(1) : tok.slice(1, a);
        const body = a === -1 ? "[^/]+" : tok.slice(a + 1, tok.lastIndexOf(")"));
        const g = ++group; names[g] = nm; t = `(${body.replace(/\((?!\?)/g, "(?:")})`;
      } else t = esc(tok);
      alts.push(`\\/${t}${emit(kid)}`);
    }
    return alts.length === 1 ? alts[0] : `(?:${alts.join("|")})`;
  }
  const src = `^(?:${emit(root)})$`;
  const re = new RegExp(src);
  const hasEmpty = (m) => m.indexOf("", 1);
  const f = (u) => {
    const m = re.exec(u);
    if (m === null) return null;
    const g = hasEmpty(m), pat = pats[markers.get(g)];
    const params = {};
    for (let i = 1; i < m.length; i++) if (i !== g && m[i] !== undefined && names[i]) params[names[i]] = m[i];
    return { store: stores[pat.route], params };
  };
  f.meta = { groups: group, srcLen: src.length };
  return f;
}
