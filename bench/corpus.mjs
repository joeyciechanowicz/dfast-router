// Traffic shapes for `bench.mjs --corpus`, ported from prototype/stress.mjs. The size and the fixed
// seed match it, so these corpora are the ones behind the numbers in PLAN.md.

const STRESS_URLS = 1_000_000;
const STRESS_SEED = 9;
const HEX = "0123456789abcdef";
const MUTATION_CHARS = "abz09-_";
const MAX_MUTATION_TRIES = 1000;

export const corpusNames = ["clean", "near404", "query", "uuid36", "token200"];

function createGenerators() {
  let state = STRESS_SEED;
  const rng = () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;

  const token = (length) => {
    let value = "";
    for (let i = 0; i < length; i += 1) value += HEX[Math.floor(rng() * 16)];
    return value;
  };

  return {
    near404: (url, index) => {
      const position = Math.floor(rng() * (url.length + 1));
      const char = MUTATION_CHARS[Math.floor(rng() * MUTATION_CHARS.length)];
      switch (index % 5) {
        case 0:
          return url.slice(0, position) + char + url.slice(position + 1);
        case 1:
          return url.slice(0, position) + char + url.slice(position);
        case 2:
          return url.slice(0, position) + url.slice(position + 1) || "/";
        case 3:
          return `${url}/`;
        default:
          return `${url}/extra`;
      }
    },
    query: (url) => `${url}?utm_source=newsletter&utm_campaign=autumn&ref=abc123`,
    uuid36: (url) =>
      url.replace(
        /\d{4,}/g,
        () => `${token(8)}-${token(4)}-${token(4)}-${token(4)}-${token(12)}`,
      ),
    token200: (url) => url.replace(/\d{4,}/g, () => token(200)),
  };
}

// `clean` is the whole corpus. The others are the first 1M URLs, reshaped.
export function buildCorpus(name, urls) {
  if (!corpusNames.includes(name)) {
    throw new Error(
      `[bench] Unknown corpus "${name}". Use one of: ${corpusNames.join(", ")}`,
    );
  }
  if (name === "clean") return urls;
  const generate = createGenerators()[name];
  return urls.slice(0, STRESS_URLS).map((url, index) => generate(url, index));
}

// Replaces `percent`% of `urls`, at random positions, with near misses of random URLs. Some mutations
// still match, like an edit inside a plain param, so each is checked with `isNotFound`.
export function injectNotFound(urls, percent, isNotFound, rng) {
  const { near404 } = createGenerators();
  let attempt = 0;
  const nextNotFound = () => {
    for (let tries = 0; tries < MAX_MUTATION_TRIES; tries += 1) {
      attempt += 1;
      const url = near404(urls[Math.floor(rng() * urls.length)], attempt);
      if (isNotFound(url)) return url;
    }
    throw new Error(`[bench] ${MAX_MUTATION_TRIES} mutated URLs in a row still matched a route`);
  };

  const injected = urls.slice();
  let remaining = Math.round((urls.length * percent) / 100);
  for (let i = 0; i < urls.length && remaining > 0; i += 1) {
    // Selection sampling: an exact count at uniform positions, without shuffling the URLs again.
    if (rng() * (urls.length - i) < remaining) {
      injected[i] = nextNotFound();
      remaining -= 1;
    }
  }
  return injected;
}
