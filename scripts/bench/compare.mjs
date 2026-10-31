import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const tscPath = resolve(root, 'node_modules', 'typescript', 'bin', 'tsc');
const typeRoots = resolve(root, 'node_modules', '@types');
const compareTime = Number(process.env.BENCH_COMPARE_TIME || 5000);
const compareRuns = Number(process.env.BENCH_COMPARE_RUNS || 3);
// Anything else on the command line goes to bench.mjs: `npm run bench:compare -- --corpus near404`.
const benchArgs = process.argv.slice(2);
const baselineRouter = '@medley/router';
const routerNames = [
  'balancing-router',
  baselineRouter,
  'path-to-regexp-linear',
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  return result;
}

function getPreviousIndex() {
  const result = run('git', ['show', 'HEAD~1:src/index.ts'], { cwd: root });
  if (result.status !== 0) return null;
  return result.stdout;
}

function buildRouter(projectDir, outDir) {
  // The previous commit's worktree has no node_modules, so its types come from this one.
  const result = run(process.execPath, [
    tscPath,
    '-p',
    'tsconfig.json',
    '--outDir',
    outDir,
    '--typeRoots',
    typeRoots,
  ], { cwd: projectDir });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'TypeScript build failed');
  }
  return resolve(outDir, 'index.js');
}

function runBench(routerPath, routerName, runSeed) {
  const args = [
    'bench/bench.mjs',
    '--json',
    '--only',
    routerName,
    '--time',
    String(compareTime),
    '--seed',
    String(runSeed),
    ...benchArgs,
  ];
  if (routerPath) {
    args.push('--router', routerPath);
  }
  const result = run('node', args, { cwd: root });
  if (result.status !== 0) {
    throw new Error(result.stderr || 'Benchmark failed');
  }
  return JSON.parse(result.stdout);
}

// Each router gets its own process, so one router's type feedback can't slow down the next.
function bestOfRuns(routerPath) {
  const bestByName = new Map();
  for (let runIndex = 0; runIndex < compareRuns; runIndex += 1) {
    const runSeed = seed + runIndex;
    for (const routerName of routerNames) {
      const runResult = runBench(routerPath, routerName, runSeed);
      for (const entry of runResult.results) {
        const best = bestByName.get(entry.name);
        if (!best || entry.hz > best.hz) {
          bestByName.set(entry.name, entry);
        }
      }
    }
  }
  return { results: [...bestByName.values()] };
}

function formatDelta(current, previous) {
  if (previous === 0) return 'n/a';
  const delta = ((current - previous) / previous) * 100;
  const sign = delta >= 0 ? '+' : '';
  return `${sign}${delta.toFixed(1)}%`;
}

function formatRatio(entry, baseline) {
  if (!baseline || baseline.hz === 0) return `no ${baselineRouter} result`;
  return `${(entry.hz / baseline.hz).toFixed(2)}x ${baselineRouter}`;
}

function printResults(current, previous) {
  const currentMap = new Map(current.results.map((entry) => [entry.name, entry]));
  const previousMap = new Map(previous?.results.map((entry) => [entry.name, entry]));
  const baseline = currentMap.get(baselineRouter);

  for (const name of routerNames) {
    const entry = currentMap.get(name);
    if (!entry) {
      console.log(`- ${name}: skipped, no result`);
      continue;
    }
    const prev = previousMap.get(name);
    const vsPrevious = prev
      ? `prev ${Math.round(prev.hz)}; ${formatDelta(entry.hz, prev.hz)}`
      : 'no previous baseline';
    console.log(
      `- ${name}: ${Math.round(entry.hz)} ops/sec (${vsPrevious}), ${formatRatio(entry, baseline)}, hit rate ${entry.hitRate.toFixed(2)}%`,
    );
  }
}

const previousIndex = getPreviousIndex();
const seed = process.env.BENCH_SEED ? Number(process.env.BENCH_SEED) : Date.now();
if (!previousIndex) {
  console.log('No previous commit found. Running current benchmarks only.');
  printResults(bestOfRuns());
  process.exit(0);
}

const tmpDir = mkdtempSync(join(tmpdir(), 'balancing-router-'));
const previousWorktree = resolve(tmpDir, 'prev-tree');
let worktreeAdded = false;

try {
  const addResult = run('git', ['worktree', 'add', '--detach', previousWorktree, 'HEAD~1'], { cwd: root });
  if (addResult.status !== 0) {
    throw new Error(addResult.stderr || addResult.stdout || 'Failed to create temporary worktree');
  }
  worktreeAdded = true;

  const previousPath = buildRouter(previousWorktree, resolve(tmpDir, 'prev-dist'));
  const currentPath = buildRouter(root, resolve(tmpDir, 'current-dist'));

  const current = bestOfRuns(currentPath);
  const previous = bestOfRuns(previousPath);

  console.log(`Benchmark comparison (best of ${compareRuns}, ${compareTime}ms each, current vs previous):`);
  printResults(current, previous);
} finally {
  if (worktreeAdded) {
    run('git', ['worktree', 'remove', '--force', previousWorktree], { cwd: root });
  }
}
