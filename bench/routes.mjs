import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { routes as genericRoutes, precomputedUrls as genericPrecomputedUrls } from "./routes-generic.mjs";

export const availableRouteSets = ["generic", "module"];

const localRoutesModule = process.env.BENCH_ROUTES_MODULE;
const localPrecomputedUrlsModule = process.env.BENCH_PRECOMPUTED_URLS_MODULE;
let moduleRoutes = null;
let modulePrecomputedUrls = null;

if (localRoutesModule) {
  const moduleUrl = localRoutesModule.startsWith(".") || localRoutesModule.startsWith("/")
    ? pathToFileURL(resolve(process.cwd(), localRoutesModule)).href
    : localRoutesModule;
  try {
    const module = await import(moduleUrl);
    if (Array.isArray(module.routes)) {
      moduleRoutes = module.routes;
      if (Array.isArray(module.precomputedUrls)) {
        modulePrecomputedUrls = module.precomputedUrls;
      }
    } else {
      console.warn(
        `[bench] BENCH_ROUTES_MODULE="${localRoutesModule}" has no exported "routes" array. Falling back to generic routes.`,
      );
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.warn(
      `[bench] Failed to load BENCH_ROUTES_MODULE="${localRoutesModule}": ${message}. Falling back to generic routes.`,
    );
  }
} else if (process.env.BENCH_ROUTE_SET && process.env.BENCH_ROUTE_SET !== "generic") {
  console.warn(
    `[bench] BENCH_ROUTE_SET is deprecated. Use BENCH_ROUTES_MODULE to load a local routes module.`,
  );
}

if (localPrecomputedUrlsModule) {
  const moduleUrl =
    localPrecomputedUrlsModule.startsWith(".") ||
    localPrecomputedUrlsModule.startsWith("/")
      ? pathToFileURL(resolve(process.cwd(), localPrecomputedUrlsModule)).href
      : localPrecomputedUrlsModule;
  try {
    const module = await import(moduleUrl);
    if (Array.isArray(module.precomputedUrls)) {
      modulePrecomputedUrls = module.precomputedUrls;
    } else {
      console.warn(
        `[bench] BENCH_PRECOMPUTED_URLS_MODULE="${localPrecomputedUrlsModule}" has no exported "precomputedUrls" array.`,
      );
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.warn(
      `[bench] Failed to load BENCH_PRECOMPUTED_URLS_MODULE="${localPrecomputedUrlsModule}": ${message}`,
    );
  }
}

export const routeSetName = moduleRoutes ? "module" : "generic";
export const routesSource = moduleRoutes ? localRoutesModule : "./bench/routes-generic.mjs";
export const routes = moduleRoutes ?? genericRoutes;
const notFoundProbability = 0.05;
const precomputedSourceUrls = modulePrecomputedUrls ?? genericPrecomputedUrls;

function findUrlsSource() {
  if (!Array.isArray(precomputedSourceUrls)) return "generated from the routes";
  if (modulePrecomputedUrls === null) return "./bench/routes-generic.urls.mjs";
  return localPrecomputedUrlsModule ?? localRoutesModule;
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
