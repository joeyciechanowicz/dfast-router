import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Each take* removes its flag from process.argv, so a script can read what's left as positional
// arguments, or pass it on to another script.

export function takeFlag(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const [, value] = process.argv.splice(index, 2);
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`[bench] ${name} needs a value`);
  }
  return value;
}

export function takeNumberFlag(name, fallback) {
  const value = takeFlag(name);
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`[bench] ${name} takes a number, not "${value}"`);
  return number;
}

export function takeSwitch(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return false;
  process.argv.splice(index, 1);
  return true;
}

const benchDir = dirname(fileURLToPath(import.meta.url));

// `specific` is bench/routes-specific.mjs. Anything with a slash or an extension is a path.
export function findRoutesFile(routeSet) {
  if (routeSet.includes("/") || routeSet.endsWith(".mjs")) {
    return resolve(process.cwd(), routeSet);
  }
  return resolve(benchDir, `routes-${routeSet}.mjs`);
}

export function siblingUrlsFile(routesFile) {
  return routesFile.replace(/\.mjs$/, ".urls.mjs");
}
