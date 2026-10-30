// Route compiler prototype: route patterns -> AST -> NFA -> minimised DFA -> {table, JS codegen}.
// Treats the whole route table as ONE regular language.

const ALPHA = 129, OTHER = 128, SLASH = 47, QMARK = 63;
const mkset = (f) => { const s = new Uint8Array(ALPHA); for (let i = 0; i < ALPHA; i++) if (f(i)) s[i] = 1; return s; };
const single = (c) => mkset((i) => i === c);
const SEG = mkset((i) => i !== SLASH && i !== QMARK); // default param charset; '?' terminates the path
const code = (ch) => ch.charCodeAt(0);

// --- Regex subset parser (char classes, groups, alternation, quantifiers) -----------------------
export function parseRegex(src) {
  let p = 0;
  const seg = (s) => { s[QMARK] = 0; return s; }; // only '?' ends the path; real regexes may cross '/'
  const esc = (c) => {
    if (c === "d") return mkset((i) => i >= 48 && i <= 57);
    if (c === "w") return mkset((i) => (i >= 48 && i <= 57) || (i >= 65 && i <= 90) || (i >= 97 && i <= 122) || i === 95);
    return single(code(c));
  };
  function alt() { const xs = [cat()]; while (src[p] === "|") { p++; xs.push(cat()); } return xs.length === 1 ? xs[0] : { t: "alt", xs }; }
  function cat() { const xs = []; while (p < src.length && src[p] !== "|" && src[p] !== ")") xs.push(rep()); return { t: "cat", xs }; }
  function rep() {
    let a = atom();
    for (;;) {
      const c = src[p];
      if (c === "*") { p++; a = { t: "rep", x: a, min: 0, max: Infinity }; }
      else if (c === "+") { p++; a = { t: "rep", x: a, min: 1, max: Infinity }; }
      else if (c === "?") { p++; a = { t: "rep", x: a, min: 0, max: 1 }; }
      else if (c === "{") {
        const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(p)); p += m[0].length;
        const min = +m[1]; a = { t: "rep", x: a, min, max: m[2] ? (m[3] ? +m[3] : Infinity) : min };
      } else return a;
    }
  }
  function atom() {
    const c = src[p];
    if (c === "(") { p++; if (src.startsWith("?:", p)) p += 2; const x = alt(); p++; return x; }
    if (c === ".") { p++; return { t: "set", set: mkset((i) => i !== QMARK) }; }
    if (c === "\\") { p += 2; return { t: "set", set: seg(esc(src[p - 1])) }; }
    if (c === "[") {
      p++; const neg = src[p] === "^"; if (neg) p++;
      const s = new Uint8Array(ALPHA);
      while (src[p] !== "]") {
        if (src[p] === "\\") { const e = esc(src[p + 1]); for (let i = 0; i < ALPHA; i++) s[i] |= e[i]; p += 2; continue; }
        const a = code(src[p]);
        if (src[p + 1] === "-" && src[p + 2] !== "]") { const b = code(src[p + 2]); for (let i = a; i <= b; i++) s[i] = 1; p += 3; }
        else { s[a] = 1; p++; }
      }
      p++;
      if (neg) for (let i = 0; i < ALPHA; i++) s[i] ^= 1;
      return { t: "set", set: seg(s) };
    }
    p++; return { t: "set", set: seg(single(code(c))) };
  }
  return alt();
}

// --- Concrete pattern ("/catalog/:locale(re)/items/:id") -> AST + param extraction spec ----------
export function parseConcrete(path) {
  const xs = [], params = [];
  const lit = (s) => { for (const ch of s) xs.push({ t: "set", set: single(code(ch)) }); };
  if (path === "/") { lit("/"); return { ast: { t: "cat", xs }, params }; }
  const segs = path.split("/").slice(1);
  segs.forEach((seg, k) => {
    lit("/");
    if (seg[0] !== ":") { lit(seg); return; }
    const a = seg.indexOf("(");
    if (a === -1) { params.push([seg.slice(1), k]); xs.push({ t: "rep", x: { t: "set", set: SEG }, min: 1, max: Infinity }); return; }
    params.push([seg.slice(1, a), k]);
    xs.push(parseRegex(seg.slice(a + 1, seg.lastIndexOf(")"))));
  });
  return { ast: { t: "cat", xs }, params };
}

// --- Thompson NFA --------------------------------------------------------------------------------
class NFA {
  eps = []; edges = []; accept = [];
  add() { this.eps.push([]); this.edges.push([]); this.accept.push(-1); return this.eps.length - 1; }
}
function frag(n, ast, from) {
  switch (ast.t) {
    case "set": { const to = n.add(); n.edges[from].push([ast.set, to]); return to; }
    case "cat": { let s = from; for (const x of ast.xs) s = frag(n, x, s); return s; }
    case "alt": { const end = n.add(); for (const x of ast.xs) { const a = n.add(); n.eps[from].push(a); n.eps[frag(n, x, a)].push(end); } return end; }
    case "rep": {
      let s = from;
      for (let k = 0; k < ast.min; k++) s = frag(n, ast.x, s);
      if (ast.max === Infinity) {
        const loop = n.add(); n.eps[s].push(loop);
        n.eps[frag(n, ast.x, loop)].push(loop);
        const out = n.add(); n.eps[loop].push(out); return out;
      }
      const end = n.add(); n.eps[s].push(end);
      for (let k = ast.min; k < ast.max; k++) { s = frag(n, ast.x, s); n.eps[s].push(end); }
      return end;
    }
  }
}

// --- Determinise + minimise ------------------------------------------------------------------------
// patterns: [{ path, route }] in priority order (earlier wins).
export function compile(patterns, { minimise = true, acceptByPattern = false } = {}) {
  const n = new NFA(); const root = n.add();
  const specs = [];
  patterns.forEach((pat, idx) => {
    const { ast, params } = parseConcrete(pat.path);
    const s = n.add(); n.eps[root].push(s);
    n.accept[frag(n, ast, s)] = idx;
    specs.push({ route: pat.route, params });
  });

  // alphabet compression
  const uniq = new Map();
  for (const es of n.edges) for (const [set] of es) uniq.set(set.join(""), set);
  const sets = [...uniq.values()];
  const sigs = new Map(); const cls = new Uint8Array(ALPHA);
  for (let c = 0; c < ALPHA; c++) {
    const sig = sets.map((s) => s[c]).join("");
    if (!sigs.has(sig)) sigs.set(sig, sigs.size);
    cls[c] = sigs.get(sig);
  }
  const nc = sigs.size;
  const rep = new Array(nc); for (let c = ALPHA - 1; c >= 0; c--) rep[cls[c]] = c;

  const closure = (seed) => {
    const seen = new Set(seed), st = [...seed];
    while (st.length) for (const e of n.eps[st.pop()]) if (!seen.has(e)) { seen.add(e); st.push(e); }
    return [...seen].sort((a, b) => a - b);
  };
  const ids = new Map(), dstates = [], trans = [], acc = [], depth = [];
  const intern = (set, d) => {
    const key = set.join(",");
    let id = ids.get(key);
    if (id === undefined) {
      id = dstates.length; ids.set(key, id); dstates.push(set); depth.push(d);
      let a = -1; for (const s of set) if (n.accept[s] !== -1 && (a === -1 || n.accept[s] < a)) a = n.accept[s];
      acc.push(a);
    }
    return id;
  };
  intern(closure([root]), 0);
  for (let i = 0; i < dstates.length; i++) {
    const row = new Int32Array(nc).fill(-1);
    for (let k = 0; k < nc; k++) {
      const c = rep[k], next = new Set();
      for (const s of dstates[i]) for (const [set, to] of n.edges[s]) if (set[c]) next.add(to);
      if (next.size) row[k] = intern(closure([...next]), depth[i] + (c === SLASH ? 1 : 0));
    }
    trans.push(row);
  }

  // Moore minimisation; depth stays in the partition so segment registers stay static.
  const acceptKey = (a) => (a === -1 ? "-" : acceptByPattern ? `p${a}` : `${specs[a].route}:${JSON.stringify(specs[a].params)}`);
  let part = new Array(dstates.length), np = 0;
  if (minimise) {
    const m = new Map();
    for (let i = 0; i < dstates.length; i++) { const k = acceptByPattern ? acceptKey(acc[i]) : `${acceptKey(acc[i])}|${depth[i]}`; if (!m.has(k)) m.set(k, m.size); part[i] = m.get(k); }
    np = m.size;
    for (;;) {
      const m2 = new Map(), next = new Array(dstates.length);
      for (let i = 0; i < dstates.length; i++) {
        const k = part[i] + ":" + Array.from(trans[i], (t) => (t === -1 ? -1 : part[t])).join(",");
        if (!m2.has(k)) m2.set(k, m2.size);
        next[i] = m2.get(k);
      }
      part = next; if (m2.size === np) break; np = m2.size;
    }
  } else { part = dstates.map((_, i) => i); np = dstates.length; }

  const T = new Int32Array(np * nc).fill(-1), A = new Int32Array(np).fill(-1), D = new Int32Array(np);
  for (let i = 0; i < dstates.length; i++) {
    const p = part[i]; A[p] = acc[i]; D[p] = depth[i];
    for (let k = 0; k < nc; k++) T[p * nc + k] = trans[i][k] === -1 ? -1 : part[trans[i][k]];
  }
  return { nfaStates: n.eps.length, rawStates: dstates.length, states: np, nc, cls, rep, T, A, D, start: part[0], specs, patterns };
}

// --- Traffic profile: edge counts per (state,class) -------------------------------------------------
export function profile(dfa, urls) {
  const { nc, cls, T, start } = dfa;
  const w = new Float64Array(dfa.states * nc);
  for (const u of urls) {
    let st = start;
    for (let i = 0; i < u.length; i++) {
      const c = u.charCodeAt(i), k = cls[c < 128 ? c : OTHER], e = st * nc + k;
      w[e]++; st = T[e]; if (st === -1) break;
    }
  }
  return w;
}

// --- Table-driven engine (no code generation at all) --------------------------------------------------
export function buildTable(dfa, makeResult) {
  const { nc, cls, T, A, D, start, states } = dfa;
  const shift = 32 - Math.clz32(nc - 1);
  const stride = 1 << shift;
  const TT = new Uint16Array(states * stride); // 0 = dead; states are id+1
  for (let s = 0; s < states; s++) for (let k = 0; k < nc; k++) { const t = T[s * nc + k]; TT[((s + 1) << shift) + k] = t === -1 ? 0 : t + 1; }
  const CLS = new Uint8Array(cls);
  const ACC = new Int32Array(states + 1).fill(-1); for (let s = 0; s < states; s++) ACC[s + 1] = A[s];
  const SL = new Int32Array(64);
  const S0 = start + 1;
  const res = makeResult(SL);
  return function find(s) {
    const n = s.length; let st = S0, d = 0, i = 0;
    for (; i < n; i++) {
      const c = s.charCodeAt(i);
      if (c === 47) SL[d++] = i; else if (c === 63) break;
      st = TT[(st << shift) + CLS[c < 128 ? c : 128]];
      if (st === 0) return null;
    }
    const a = ACC[st];
    return a === -1 ? null : res(a, s, i);
  };
}

// --- JS code generation: structured, tree-shaped, no state variable at runtime -----------------------
export function codegen(dfa, { weights = null, mode = "eager", maxDup = Infinity } = {}) {
  const { nc, rep, cls, T, A, D, start, specs, states } = dfa;
  let uid = 0, emitted = 0;
  const lines = [];
  const out = (s) => { lines.push(s); };

  const edgesOf = (st) => {
    const m = new Map();
    for (let k = 0; k < nc; k++) {
      const t = T[st * nc + k]; if (t === -1) continue;
      if (!m.has(t)) m.set(t, { to: t, cs: [], w: 0 });
      const e = m.get(t);
      for (let c = 0; c < ALPHA; c++) if (cls[c] === k) e.cs.push(c);
      if (weights) e.w += weights[st * nc + k];
    }
    return [...m.values()];
  };

  const P = (pos, k = 0) => { const o = pos.o + k; return pos.b ? (o ? `${pos.b}+${o}` : pos.b) : String(o); };

  // Render membership test for chars, treating `known` (already excluded) as don't-care.
  function cond(v, cs, known) {
    const inSet = new Uint8Array(ALPHA); for (const c of cs) inSet[c] = 1;
    const hasOther = inSet[OTHER] === 1;
    const out_ = new Uint8Array(ALPHA); for (let c = 0; c < ALPHA; c++) if (!inSet[c] && !known[c]) out_[c] = 1;
    // nothing else possible -> unconditional (caller emits else)
    let excl = 0; const ex = []; for (let c = 0; c < ALPHA; c++) if (out_[c]) { excl++; ex.push(c); }
    if (excl === 0) return "true";
    if (excl <= 2 && !ex.includes(OTHER)) return ex.map((c) => `${v}!==${c}`).join("&&");
    // positive ranges over 0..127, merging across don't-cares
    const rs = [];
    let a = -1, b = -1;
    for (let c = 0; c < 128; c++) {
      if (inSet[c]) { if (a === -1) a = c; b = c; }
      else if (out_[c] && a !== -1) { rs.push([a, b]); a = -1; }
    }
    if (a !== -1) rs.push([a, b]);
    const parts = rs.map(([x, y]) => (x === y ? `${v}===${x}` : `(${v}>=${x}&&${v}<=${y})`));
    if (hasOther) parts.push(`${v}>127`);
    return parts.length === 1 ? parts[0] : `(${parts.join("||")})`;
  }

  function accept(a, pos, regs) {
    const sp = specs[a];
    const seg = (k) => [`${regs[k]}+1`, k + 1 < regs.length ? regs[k + 1] : P(pos)];
    if (mode === "index") return `return ${sp.route};`;
    if (sp.params.length === 0) return `return M[${sp.route}];`;
    if (mode === "lazy") {
      const offs = sp.params.flatMap(([, k]) => seg(k));
      return `return new L(R[${sp.route}],N[${a}],s,${[...offs, ...Array(8 - offs.length).fill(0)].join(",")});`;
    }
    const fields = sp.params.map(([name, k]) => { const [x, y] = seg(k); return `${name}:s.slice(${x},${y})`; }).join(",");
    return `return {store:R[${sp.route}],params:{${fields}}};`;
  }

  // A state's in-edge symbol '/' pushes a segment register; registers are compile-time expressions.
  function gen(st, pos, regs) {
    emitted++;
    const a = A[st];
    const edges = edgesOf(st).sort((x, y) => y.w - x.w);
    const self = edges.find((e) => e.to === st);
    const rest = edges.filter((e) => e !== self);

    if (self) { genLoop(st, pos, regs, self, rest); return; }

    // literal-chain compression
    if (a === -1 && rest.length === 1 && rest[0].cs.length === 1) {
      const chars = []; let cur = st, r = regs;
      for (;;) {
        const es = edgesOf(cur);
        if (A[cur] !== -1 || es.length !== 1 || es[0].cs.length !== 1 || es[0].to === cur) break;
        const c = es[0].cs[0];
        if (c === SLASH) r = [...r, P(pos, chars.length)];
        chars.push(c); cur = es[0].to;
      }
      const end = P(pos, chars.length);
      const tests = chars.map((c, i) => `s.charCodeAt(${P(pos, i)})===${c}`).join("&&");
      out(`if(n>=${end}&&${tests}){`);
      gen(cur, { b: pos.b, o: pos.o + chars.length }, r);
      out(`}`);
      return;
    }

    if (a !== -1 && edges.length === 0) { out(`if(n===${P(pos)}||s.charCodeAt(${P(pos)})===63){${accept(a, pos, regs)}}`); return; }

    const v = `c${uid++}`;
    if (a !== -1) {
      out(`if(n===${P(pos)}){${accept(a, pos, regs)}}`);
      out(`const ${v}=s.charCodeAt(${P(pos)});`);
      out(`if(${v}===63){${accept(a, pos, regs)}}`);
      dispatch(v, rest, { b: pos.b, o: pos.o + 1 }, pos, regs, single(QMARK));
    } else {
      out(`if(n>${P(pos)}){const ${v}=s.charCodeAt(${P(pos)});`);
      dispatch(v, rest, { b: pos.b, o: pos.o + 1 }, pos, regs, new Uint8Array(ALPHA));
      out(`}`);
    }
  }

  function dispatch(v, edges, next, cur, regs, known0) {
    const known = new Uint8Array(known0);
    // Dead chars: nothing can follow, so they are "out". Everything else gets a branch.
    // Order: by traffic, but narrow sets first among equals so wide ranges can use don't-cares.
    const order = [...edges].sort((x, y) => (y.w - x.w) || (x.cs.length - y.cs.length));
    order.forEach((e, idx) => {
      const c = cond(v, e.cs, known);
      out(`${idx ? "else " : ""}if(${c}){`);
      const r = e.cs.length === 1 && e.cs[0] === SLASH ? [...regs, P(cur)] : regs;
      gen(e.to, next, r);
      out(`}`);
      for (const ch of e.cs) known[ch] = 1;
    });
  }

  function genLoop(st, pos, regs, self, rest) {
    const a = A[st], j = `j${uid++}`, v = `c${uid++}`;
    const known = new Uint8Array(ALPHA);
    const loopCond = cond(v, self.cs, known);
    out(`let ${j}=${P(pos)},${v}=0;while(${j}<n&&(${v}=s.charCodeAt(${j}),${loopCond}))${j}++;`);
    const np = { b: j, o: 0 };
    const acc = a !== -1 ? accept(a, np, regs) : null;
    if (acc) out(`if(${j}===n||${v}===63){${acc}}`);
    else if (rest.length) out(`if(${j}<n){`);
    if (rest.length) dispatch(v, rest, { b: j, o: 1 }, np, regs, new Uint8Array(self.cs.reduce((m, c) => (m[c] = 1, m), new Uint8Array(ALPHA))));
    if (!acc && rest.length) out(`}`);
  }

  gen(start, { b: "", o: 0 }, []);
  const body = `const n=s.length;\n${lines.join("\n")}\nreturn null;`;
  return { body, tree: emitted };
}

export function instantiate(dfa, gen, stores, mode) {
  const nameTable = dfa.specs.map((s) => s.params.map(([n]) => n));
  class L {
    constructor(store, names, url, a, b, c, d, e, f, g, h) {
      this.store = store; this.names = names; this.url = url;
      this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f; this.g = g; this.h = h; this._p = null;
    }
    get params() {
      if (this._p !== null) return this._p;
      const p = {}, N = this.names, O = [this.a, this.b, this.c, this.d, this.e, this.f, this.g, this.h];
      for (let i = 0; i < N.length; i++) p[N[i]] = this.url.slice(O[2 * i], O[2 * i + 1]);
      return (this._p = p);
    }
  }
  const EMPTY = Object.freeze({});
  const M = stores.map((store) => Object.freeze({ store, params: EMPTY }));
  const f = new Function("R", "M", "L", "N", `"use strict";return function find(s){\n${gen.body}\n}`);
  return f(stores, M, L, nameTable);
}

// --- Tier 1: profile-guided hot path. Only DFA paths seen in traffic become code; everything else
// falls through to the table engine, which runs the same DFA and so cannot disagree.
export function buildPathTree(dfa, urls) {
  const { nc, cls, T, start } = dfa;
  const root = { st: start, kids: new Map(), n: 0 };
  for (const u of urls) {
    let cur = root, st = start; cur.n++;
    for (let i = 0; i < u.length; i++) {
      const c = u.charCodeAt(i);
      if (c === QMARK) break;
      const nx = T[st * nc + cls[c < 128 ? c : OTHER]];
      if (nx === -1) break;
      if (nx === st) continue;
      let k = cur.kids.get(nx);
      if (!k) { k = { st: nx, kids: new Map(), n: 0 }; cur.kids.set(nx, k); }
      k.n++; cur = k; st = nx;
    }
  }
  return root;
}

export function codegenHot(dfa, tree, { minCount = 1, mode = "eager", deadReturnsNull = true } = {}) {
  const { nc, cls, T, A, specs } = dfa;
  let uid = 0, nodes = 0;
  const lines = [], out = (s) => lines.push(s);
  const P = (pos, k = 0) => { const o = pos.o + k; return pos.b ? (o ? `${pos.b}+${o}` : pos.b) : String(o); };
  const allEdges = (st) => {
    const m = new Map();
    for (let k = 0; k < nc; k++) {
      const t = T[st * nc + k]; if (t === -1) continue;
      if (!m.has(t)) m.set(t, { to: t, cs: [] });
      const e = m.get(t);
      for (let c = 0; c < ALPHA; c++) if (cls[c] === k) e.cs.push(c);
    }
    return [...m.values()];
  };
  function cond(v, cs, known) {
    const inSet = new Uint8Array(ALPHA); for (const c of cs) inSet[c] = 1;
    const hasOther = inSet[OTHER] === 1;
    const out_ = new Uint8Array(ALPHA); for (let c = 0; c < ALPHA; c++) if (!inSet[c] && !known[c]) out_[c] = 1;
    const ex = []; for (let c = 0; c < ALPHA; c++) if (out_[c]) ex.push(c);
    if (ex.length === 0) return "true";
    if (ex.length <= 2 && !ex.includes(OTHER)) return ex.map((c) => `${v}!==${c}`).join("&&");
    const rs = []; let a = -1, b = -1;
    for (let c = 0; c < 128; c++) {
      if (inSet[c]) { if (a === -1) a = c; b = c; } else if (out_[c] && a !== -1) { rs.push([a, b]); a = -1; }
    }
    if (a !== -1) rs.push([a, b]);
    const parts = rs.map(([x, y]) => (x === y ? `${v}===${x}` : `(${v}>=${x}&&${v}<=${y})`));
    if (hasOther) parts.push(`${v}>127`);
    return parts.length === 1 ? parts[0] : `(${parts.join("||")})`;
  }
  function accept(a, pos, regs) {
    const sp = specs[a];
    const seg = (k) => [`${regs[k]}+1`, k + 1 < regs.length ? regs[k + 1] : P(pos)];
    if (mode === "index") return `return ${sp.route};`;
    if (sp.params.length === 0) return `return M[${sp.route}];`;
    if (mode === "lazy") {
      const offs = sp.params.flatMap(([, k]) => seg(k));
      return `return new L(R[${sp.route}],N[${a}],s,${[...offs, ...Array(8 - offs.length).fill(0)].join(",")});`;
    }
    return `return {store:R[${sp.route}],params:{${sp.params.map(([nm, k]) => { const [x, y] = seg(k); return `${nm}:s.slice(${x},${y})`; }).join(",")}}};`;
  }
  const live = (node) => [...node.kids.values()].filter((k) => k.n >= minCount);
  function gen(node, pos, regs) {
    nodes++;
    const st = node.st, a = A[st];
    const every = allEdges(st);
    const self = every.find((e) => e.to === st);
    const kids = live(node);
    const hot = kids.map((k) => ({ node: k, cs: every.find((e) => e.to === k.st).cs })).sort((x, y) => y.node.n - x.node.n);
    const complete = hot.length === every.filter((e) => e !== self).length;
    if (self) { genLoop(node, pos, regs, self, hot, complete); return; }
    if (a === -1 && hot.length === 1 && hot[0].cs.length === 1 && complete) {
      // chain members must be complete too, so a mismatch is genuinely dead
      const chars = []; let cur = node, r = regs;
      for (;;) {
        const ks = live(cur), es = allEdges(cur.st);
        if (A[cur.st] !== -1 || ks.length !== 1 || es.length !== 1 || es[0].cs.length !== 1 || es[0].to === cur.st) break;
        const c = es[0].cs[0];
        if (c === SLASH) r = [...r, P(pos, chars.length)];
        chars.push(c); cur = ks[0];
      }
      out(`if(n>=${P(pos, chars.length)}&&${chars.map((c, i) => `s.charCodeAt(${P(pos, i)})===${c}`).join("&&")}){`);
      gen(cur, { b: pos.b, o: pos.o + chars.length }, r);
      out(`}return null;`);
      return;
    }
    if (a !== -1 && every.length === 0) { out(`if(n===${P(pos)}||s.charCodeAt(${P(pos)})===63){${accept(a, pos, regs)}}return null;`); return; }
    const v = `c${uid++}`;
    if (a !== -1) {
      out(`if(n===${P(pos)}){${accept(a, pos, regs)}}const ${v}=s.charCodeAt(${P(pos)});if(${v}===63){${accept(a, pos, regs)}}`);
      dispatch(v, hot, { b: pos.b, o: pos.o + 1 }, pos, regs, single(QMARK), complete);
    } else {
      out(`if(n>${P(pos)}){const ${v}=s.charCodeAt(${P(pos)});`);
      dispatch(v, hot, { b: pos.b, o: pos.o + 1 }, pos, regs, new Uint8Array(ALPHA), complete);
      out(`}return null;`);
    }
  }
  function dispatch(v, hot, next, cur, regs, known0, complete) {
    const known = new Uint8Array(known0);
    hot.forEach((e, idx) => {
      out(`${idx ? "else " : ""}if(${cond(v, e.cs, known)}){`);
      gen(e.node, next, e.cs.length === 1 && e.cs[0] === SLASH ? [...regs, P(cur)] : regs);
      out(`}`);
      for (const ch of e.cs) known[ch] = 1;
    });
    out(complete ? `return null;` : `return C(s);`);
  }
  function genLoop(node, pos, regs, self, hot, complete) {
    const a = A[node.st], j = `j${uid++}`, v = `c${uid++}`;
    const known = new Uint8Array(ALPHA);
    out(`let ${j}=${P(pos)},${v}=0;while(${j}<n&&(${v}=s.charCodeAt(${j}),${cond(v, self.cs, known)}))${j}++;`);
    const np = { b: j, o: 0 }, acc = a !== -1 ? accept(a, np, regs) : null;
    if (acc) out(`if(${j}===n||${v}===63){${acc}}`);
    out(`if(${j}<n){`);
    const k0 = new Uint8Array(ALPHA); for (const c of self.cs) k0[c] = 1;
    dispatch(v, hot, { b: j, o: 1 }, np, regs, k0, complete);
    out(`}return null;`);
  }
  gen(tree, { b: "", o: 0 }, []);
  return { body: `const n=s.length;\n${lines.join("\n")}`, tree: nodes };
}

export function instantiateHot(dfa, gen, stores, cold) {
  const nameTable = dfa.specs.map((s) => s.params.map(([n]) => n));
  class L {
    constructor(store, names, url, a, b, c, d, e, f, g, h) { this.store = store; this.names = names; this.url = url; this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f; this.g = g; this.h = h; this._p = null; }
    get params() {
      if (this._p !== null) return this._p;
      const p = {}, N = this.names, O = [this.a, this.b, this.c, this.d, this.e, this.f, this.g, this.h];
      for (let i = 0; i < N.length; i++) p[N[i]] = this.url.slice(O[2 * i], O[2 * i + 1]);
      return (this._p = p);
    }
  }
  const EMPTY = Object.freeze({});
  const M = stores.map((store) => Object.freeze({ store, params: EMPTY }));
  return new Function("R", "M", "L", "N", "C", `"use strict";return function find(s){\n${gen.body}\n}`)(stores, M, L, nameTable, cold);
}

// --- Two-level design: one vocabulary-wide segment lexer + token-level route table -------------------
export function compile2(patterns) {
  // 1. Intern every distinct segment pattern as an atom. ANY is always present.
  const atoms = new Map([["ANY", 0]]), atomAst = [{ t: "rep", x: { t: "set", set: SEG }, min: 1, max: Infinity }];
  const intern = (key, ast) => { if (!atoms.has(key)) { atoms.set(key, atoms.size); atomAst.push(ast); } return atoms.get(key); };
  const litAst = (s) => ({ t: "cat", xs: [...s].map((ch) => ({ t: "set", set: single(code(ch)) })) });
  const specs = [], seqs = [];
  patterns.forEach((pat, idx) => {
    const params = [], seq = [];
    (pat.path === "/" ? [""] : pat.path.split("/").slice(1)).forEach((seg, k) => {
      if (seg[0] !== ":") { seq.push(intern("L:" + seg, litAst(seg))); return; }
      const a = seg.indexOf("(");
      if (a === -1) { params.push([seg.slice(1), k]); seq.push(0); return; }
      const src = seg.slice(a + 1, seg.lastIndexOf(")"));
      params.push([seg.slice(1, a), k]); seq.push(intern("R:" + src, parseRegex(src)));
    });
    specs.push({ route: pat.route, params }); seqs.push(seq);
  });
  // 2. Lexer DFA over the union of atoms. A state's token = the SET of atoms that match here.
  const n = new NFA(); const root = n.add();
  const nfaAccept = new Map();
  atomAst.forEach((ast, id) => { const s = n.add(); n.eps[root].push(s); nfaAccept.set(frag(n, ast, s), id); });
  const closure = (seed) => { const seen = new Set(seed), st = [...seed]; while (st.length) for (const e of n.eps[st.pop()]) if (!seen.has(e)) { seen.add(e); st.push(e); } return [...seen].sort((a, b) => a - b); };
  const uniq = new Map(); for (const es of n.edges) for (const [set] of es) uniq.set(set.join(""), set);
  const sets = [...uniq.values()], sigs = new Map(), cls = new Uint8Array(ALPHA);
  for (let c = 0; c < ALPHA; c++) { const sig = sets.map((s) => s[c]).join(""); if (!sigs.has(sig)) sigs.set(sig, sigs.size); cls[c] = sigs.get(sig); }
  const nc = sigs.size, rep = new Array(nc); for (let c = ALPHA - 1; c >= 0; c--) rep[cls[c]] = c;
  const ids = new Map(), ds = [], trans = [];
  const tokens = new Map([["", 0]]), tokenAtoms = [[]], tok = [];
  const ist = (set) => {
    const key = set.join(","); let id = ids.get(key);
    if (id === undefined) {
      id = ds.length; ids.set(key, id); ds.push(set);
      const as = [...new Set(set.filter((s) => nfaAccept.has(s)).map((s) => nfaAccept.get(s)))].sort((a, b) => a - b);
      const k = as.join(","); if (!tokens.has(k)) { tokens.set(k, tokens.size); tokenAtoms.push(as); }
      tok.push(tokens.get(k));
    }
    return id;
  };
  ist(closure([root]));
  for (let i = 0; i < ds.length; i++) {
    const row = new Int32Array(nc).fill(-1);
    for (let k = 0; k < nc; k++) {
      const c = rep[k], nx = new Set();
      for (const s of ds[i]) for (const [set, to] of n.edges[s]) if (set[c]) nx.add(to);
      if (nx.size) row[k] = ist(closure([...nx]));
    }
    trans.push(row);
  }
  // minimise the lexer
  let part = tok.slice(), np = new Set(part).size;
  for (;;) {
    const m = new Map(), nx = new Array(ds.length);
    for (let i = 0; i < ds.length; i++) { const k = part[i] + ":" + Array.from(trans[i], (t) => (t === -1 ? -1 : part[t])).join(","); if (!m.has(k)) m.set(k, m.size); nx[i] = m.get(k); }
    part = nx; if (m.size === np) break; np = m.size;
  }
  const LT = new Int32Array(np * nc).fill(-1), LK = new Int32Array(np);
  for (let i = 0; i < ds.length; i++) { LK[part[i]] = tok[i]; for (let k = 0; k < nc; k++) LT[part[i] * nc + k] = trans[i][k] === -1 ? -1 : part[trans[i][k]]; }
  // 3. Route-level trie over atoms, determinised over tokens.
  const trie = [{ kids: new Map(), acc: -1 }];
  seqs.forEach((seq, idx) => {
    let t = 0;
    for (const a of seq) { if (!trie[t].kids.has(a)) { trie[t].kids.set(a, trie.length); trie.push({ kids: new Map(), acc: -1 }); } t = trie[t].kids.get(a); }
    if (trie[t].acc === -1) trie[t].acc = idx;
  });
  const rid = new Map(), rs = [[0]], rtrans = [], racc = [];
  rid.set("0", 0);
  for (let i = 0; i < rs.length; i++) {
    let a = -1; for (const t of rs[i]) if (trie[t].acc !== -1 && (a === -1 || trie[t].acc < a)) a = trie[t].acc;
    racc.push(a);
    const row = new Int32Array(tokenAtoms.length).fill(-1);
    for (let k = 1; k < tokenAtoms.length; k++) {
      const nx = new Set();
      for (const t of rs[i]) for (const at of tokenAtoms[k]) { const to = trie[t].kids.get(at); if (to !== undefined) nx.add(to); }
      if (!nx.size) continue;
      const set = [...nx].sort((x, y) => x - y), key = set.join(",");
      if (!rid.has(key)) { rid.set(key, rs.length); rs.push(set); }
      row[k] = rid.get(key);
    }
    rtrans.push(row);
  }
  return { atoms: atoms.size, lexStates: np, nc, cls, rep, LT, LK, lexStart: part[0], tokens: tokenAtoms.length, routeStates: rs.length, rtrans, racc, specs };
}

export function codegen2(c2, stores) {
  const { nc, cls, LT, LK, lexStart, specs, racc, rtrans, tokens, routeStates } = c2;
  const K = 32 - Math.clz32(tokens - 1), TT = new Uint16Array(routeStates << K);
  rtrans.forEach((row, s) => row.forEach((t, k) => { TT[(s << K) + k] = t === -1 ? 0xffff : t; }));
  // ANY-only state: the state that loops forever on segment chars.
  const edges = (st) => { const m = new Map(); for (let k = 0; k < nc; k++) { const t = LT[st * nc + k]; if (t === -1) continue; if (!m.has(t)) m.set(t, { to: t, cs: [] }); for (let c = 0; c < ALPHA; c++) if (cls[c] === k) m.get(t).cs.push(c); } return [...m.values()]; };
  let generic = -1;
  for (let s = 0; s < c2.lexStates; s++) { const e = edges(s); if (e.length === 1 && e[0].to === s) generic = s; }
  const anyTok = LK[generic];
  let uid = 0, nodes = 0; const lines = [], out = (s) => lines.push(s);
  const P = (o) => (o ? `i+${o}` : "i");
  const fin = (t, pos) => `{t=${t};e=${pos};break L;}`;
  const cond = (v, cs) => {
    const rs = []; let a = -1, b = -1; const has = new Uint8Array(ALPHA); for (const c of cs) has[c] = 1;
    for (let c = 0; c < 128; c++) { if (has[c]) { if (a === -1) a = c; b = c; } else if (a !== -1) { rs.push([a, b]); a = -1; } }
    if (a !== -1) rs.push([a, b]);
    const ps = rs.map(([x, y]) => (x === y ? `${v}===${x}` : `(${v}>=${x}&&${v}<=${y})`));
    return ps.length === 1 ? ps[0] : `(${ps.join("||")})`;
  };
  // Literal/regex overlay tree. Falling off the bottom means "plain segment" -> generic scan.
  function gen(st, o, loopPos) {
    nodes++;
    if (st === generic) return;
    const es = edges(st), self = es.find((e) => e.to === st), rest = es.filter((e) => e !== self && e.to !== generic);
    const tk = LK[st], v = `c${uid++}`;
    if (self) {
      const j = `j${uid++}`;
      out(`let ${j}=${P(o)},${v}=0;while(${j}<n&&(${v}=s.charCodeAt(${j}),${cond(v, self.cs)}))${j}++;`);
      out(`if(${j}===n||${v}===47||${v}===63)${fin(tk, j)}`);
      return; // anything else in a loop state degrades to generic scan (prototype: no rest edges in this route set)
    }
    if (tk !== anyTok || st === lexStart) {
      out(`if(n===${P(o)}${tk !== 0 ? "" : ""})${tk === 0 ? `{t=0;e=${P(o)};break L;}` : fin(tk, P(o))}`);
      out(`const ${v}=s.charCodeAt(${P(o)});if(${v}===47||${v}===63)${fin(tk, P(o))}`);
    } else out(`if(n>${P(o)}){const ${v}=s.charCodeAt(${P(o)});`);
    rest.forEach((e, idx) => { out(`${idx ? "else " : ""}if(${cond(v, e.cs)}){`); gen(e.to, o + 1); out(`}`); });
    if (!(tk !== anyTok || st === lexStart)) out(`}`);
  }
  gen(lexStart, 0);
  const acc = [];
  racc.forEach((a, st) => {
    if (a === -1) return;
    const sp = specs[a];
    if (!sp.params.length) { acc.push(`case ${st}:return M[${sp.route}];`); return; }
    acc.push(`case ${st}:return {store:R[${sp.route}],params:{${sp.params.map(([nm, k]) => `${nm}:s.slice(A[${k}],B[${k}])`).join(",")}}};`);
  });
  const body = `const n=s.length;if(n===0||s.charCodeAt(0)!==47)return null;
let st=0,i=1,d=0,t=0,e=0;
for(;;){
L:{
${lines.join("\n")}
let j=i,c=0;while(j<n&&(c=s.charCodeAt(j))!==47&&c!==63)j++;t=${anyTok};e=j;
}
if(t===0&&e>i)return null;
st=TT[(st<<${K})+t];if(st===65535)return null;
A[d]=i;B[d]=e;d++;
if(e===n||s.charCodeAt(e)===63)break;
i=e+1;
}
switch(st){${acc.join("")}}
return null;`;
  const EMPTY = Object.freeze({}), M = stores.map((store) => Object.freeze({ store, params: EMPTY }));
  const f = new Function("R", "M", "TT", "A", "B", `"use strict";return function find(s){\n${body}\n}`)(stores, M, TT, new Int32Array(64), new Int32Array(64));
  f.meta = { atoms: c2.atoms, lexStates: c2.lexStates, tokens, routeStates, lexNodes: nodes, src: body.length, body };
  return f;
}

// --- Branch-minimal table engine ---------------------------------------------------------------------
// One predictable exit branch per char. No slash tracking: positions are recovered after the match
// from each pattern's known fixed widths, anchored from whichever end is cheaper.
function widthOf(ast) { // fixed width of a segment AST, or -1 if variable
  switch (ast.t) {
    case "set": return 1;
    case "cat": { let w = 0; for (const x of ast.xs) { const k = widthOf(x); if (k < 0) return -1; w += k; } return w; }
    case "alt": { const ws = ast.xs.map(widthOf); return ws.every((w) => w === ws[0]) ? ws[0] : -1; }
    case "rep": { if (ast.min !== ast.max) return -1; const w = widthOf(ast.x); return w < 0 ? -1 : w * ast.min; }
  }
}
function mayCross(ast) {
  if (ast.t === "set") return ast.set[SLASH] === 1;
  if (ast.t === "rep") return mayCross(ast.x);
  return ast.xs.some(mayCross);
}
export function extractor(path) {
  if (path === "/") return { code: "", names: [] };
  const segs = path.split("/").slice(1).map((seg) => {
    if (seg[0] !== ":") return { w: seg.length, name: null };
    const a = seg.indexOf("(");
    if (a === -1) return { w: -1, name: seg.slice(1) };
    const ast = parseRegex(seg.slice(a + 1, seg.lastIndexOf(")")));
    return { w: widthOf(ast), name: seg.slice(1, a), crosses: mayCross(ast) };
  });
  const tail = new Array(segs.length + 1).fill(0); // chars after seg k, or -1 if unknown
  for (let k = segs.length - 1; k >= 0; k--) tail[k] = k === segs.length - 1 ? 0 : (segs[k + 1].w < 0 || tail[k + 1] < 0 ? -1 : tail[k + 1] + 1 + segs[k + 1].w);
  let cur = "0", fixed = 0, lines = [], uid = 0; // cur + fixed = position of the slash before seg k
  const pos = (o) => (cur === "0" ? String(o) : o ? `${cur}+${o}` : cur);
  const fields = [];
  segs.forEach((sg, k) => {
    const start = pos(fixed + 1);
    let end;
    if (sg.w >= 0) end = pos(fixed + 1 + sg.w);
    else if (tail[k] >= 0) end = tail[k] ? `e-${tail[k]}` : "e";
    else { if (sg.crosses) throw new Error("needs tagged extraction: " + path); const v = `p${uid++}`; lines.push(`const ${v}=s.indexOf("/",${start});`); end = v; }
    if (sg.name) fields.push(`${sg.name}:s.slice(${start},${end})`);
    if (sg.w >= 0) fixed += 1 + sg.w;
    else { if (!/^[pe]/.test(end) || end.startsWith("e")) { const v = `p${uid++}`; lines.push(`const ${v}=${end};`); cur = v; } else cur = end; fixed = 0; }
  });
  return { code: `${lines.join("")}return {${fields.join(",")}};`, names: segs.filter((x) => x.name).map((x) => x.name) };
}

export function buildFast(dfa, stores, { train, direct = false, mode = "lazy", gallop = 0, after = 0, tail = false }) {
  const { nc, cls, T, A, start, states, specs, patterns } = dfa;
  // hot renumbering: states touched most sit next to each other in the table
  const visits = new Float64Array(states); visits[start] = 1e15;
  for (const u of train) {
    let st = start;
    for (let i = 0; i < u.length; i++) { const c = u.charCodeAt(i), nx = T[st * nc + cls[c < 128 ? c : OTHER]]; if (nx === -1) break; visits[nx]++; st = nx; }
  }
  const order = [...Array(states).keys()].sort((a, b) => visits[b] - visits[a]);
  const id = new Int32Array(states); order.forEach((s, i) => (id[s] = i));
  const isScan = new Uint8Array(states);
  if (gallop) for (let s = 0; s < states; s++) { // exactly a [^/?] self-loop
    let ok = true;
    for (let c = 0; c < ALPHA && ok; c++) { const t = T[s * nc + cls[c]]; ok = (c === SLASH || c === QMARK) ? t !== s : t === s; }
    isScan[s] = ok ? 1 : 0;
  }
  const nScan = isScan.reduce((x, y) => x + y, 0);
  const total = states + after * nScan;
  const DEAD = total, QUERY = total + 1, STOP = total, SCAN = total + 2;
  const chain = new Int32Array(states).fill(-1); let nextChain = states;
  if (after) for (let s = 0; s < states; s++) if (isScan[s]) { chain[s] = nextChain; nextChain += after; }
  const enc = (t) => (!isScan[t] ? id[t] : after ? chain[t] : SCAN + id[t]);
  const qCls = cls[QMARK];
  const stride = direct ? 129 : nc;
  const K = 32 - Math.clz32(stride - 1);
  const TT = 2 * total + 2 > 65535 ? new Uint32Array(total << K) : new Uint16Array(total << K);
  const CLS = new Uint8Array(cls);
  for (let s = 0; s < states; s++) {
    const row = id[s] << K;
    if (direct) for (let c = 0; c < 129; c++) { const t = T[s * nc + cls[c]]; TT[row + c] = c === QMARK ? (A[s] !== -1 ? QUERY : DEAD) : t === -1 ? DEAD : id[t]; }
    else for (let k = 0; k < nc; k++) { const t = T[s * nc + k]; TT[row + k] = k === qCls ? (A[s] !== -1 ? QUERY : DEAD) : t === -1 ? DEAD : enc(t); }
  }
  const ACC = new Int16Array(total).fill(-1);
  for (let s = 0; s < states; s++) ACC[id[s]] = A[s];
  if (after) for (let s = 0; s < states; s++) if (isScan[s]) for (let j = 0; j < after; j++) {
    const row = (chain[s] + j) << K; ACC[chain[s] + j] = A[s];
    for (let k = 0; k < nc; k++) {
      const t = T[s * nc + k];
      TT[row + k] = k === qCls ? (A[s] !== -1 ? QUERY : DEAD) : t === -1 ? DEAD : t === s ? (j + 1 < after ? chain[s] + j + 1 : SCAN + id[s]) : enc(t);
    }
  }
  const S0 = id[start];
  const EX = patterns.map((p) => new Function("s", "e", extractor(p.path).code));
  const HAS = Uint8Array.from(specs, (sp) => (sp.params.length ? 1 : 0));
  const R = specs.map((sp) => stores[sp.route]);
  const EMPTY = Object.freeze({});
  const M = R.map((store) => Object.freeze({ store, params: EMPTY }));
  class Match {
    constructor(store, url, a, e) { this.store = store; this.url = url; this.a = a; this.e = e; this.p = null; }
    get params() { return this.p ?? (this.p = EX[this.a](this.url, this.e)); }
  }
  const gal = gallop ? `for(;;){for(;i<n;i++){const c=s.charCodeAt(i);x=TT[(st<<${K})+CLS[c<128?c:128]];if(x>=${STOP})break;st=x;}if(i>=n||x<${SCAN})break;st=x-${SCAN};i=G(s,i+1,n);}` : null;
  const hotLoop = `for(;i<n;i++){const c=s.charCodeAt(i);x=TT[(st<<${K})+CLS[c<128?c:128]];if(x>=${STOP})break;st=x;}`;
  const scan = tail ? hotLoop + `if(x>=${SCAN})return S(s,i,n,x);` : gallop ? gal : direct
    ? `for(;i<n;i++){const c=s.charCodeAt(i);const x=TT[(st<<${K})+(c<128?c:128)];if(x>=${STOP})break;st=x;}`
    : `for(;i<n;i++){const c=s.charCodeAt(i);const x=TT[(st<<${K})+CLS[c<128?c:128]];if(x>=${STOP})break;st=x;}`;
  // after the loop: i===n => end of input; else x was DEAD or QUERY, which a '?' char distinguishes
  const finish = {
    lazy: `const a=ACC[st];if(a<0)return null;if(i<n&&s.charCodeAt(i)!==63)return null;return HAS[a]===0?M[a]:new Match(R[a],s,a,i);`,
    eager: `const a=ACC[st];if(a<0)return null;if(i<n&&s.charCodeAt(i)!==63)return null;return HAS[a]===0?M[a]:{store:R[a],params:EX[a](s,i)};`,
    index: `const a=ACC[st];if(a<0)return null;if(i<n&&s.charCodeAt(i)!==63)return null;return a;`,
  }[mode];
  const G = new Function("s", "i", "n", `"use strict";const l=i+${gallop}<n?i+${gallop}:n;for(;i<l;i++){const c=s.charCodeAt(i);if(c===47||c===63)return i;}if(i>=n)return n;let j=s.indexOf("/",i);if(j<0)j=n;const q=s.indexOf("?",i);return q>=0&&q<j?q:j;`);
  // Slow continuation: owns the outer loop, so the hot function stays a single flat loop.
  const S = new Function("TT", "CLS", "ACC", "HAS", "R", "M", "EX", "Match", "G",
    `"use strict";return function slow(s,i,n,x){let st=0;for(;;){st=x-${SCAN};i=G(s,i+1,n);x=0;${hotLoop}if(i>=n||x<${SCAN})break;}${finish}}`)(TT, CLS, ACC, HAS, R, M, EX, Match, G);
  const f = new Function("TT", "CLS", "ACC", "HAS", "R", "M", "EX", "Match", "G", "S",
    `"use strict";return function find(s){const n=s.length;let st=${S0},i=0,x=0;${scan}${finish}}`)(TT, CLS, ACC, HAS, R, M, EX, Match, G, S);
  f.meta = { states: total, classes: nc, tableKB: +(TT.byteLength / 1024).toFixed(1), scanStates: isScan.reduce((a, b) => a + b, 0) };
  return f;
}
