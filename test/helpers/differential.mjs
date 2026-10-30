// Compares a router with bench/reference.mjs, on both route and params.
import { createReference } from '../../bench/reference.mjs';

const sortedEntries = (params) => JSON.stringify(Object.entries(params).sort());

/** `find(method, url)` returns `{ route, params }` or null. */
export function compare(find, routes, lookups) {
  const reference = createReference(routes);
  const mismatches = [];
  let hits = 0;
  for (const { method, url } of lookups) {
    const want = reference(url, method);
    const got = find(method, url);
    if (want !== null) hits += 1;
    const same = want === null || got === null
      ? want === got
      : want.route === got.route && sortedEntries(want.params) === sortedEntries(got.params);
    if (!same) mismatches.push({ method, url, want, got });
  }
  return { checked: lookups.length, hits, mismatches };
}

/** URLs with one bug-shaped change each: these are what real 404s look like. */
export function mutate(urls, count, seed = 42) {
  let x = seed;
  const random = () => (x = (x * 1664525 + 1013904223) >>> 0) / 4294967296;
  const chars = 'abz09-/?_%é';
  const mutated = [];
  for (let i = 0; i < count; i += 1) {
    const url = urls[Math.floor(random() * urls.length)];
    const at = Math.floor(random() * (url.length + 1));
    const ch = chars[Math.floor(random() * chars.length)];
    switch (i % 6) {
      case 0: mutated.push(url.slice(0, at) + ch + url.slice(at + 1)); break;
      case 1: mutated.push(url.slice(0, at) + ch + url.slice(at)); break;
      case 2: mutated.push(url.slice(0, at) + url.slice(at + 1)); break;
      case 3: mutated.push(`${url}/`); break;
      case 4: mutated.push(`${url}/extra`); break;
      default: mutated.push(`${url}?a=1&b=/x/y`); break;
    }
  }
  return mutated;
}

/** How many lookups match more than one route, ignoring which of them wins. */
export function countOverlaps(routes, lookups) {
  const each = routes.map((route) => createReference([route]));
  let overlaps = 0;
  for (const { method, url } of lookups) {
    let matched = 0;
    for (const reference of each) if (reference(url, method) !== null) matched += 1;
    if (matched > 1) overlaps += 1;
  }
  return overlaps;
}
