// A slow, independent model of the router's behaviour: one JS RegExp per route variant, scanned in
// priority order. It imports nothing from src/, so it can't share a bug with the router.
//
// createReference(routes) returns (url, method = "GET") => { route, params } | null.
//
//   route.concretePaths  Patterns to register. Strings use the full route syntax; a RegExp is a raw
//                        regex route.
//   route.method         Optional method or array of methods. Defaults to "GET".
//
// `route` in the result is the index of the route in `routes`.
//
// Priority: pattern routes for the method, pattern routes for "*", regex routes for the method, then
// regex routes for "*". The first tier with a match wins. Pattern tiers compare segment scores left
// to right, and regex tiers go by registration order. Earlier registration wins every tie.
//
// Two rules PLAN.md doesn't spell out:
//   - When one rank is shorter, its missing entries count as 0. A wildcard's empty match keeps the
//     wildcard's -100, so `/files` beats the empty match of `/files/:path*` in either order.
//   - A wildcard's rest may be empty after the slash: `/files/` gives `{ path: "" }`.

const SCORE = { static: 100, regex: 10, param: 0, wildcard: -100 };

const ALIASES = new Map([
  ["int", { source: "[0-9]+", score: 40 }],
  ["uuid", { source: "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", score: 35 }],
  ["locale", { source: "[a-z]{2}-[A-Z]{2}", score: 30 }],
  ["alpha", { source: "[A-Za-z]+", score: 25 }],
  ["slug", { source: "[A-Za-z0-9-]+", score: 20 }],
]);

const escapeLiteral = (text) => text.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");

function normalizeMethod(method) {
  const value = String(method ?? "*").trim().toUpperCase();
  return value === "" ? "*" : value;
}

function normalizePattern(path) {
  if (path === "") return "/";
  return path[0] === "/" ? path : `/${path}`;
}

// Cuts at `?`, then applies the same normalization as patterns.
function toPath(url) {
  const query = url.indexOf("?");
  return normalizePattern(query === -1 ? url : url.slice(0, query));
}

// Splits on `/`, except inside the regex of a `:name(...)` segment, where `[^/]` must stay whole.
function splitSegments(path) {
  const segments = [];
  let start = 1;
  let depth = 0;
  let inClass = false;
  for (let i = 1; i < path.length; i += 1) {
    const c = path[i];
    if (c === "/" && depth === 0 && !inClass) {
      segments.push(path.slice(start, i));
      start = i + 1;
    } else if (path[start] !== ":") continue;
    else if (c === "\\") i += 1;
    else if (inClass) inClass = c !== "]";
    else if (c === "[") inClass = true;
    else if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
  }
  segments.push(path.slice(start));
  return segments;
}

function parseParam(raw) {
  const optional = raw.endsWith("?");
  const body = raw.slice(1, optional ? -1 : undefined);
  if (body.endsWith("*")) return { kind: "wildcard", name: body.slice(0, -1) };

  const nameEnd = body.search(/[(#]/);
  if (nameEnd === -1) {
    return { kind: "param", name: body, source: "[^/]+", score: SCORE.param, optional };
  }
  const name = body.slice(0, nameEnd);
  if (body[nameEnd] === "(") {
    const source = body.slice(nameEnd + 1, body.lastIndexOf(")"));
    return { kind: "param", name, source, score: SCORE.regex, optional };
  }
  const alias = body.slice(nameEnd + 1);
  const known = ALIASES.get(alias);
  if (!known) throw new Error(`Unknown validator alias: #${alias}`);
  return { kind: "param", name, source: known.source, score: known.score, optional };
}

// One pattern to its variants, each a segment list. An optional adds its shorter variant first, the
// same order bench/routes-generic.mjs uses, which matters when two variants of a route tie.
function expandPattern(pattern) {
  let variants = [[]];
  for (const raw of splitSegments(normalizePattern(pattern))) {
    if (raw === "*") {
      variants = variants.map((v) => [...v, { kind: "wildcard", name: "*" }]);
      break;
    }
    if (raw[0] === "(" && raw.endsWith(")")) {
      const choices = raw.slice(1, -1).split("|");
      variants = variants.flatMap((v) => choices.map((value) => [...v, { kind: "static", value }]));
      continue;
    }
    const segment = raw[0] === ":" ? parseParam(raw) : { kind: "static", value: raw };
    if (segment.optional) variants = variants.flatMap((v) => [v, [...v, segment]]);
    else variants = variants.map((v) => [...v, segment]);
    if (segment.kind === "wildcard") break;
  }
  return variants;
}

function compileVariant(variant, route) {
  // A route with every segment optional still matches the root.
  const segments = variant.length > 0 ? variant : [{ kind: "static", value: "" }];
  const names = [];
  const rank = [];
  let source = "^";
  for (const segment of segments) {
    if (segment.kind === "static") {
      source += `/${escapeLiteral(segment.value)}`;
      rank.push(SCORE.static);
      continue;
    }
    // Groups are named so a capture inside a param's regex can't shift the numbering.
    const group = `__ref${names.length}`;
    names.push(segment.name);
    if (segment.kind === "param") {
      source += `/(?<${group}>${segment.source})`;
      rank.push(segment.score);
    } else {
      source += `(?:/(?<${group}>[^?]*))?`;
      rank.push(SCORE.wildcard);
    }
  }
  const regex = new RegExp(`${source}$`);
  const match = (path) => {
    const found = regex.exec(path);
    if (found === null) return null;
    const params = {};
    names.forEach((name, i) => {
      params[name] = found.groups[`__ref${i}`] ?? "";
    });
    return params;
  };
  return { route, rank, match };
}

function compileRegex(original, route) {
  // Without `g` and `y`, because they make a shared RegExp stateful.
  const regex = new RegExp(original.source, original.flags.replace(/[gy]/g, ""));
  const match = (path) => {
    const found = regex.exec(path);
    if (found === null) return null;
    const params = {};
    for (const [name, value] of Object.entries(found.groups ?? {})) {
      if (value !== undefined) params[name] = value;
    }
    return params;
  };
  return { route, match };
}

function compareRank(a, b) {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const difference = (b[i] ?? 0) - (a[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function addTo(table, method, entries) {
  const list = table.get(method);
  if (list) list.push(...entries);
  else table.set(method, [...entries]);
}

export function createReference(routes) {
  const patterns = new Map();
  const regexes = new Map();

  routes.forEach((route, id) => {
    const methods = new Set([route.method ?? "GET"].flat().map(normalizeMethod));
    for (const path of route.concretePaths) {
      const isRegex = path instanceof RegExp;
      const entries = isRegex
        ? [compileRegex(path, id)]
        : expandPattern(path).map((variant) => compileVariant(variant, id));
      for (const method of methods) addTo(isRegex ? regexes : patterns, method, entries);
    }
  });

  // The sort is stable, so ties stay in registration order and the first match is the best match.
  for (const entries of patterns.values()) entries.sort((a, b) => compareRank(a.rank, b.rank));

  const tiersFor = (method) => {
    const names = method === "*" ? ["*"] : [method, "*"];
    return [...names.map((m) => patterns.get(m)), ...names.map((m) => regexes.get(m))].filter(Boolean);
  };
  const tiersByMethod = new Map();
  for (const method of [...patterns.keys(), ...regexes.keys()]) tiersByMethod.set(method, tiersFor(method));
  const otherMethods = tiersFor("*");

  return (url, method = "GET") => {
    const path = toPath(url);
    const tiers = tiersByMethod.get(normalizeMethod(method)) ?? otherMethods;
    for (const tier of tiers) {
      for (const entry of tier) {
        const params = entry.match(path);
        if (params !== null) return { route: entry.route, params };
      }
    }
    return null;
  };
}
