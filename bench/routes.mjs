import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findRoutesFile, siblingUrlsFile, takeFlag } from "./flags.mjs";

function displayPath(file) {
  return relative(process.cwd(), file);
}

async function importFile(file) {
  if (!existsSync(file)) throw new Error(`[bench] ${displayPath(file)} does not exist`);
  return import(pathToFileURL(file).href);
}

// Everything that imports this module gets the route set picked by `--routes`.
const routesFile = findRoutesFile(takeFlag("--routes") ?? "generic");
const urlsFlag = takeFlag("--urls");
const routesModule = await importFile(routesFile);
if (!Array.isArray(routesModule.routes)) {
  throw new Error(`[bench] ${displayPath(routesFile)} has no exported "routes" array`);
}

// A route set's URLs sit next to it. Another set's URLs would miss most routes and still pass the
// hit rate check, because the reference runs on the same URLs. Only `--urls` overrides this.
function findUrlsFile() {
  if (urlsFlag) return resolve(process.cwd(), urlsFlag);
  const sibling = siblingUrlsFile(routesFile);
  return existsSync(sibling) ? sibling : null;
}

const urlsFile = findUrlsFile();
const urlsModule = urlsFile ? await importFile(urlsFile) : routesModule;
if (urlsFile && !Array.isArray(urlsModule.precomputedUrls)) {
  throw new Error(`[bench] ${displayPath(urlsFile)} has no exported "precomputedUrls" array`);
}

export const routesSource = displayPath(routesFile);
export const routes = routesModule.routes;
const notFoundProbability = 0.05;
const precomputedSourceUrls = urlsModule.precomputedUrls;

function findUrlsSource() {
  if (!Array.isArray(precomputedSourceUrls)) return "generated from the routes";
  return displayPath(urlsFile ?? routesFile);
}

export const urlsSource = findUrlsSource();

function normalizePathLike(path) {
  if (!path) return "/";
  return path.charCodeAt(0) === 47 ? path : `/${path}`;
}

function hash32(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function shouldInjectNotFound(index, path) {
  const key = `${index}:${path}`;
  const threshold = Math.floor(notFoundProbability * 0x100000000);
  return hash32(key) < threshold;
}

function toNotFoundVariant(path) {
  if (path === "/") return "/__404__";
  return `/__404__${path}`;
}

function injectNotFoundUrls(urls) {
  const next = new Array(urls.length);
  for (let i = 0; i < urls.length; i += 1) {
    const original = normalizePathLike(urls[i]);
    next[i] = shouldInjectNotFound(i, original) ? toNotFoundVariant(original) : original;
  }
  return next;
}

export const precomputedUrls = Array.isArray(precomputedSourceUrls)
  ? injectNotFoundUrls(precomputedSourceUrls)
  : precomputedSourceUrls;
