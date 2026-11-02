import { bench, measure, run } from "mitata";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildCorpus, injectNotFound } from "./corpus.mjs";
import { createExpress4, createExpress5 } from "./express.mjs";
import { createFindMyWay, createFindMyWayCompiled } from "./find-my-way.mjs";
import { createHonoPattern, createHonoTrie } from "./hono-routers.mjs";
import { createReference } from "./reference.mjs";
import { routes, precomputedUrls, routesSource, urlsSource } from "./routes.mjs";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const args = new Set(process.argv.slice(2));
const jsonOutput = args.has("--json");
const asyncMode = args.has("--async");
const readParams = args.has("--read-params");
const printUrls = args.has("--print-urls");
const internedStrings = args.has("--interned");
const corpusIndex = process.argv.indexOf("--corpus");
const corpusName = corpusIndex !== -1 ? process.argv[corpusIndex + 1] : "clean";
const notFoundIndex = process.argv.indexOf("--404-percent");
const notFoundPercent =
  notFoundIndex !== -1 ? Number(process.argv[notFoundIndex + 1]) : 0;
if (!(notFoundPercent >= 0 && notFoundPercent <= 100)) {
  throw new Error("[bench] --404-percent takes a number from 0 to 100");
}
const timeIndex = process.argv.indexOf("--time");
const timeArg = timeIndex !== -1 ? Number(process.argv[timeIndex + 1]) : null;
const benchTime = Number.isFinite(timeArg) && timeArg > 0 ? timeArg : 1000;
const onlyIndex = process.argv.indexOf("--only");
const onlyName = onlyIndex !== -1 ? process.argv[onlyIndex + 1] : null;
const seedIndex = process.argv.indexOf("--seed");
const seedArg = seedIndex !== -1 ? Number(process.argv[seedIndex + 1]) : null;
const seed =
  Number.isFinite(seedArg) && seedArg !== null ? seedArg : Date.now();
const routerPathIndex = process.argv.indexOf("--router");
const routerPath =
  routerPathIndex !== -1 ? process.argv[routerPathIndex + 1] : null;

function createRng(initial) {
  let value = initial >>> 0;
  return () => {
    value |= 0;
    value = (value + 0x6d2b79f5) | 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(array, rng) {
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function loadRouter() {
  if (routerPath) {
    const routerRequire = createRequire(resolve(routerPath));
    return routerRequire(routerPath);
  }
  return require(resolve(root, "dist", "index.js"));
}

const { createRouter } = loadRouter();
function logBuildError(name, error) {
  const message = error && error.stack ? error.stack : String(error);
  console.error(`[bench] ${name} setup failed:\n${message}`);
}
const requestCache = new Map();
function getRequest(method, path) {
  const key = `${method} ${path}`;
  let request = requestCache.get(key);
  if (!request) {
    request = new Request(`http://localhost${path}`, { method });
    requestCache.set(key, request);
  }
  return request;
}

const METHOD = "GET";
const WARMUP_ROUNDS = 50000;
const URL_SAMPLE_SIZE = 10;
const HIT_SAMPLE_SIZE = 100_000;
const HIT_RATE_TOLERANCE = 0.1;

// `--read-params` stores here, because a read that nothing uses could be optimized away.
let paramsSink = null;

function normalizeLookupPath(path) {
  if (!path) return "/";
  if (path.charCodeAt(0) === 47) return path;
  return `/${path}`;
}

const routeDefinitions = routes;

const defaultHandler = () => {};
const routeFixtures = routeDefinitions.map((route) => [
  METHOD,
  route.path,
  defaultHandler,
]);
// Drops param regexes, which these routers can't validate. A trailing `.+` becomes a wildcard,
// because it can cross `/` and a plain param can't.
function toFrameworkSafePath(path) {
  return path
    .replace(/:([A-Za-z0-9_]+)\(\.\+\)$/, ":$1*")
    .replace(/:([A-Za-z0-9_]+)\([^)]*\)/g, ":$1");
}
const frameworkPatternSet = new Set();
for (const route of routeDefinitions) {
  for (const concretePath of route.concretePaths) {
    frameworkPatternSet.add(toFrameworkSafePath(concretePath));
  }
}
const frameworkRouteFixtures = [...frameworkPatternSet].map((path) => [
  METHOD,
  path,
  defaultHandler,
]);

function validateRouteDefinitions(definitions) {
  const lowRng = () => 0.01;
  const highRng = () => 0.99;
  for (const route of definitions) {
    if (!Number.isInteger(route.count) || route.count < 0) {
      throw new Error(
        `[bench] Invalid count for route ${String(route.path)}: ${route.count}`,
      );
    }
    const matcher = createReference([route]);
    const variants = new Set();
    const rngs = [lowRng, highRng, createRng(seed ^ 0x17f12f3a)];
    for (const rng of rngs) {
      for (let i = 0; i < 32; i += 1) {
        const raw = route.generateUrl(rng);
        const normalized = normalizeLookupPath(raw);
        if (matcher(normalized, METHOD) === null) {
          throw new Error(
            `[bench] Generator produced non-matching URL for route ${String(route.path)}: ${raw}`,
          );
        }
        variants.add(raw);
      }
    }
    if (variants.size < 2) {
      throw new Error(
        `[bench] Route ${String(route.path)} must generate at least 2 variants`,
      );
    }
  }
}

function buildRequestCorpus(definitions, rng) {
  let total = 0;
  for (const route of definitions) total += route.count;
  const paths = new Array(total);
  const interned = new Map();
  let index = 0;
  for (const route of definitions) {
    for (let i = 0; i < route.count; i += 1) {
      const normalized = normalizeLookupPath(route.generateUrl(rng));
      const stable = interned.get(normalized);
      if (stable !== undefined) {
        paths[index] = stable;
      } else {
        interned.set(normalized, normalized);
        paths[index] = normalized;
      }
      index += 1;
    }
  }
  shuffle(paths, rng);
  return paths;
}

function createCorpusLookup(paths) {
  let index = 0;
  const size = paths.length;
  return () => {
    const path = paths[index];
    index += 1;
    if (index === size) index = 0;
    return [METHOD, path];
  };
}

validateRouteDefinitions(routeDefinitions);
const fullRequestCorpus = precomputedUrls
  ? precomputedUrls.map((path) => normalizeLookupPath(path))
  : buildRequestCorpus(routeDefinitions, createRng(seed ^ 0x0fedcba1));

// A copy gets a flat string that isn't internalized, as a request URL would be.
function toFreshString(path) {
  return Buffer.from(path, "latin1").toString("latin1");
}

function withInjectedNotFound(urls) {
  if (notFoundPercent === 0) return urls;
  const reference = createReference(routeDefinitions);
  return injectNotFound(
    urls,
    notFoundPercent,
    (url) => reference(url, METHOD) === null,
    createRng(seed ^ 0x2b7e1516),
  );
}

// near404 can drop a URL's leading `/`. It's restored here because the reference adds it back but
// medley rejects such a URL, so the routers would otherwise differ on URLs no client sends.
const replayCorpus = withInjectedNotFound(
  buildCorpus(corpusName, fullRequestCorpus),
).map((url) => {
  const path = normalizeLookupPath(url);
  return internedStrings ? path : toFreshString(path);
});

// Every lookup returns its match, or null, so that `--read-params` can reach `.params`.
function buildDfastRouter() {
  const router = createRouter();
  for (const [method, path, handler] of routeFixtures) {
    router.on(method, path, handler);
  }
  return {
    lookup: (method, path) => {
      return router.find(method, path);
    },
  };
}

function buildMedleyRouter() {
  try {
    const Router = require("@medley/router");
    const router = new Router();
    for (const [method, path, handler] of frameworkRouteFixtures) {
      const store = router.register(toMedleyPattern(path));
      store[method] = handler;
    }
    return {
      lookup: (method, path) => {
        const match = router.find(path);
        if (!match) return null;
        const handler = match.store[method] ?? match.store["*"] ?? null;
        return handler === null ? null : match;
      },
    };
  } catch (error) {
    logBuildError("@medley/router", error);
    return null;
  }
}

function buildPathToRegexpLinear() {
  try {
    const { match } = require("path-to-regexp");
    const entries = frameworkRouteFixtures.map(([method, path, handler]) => {
      return {
        method,
        handler,
        match: match(toPathToRegexpPattern(path), { decode: false }),
      };
    });
    return {
      lookup: (method, path) => {
        // Unlike the other routers, path-to-regexp matches the query string too.
        const query = path.indexOf("?");
        const target = query === -1 ? path : path.slice(0, query);
        for (let i = 0; i < entries.length; i += 1) {
          const entry = entries[i];
          // if (entry.method !== method && entry.method !== "*") continue;
          const match = entry.match(target);
          if (match) return match;
        }
        return null;
      },
    };
  } catch (error) {
    logBuildError("path-to-regexp-linear", error);
    return null;
  }
}

function createMockReqRes(method, path) {
  const { IncomingMessage, ServerResponse } = require("node:http");
  const { PassThrough } = require("node:stream");
  const socket = new PassThrough();
  socket.destroyed = false;
  socket.setTimeout = () => {};
  socket.destroy = () => {};
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = path;
  const res = new ServerResponse(req);
  res.assignSocket(socket);
  return { req, res };
}

function toPathToRegexpPattern(path) {
  if (path.includes(":")) {
    return path.replace(/:([A-Za-z0-9_]+)\*/g, "*$1");
  }
  return path;
}

function toMedleyPattern(path) {
  return path.replace(/:([A-Za-z0-9_]+)\*/g, "*");
}

function calculateRme(samples) {
  if (!samples || samples.length < 2) return 0;
  const n = samples.length;
  const mean = samples.reduce((sum, value) => sum + value, 0) / n;
  if (mean === 0) return 0;
  const variance =
    samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1);
  const standardError = Math.sqrt(variance) / Math.sqrt(n);
  const margin = 1.96 * standardError;
  return (margin / mean) * 100;
}

const percentOf = (count, total) => (100 * count) / total;

// Compares each router with the reference URL by URL, because over-matching could otherwise hide
// under-matching in the totals. Only under-matching fails the run: medley can't validate param
// regexes, so it's expected to over-match.
function measureHitRates(routers) {
  const rates = new Map();
  if (routers.length === 0) return rates;

  // A prefix, not a stride: near404 cycles through its mutations by index, so a stride can land on
  // one mutation only. The corpora are in random order, so a prefix isn't biased.
  const sample = replayCorpus.slice(0, HIT_SAMPLE_SIZE);
  const reference = createReference(routeDefinitions);
  const expected = sample.map((path) => reference(path, METHOD) !== null);
  const referenceHits = expected.filter(Boolean).length;

  for (const [name, { lookup }] of routers) {
    let overMatched = 0;
    let underMatched = 0;
    for (let i = 0; i < sample.length; i += 1) {
      const hit = lookup(METHOD, sample[i]) !== null;
      if (hit && !expected[i]) overMatched += 1;
      if (!hit && expected[i]) underMatched += 1;
    }
    const rate = {
      hitRate: percentOf(
        referenceHits + overMatched - underMatched,
        sample.length,
      ),
      referenceHitRate: percentOf(referenceHits, sample.length),
      overMatch: percentOf(overMatched, sample.length),
      underMatch: percentOf(underMatched, sample.length),
    };
    rates.set(name, rate);
    console.error(
      `[bench] ${name}: hit rate ${rate.hitRate.toFixed(2)}%, reference ${rate.referenceHitRate.toFixed(2)}%, ` +
        `over-matched ${rate.overMatch.toFixed(2)} points, under-matched ${rate.underMatch.toFixed(2)} points ` +
        `(${corpusName} corpus, ${sample.length} URLs)`,
    );
  }

  const failed = [...rates].filter(
    ([, rate]) => rate.underMatch > HIT_RATE_TOLERANCE,
  );
  if (failed.length > 0) {
    const names = failed.map(([name]) => name).join(", ");
    throw new Error(
      `[bench] More than ${HIT_RATE_TOLERANCE} points below the reference: ${names}`,
    );
  }
  return rates;
}

function createBenchLookup({ lookup, framework }) {
  const nextLookup = createCorpusLookup(replayCorpus);
  if (asyncMode) {
    return async () => {
      const [method, path] = nextLookup();
      const match = framework
        ? await lookup(method, path, getRequest(method, path))
        : await lookup(method, path);
      if (readParams && match !== null) paramsSink = match.params;
    };
  }
  if (readParams) {
    return () => {
      const [method, path] = nextLookup();
      const match = lookup(method, path);
      if (match !== null) paramsSink = match.params;
    };
  }
  return () => {
    const [method, path] = nextLookup();
    lookup(method, path);
  };
}

async function warmUp(benchLookup) {
  for (let i = 0; i < WARMUP_ROUNDS; i += 1) {
    if (asyncMode) {
      await benchLookup();
    } else {
      benchLookup();
    }
  }
}

async function runBenchmarks() {
  const results = [];

  const routerBuilders = [
    ["dfast-router", () => buildDfastRouter()],
    ["@medley/router", () => buildMedleyRouter()],
    ["path-to-regexp-linear", () => buildPathToRegexpLinear()],
    ["express@4", () => createExpress4(routeDefinitions)],
    ["express@5", () => createExpress5(routeDefinitions)],
    ["find-my-way", () => createFindMyWay(routeDefinitions)],
    ["find-my-way-compiled", () => createFindMyWayCompiled(routeDefinitions)],
    ["hono-trie", () => createHonoTrie(routeDefinitions)],
    ["hono-pattern", () => createHonoPattern(routeDefinitions)],
  ];

  const routers = [];
  for (const [name, build] of routerBuilders) {
    if (onlyName && name !== onlyName) continue;
    let entry = null;
    try {
      entry = await build();
    } catch (error) {
      logBuildError(name, error);
      continue;
    }
    if (!entry) continue;
    routers.push([name, entry]);
  }

  const hitRates = measureHitRates(routers);

  if (!jsonOutput) {
    for (const [name, routerEntry] of routers) {
      const benchLookup = createBenchLookup(routerEntry);
      await warmUp(benchLookup);
      bench(name, async function* () {
        yield benchLookup;
      });
    }
    // mitata colors by default, which would put escape codes in a pipe or a file.
    await run({ format: "mitata", colors: process.stdout.isTTY === true });
    return null;
  }

  for (const [name, routerEntry] of routers) {
    const benchLookup = createBenchLookup(routerEntry);
    await warmUp(benchLookup);
    const stats = await measure(
      async function* () {
        yield benchLookup;
      },
      { min_cpu_time: benchTime * 1e6 },
    );

    const hz = stats.avg > 0 ? 1e9 / stats.avg : 0;
    const samples = stats.samples ?? [];
    results.push({
      name,
      hz,
      samples: samples.length,
      rme: calculateRme(samples),
      ...hitRates.get(name),
    });
  }

  return results.sort((a, b) => a.hz - b.hz);
}

// On stderr, so that `--json` output stays valid.
function logCorpus() {
  console.error(`[bench] routes: ${routesSource} (${routes.length} routes)`);
  const injected = notFoundPercent > 0 ? `, ${notFoundPercent}% replaced with 404s` : "";
  console.error(
    `[bench] urls: ${urlsSource}, ${corpusName} corpus${injected}, ${replayCorpus.length.toLocaleString()} lookups`,
  );
  console.error(`[bench] first ${URL_SAMPLE_SIZE} urls:`);
  for (const url of replayCorpus.slice(0, URL_SAMPLE_SIZE)) console.error(`[bench]   ${url}`);
}

if (printUrls) {
  // `| head` closes the pipe early, which isn't a failure.
  process.stdout.on("error", (error) => {
    if (error.code !== "EPIPE") throw error;
  });
  console.log(replayCorpus.join("\n"));
} else {
  logCorpus();
  await report();
}

async function report() {
  const results = await runBenchmarks();
  if (jsonOutput) {
    console.log(
      JSON.stringify(
        { results, seed, corpus: corpusName, notFoundPercent, readParams },
        null,
        2,
      ),
    );
  } else if (results) {
    for (const result of results) {
      console.log(
        `${result.name}: ${Math.round(result.hz).toLocaleString()} ops/sec (samples: ${result.samples}, rme: ${result.rme.toFixed(2)}%)`,
      );
    }
  }
}
