// Port of honojs/hono benchmarks/routers/src/bench.mts, with dfast-router added.
// Run with `npm run bench:hono` (builds first).
//
// By default this is Hono's run, unchanged, so its numbers line up with Hono's. It only adds a
// check of what each router found, and warns about the routers that got it wrong.
//
// `--strict` fixes how the numbers are measured (see README.md):
// - one process per router, so routers don't share JIT feedback or warm each other up;
// - no `async` wrapper, which mitata would await on every iteration;
// - every result goes to `do_not_optimize`, so V8 can't drop work nobody reads;
// - each lookup gets a fresh, non-interned copy of its path, made before timing;
// - `--time <ms>` per URL (default 1000), and `--expose-gc` so mitata collects after warmup;
// - the rou3 and trek-router adapters are fixed, and a wrong match fails the run.
//
// `--strict --runs <n>` runs each router n times, interleaved, and reports each router's median.
// `--strict --only <router>` runs one router in this process, and `--json` prints its results.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { run, bench, group, summary, measure, do_not_optimize } from "mitata";
import { takeFlag, takeNumberFlag, takeSwitch } from "../flags.mjs";
import { checkRouters } from "./check.mjs";
import { dfastRouter, dfastRouterUnread } from "./dfast-router.mjs";
import { expressRouter } from "./express.mjs";
import { findMyWayRouter } from "./find-my-way.mjs";
import { regExpRouter, trieRouter, patternRouter } from "./hono.mjs";
import { koaRouter } from "./koa-router.mjs";
import { koaTreeRouter } from "./koa-tree-router.mjs";
import { medleyRouter } from "./medley-router.mjs";
import { memoiristRouter } from "./memoirist.mjs";
import { radix3Router } from "./radix3.mjs";
import { rou3Router, rou3RouterFixed } from "./rou3.mjs";
import { benchRoutes as routes } from "./tool.mjs";
import { trekRouter, trekRouterFixed } from "./trek-router.mjs";

const strict = takeSwitch("--strict");
const only = takeFlag("--only");
const jsonOutput = takeSwitch("--json");
const runCount = takeNumberFlag("--runs", 1);
const timeArg = takeFlag("--time");
const benchTime = timeArg === undefined ? 1000 : Number(timeArg);
if (!strict && (only !== undefined || jsonOutput || timeArg !== undefined || runCount !== 1)) {
  throw new Error("[bench:hono] --only, --json, --time and --runs need --strict. The default run is Hono's.");
}
if (!(Number.isInteger(runCount) && runCount > 0)) throw new Error("[bench:hono] --runs takes a whole number");
if (!(benchTime > 0)) throw new Error("[bench:hono] --time takes a number of milliseconds");

const routers = [
  dfastRouter,
  dfastRouterUnread,
  regExpRouter,
  trieRouter,
  patternRouter,
  medleyRouter,
  findMyWayRouter,
  koaTreeRouter,
  strict ? trekRouterFixed : trekRouter,
  expressRouter,
  koaRouter,
  radix3Router,
  memoiristRouter,
  strict ? rou3RouterFixed : rou3Router,
];

const failures = checkRouters(routers);
if (failures.length > 0) {
  const lines = failures.map((line) => `[bench:hono]   ${line}`).join("\n");
  if (strict) throw new Error(`[bench:hono] wrong matches:\n${lines}`);
  console.error(`[bench:hono] these routers don't match as they should, as in Hono's suite:\n${lines}`);
  console.error("[bench:hono] --strict fixes the rou3 and trek-router adapters.\n");
}

// Hono's bench.mts as it is.
async function runHono() {
  medleyRouter.match({ method: "GET", path: "/user" });

  for (const route of routes) {
    summary(() => {
      group(`${route.name} - ${route.method} ${route.path}`, () => {
        for (const router of routers) {
          bench(router.name, async () => {
            router.match(route);
          });
        }
      });
    });
  }

  group("all together", () => {
    summary(() => {
      for (const router of routers) {
        bench(router.name, async () => {
          for (const route of routes) {
            router.match(route);
          }
        });
      }
    });
  });

  await run();
}

// A copy the engine hasn't interned, as a path read off a socket would be.
const freshString = (path) => Buffer.from(path, "latin1").toString("latin1");
const freshRoute = ({ method, path }) => ({ method, path: freshString(path) });

// Lookups cycle through POOL_SIZE fresh copies of their input, so no two in a row get the same
// string, and V8 can't treat the input as a loop constant. mitata's computed params do the same,
// but cost about 15ns a lookup to this pool's 3ns, which would hide differences between routers.
const POOL_SIZE = 64;
const pool = (make) => Array.from({ length: POOL_SIZE }, make);

const groupName = (route) => `${route.name} - ${route.method} ${route.path}`;
const ALL_TOGETHER = "all together";

function summarize(stats) {
  const samples = stats.samples ?? [];
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (samples.length - 1);
  const rme = mean > 0 ? ((1.96 * Math.sqrt(variance / samples.length)) / mean) * 100 : 0;
  return { avg: stats.avg, p75: stats.p75, p99: stats.p99, samples: samples.length, rme };
}

async function runOne(name) {
  const router = routers.find((candidate) => candidate.name === name);
  if (!router) {
    throw new Error(`[bench:hono] no router "${name}". Routers: ${routers.map((r) => r.name).join(", ")}`);
  }
  const match = router.match;
  // Garbage collection runs once after warmup, since each process has `--expose-gc`. Not before
  // each batch (mitata's `inner_gc`): that leaves out the cost of a router's garbage, which is
  // part of what it costs, and it made Express take 8 minutes.
  const options = { min_cpu_time: benchTime * 1e6 };

  const results = [];
  for (const route of routes) {
    const requests = pool(() => freshRoute(route));
    let next = 0;
    const stats = await measure(function* () {
      yield () => do_not_optimize(match(requests[next++ & (POOL_SIZE - 1)]));
    }, options);
    results.push({ group: groupName(route), ...summarize(stats) });
  }
  const sets = pool(() => routes.map(freshRoute));
  let next = 0;
  const stats = await measure(function* () {
    yield () => {
      const requests = sets[next++ & (POOL_SIZE - 1)];
      for (let i = 0; i < requests.length; i += 1) do_not_optimize(match(requests[i]));
    };
  }, options);
  results.push({ group: ALL_TOGETHER, ...summarize(stats) });

  if (jsonOutput) console.log(JSON.stringify({ name, results }));
  else printTable([{ name, results }]);
}

function runEachRouter() {
  const script = fileURLToPath(import.meta.url);
  // Rounds go through every router before the next starts, so drift on the machine is shared out.
  const byRouter = new Map(routers.map((router) => [router.name, []]));
  for (let round = 1; round <= runCount; round += 1) {
    for (const router of routers) {
      console.error(`[bench:hono] ${runCount > 1 ? `run ${round}/${runCount}: ` : ""}${router.name}`);
      const child = spawnSync(
        process.execPath,
        ["--expose-gc", script, "--strict", "--only", router.name, "--json", "--time", String(benchTime)],
        { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
      );
      if (child.status !== 0) throw new Error(`[bench:hono] ${router.name} failed`);
      byRouter.get(router.name).push(JSON.parse(child.stdout).results);
    }
  }
  const runs = [...byRouter].map(([name, rounds]) => ({ name, results: medianResults(rounds) }));
  if (jsonOutput) console.log(JSON.stringify(runs, null, 2));
  else printTable(runs);
}

// Per group, the round with the median average, so its p99 and rme come from the same run.
function medianResults(rounds) {
  return rounds[0].map((_, index) => {
    const sorted = rounds.map((results) => results[index]).sort((a, b) => a.avg - b.avg);
    return sorted[(sorted.length - 1) >> 1];
  });
}

function formatTime(ns) {
  if (ns >= 1e6) return `${(ns / 1e6).toFixed(2)} ms`;
  if (ns >= 1e3) return `${(ns / 1e3).toFixed(2)} µs`;
  return `${ns.toFixed(2)} ns`;
}

function printTable(runs) {
  const groups = [...routes.map(groupName), ALL_TOGETHER];
  const width = Math.max(...runs.map((r) => r.name.length));
  for (const name of groups) {
    const rows = runs
      .map((r) => ({ name: r.name, ...r.results.find((result) => result.group === name) }))
      .sort((a, b) => a.avg - b.avg);
    console.log(`\n• ${name}`);
    console.log(`${"router".padEnd(width)}  ${"avg".padStart(10)}  ${"p99".padStart(10)}  ${"rme".padStart(7)}  vs fastest`);
    for (const row of rows) {
      const ratio = row.avg / rows[0].avg;
      console.log(
        `${row.name.padEnd(width)}  ${formatTime(row.avg).padStart(10)}  ${formatTime(row.p99).padStart(10)}  ${`±${row.rme.toFixed(2)}%`.padStart(7)}  ${ratio === 1 ? "fastest" : `${ratio.toFixed(2)}x slower`}`,
      );
    }
  }
}

// Last, so the helpers above are initialised before anything runs.
if (!strict) await runHono();
else if (only === undefined) runEachRouter();
else await runOne(only);
