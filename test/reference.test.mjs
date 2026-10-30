import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createReference } from '../bench/reference.mjs';

// Each entry is a pattern, or [method, pattern].
function table(entries) {
  return createReference(entries.map((entry) => {
    if (Array.isArray(entry)) return { method: entry[0], concretePaths: [entry[1]] };
    return { concretePaths: [entry] };
  }));
}

const routeOf = (entries, url, method) => table(entries)(url, method)?.route ?? null;
const paramsOf = (entries, url, method) => table(entries)(url, method)?.params;

// `high` must win whichever one is registered first.
function assertBeats(high, low, url) {
  assert.equal(routeOf([high, low], url), 0, `${high} before ${low} on ${url}`);
  assert.equal(routeOf([low, high], url), 1, `${low} before ${high} on ${url}`);
}

const UUID = '550e8400-e29b-41d4-a716-446655440000';

test('priority: static beats every dynamic segment', () => {
  for (const low of ['/items/:id', '/items/:id#slug', '/items/:id(.+)', '/items/:rest*', '/items/*']) {
    assertBeats('/items/all', low, '/items/all');
  }
});

test('priority: segment scores rank aliases, then regex, then plain, then wildcard', () => {
  const ladder = [
    [':v#int', ':v#slug', '123'],
    [':v#uuid', ':v#slug', UUID],
    [':v#locale', ':v#slug', 'en-GB'],
    [':v#alpha', ':v#slug', 'abc'],
    [':v#slug', ':v(.+)', 'abc'],
    [':v(.+)', ':v', 'abc'],
    [':v', ':v*', 'abc'],
    [':v', '*', 'abc'],
  ];
  for (const [high, low, value] of ladder) assertBeats(`/x/${high}`, `/x/${low}`, `/x/${value}`);
});

test('priority: every regex scores 10, even one equal to an alias', () => {
  assertBeats('/x/:v#int', '/x/:v(\\d+)', '/x/123');
  assertBeats('/x/:v#slug', '/x/:v(\\d+)', '/x/123');
});

test('priority: the first differing segment decides, left to right', () => {
  assertBeats('/static/:b', '/:a/static', '/static/static');
  assertBeats('/x/:a#int/:b', '/x/:a/:b#int', '/x/1/2');
  assertBeats('/a/b/:rest*', '/a/:x/:y/:z', '/a/b/c/d');
});

test('priority: ties go to registration order', () => {
  assert.deepEqual(table(['/u/:a', '/u/:b'])('/u/1'), { route: 0, params: { a: '1' } });
  assert.deepEqual(table(['/u/:b', '/u/:a'])('/u/1'), { route: 0, params: { b: '1' } });
  assert.equal(routeOf(['/x/*', '/x/:rest*'], '/x/a/b'), 0);
});

test('priority: registering a route again replaces it and keeps its position (D11)', () => {
  assert.equal(routeOf(['/same', '/same'], '/same'), 1);
  assert.equal(routeOf(['/u/:a', '/u/:b', '/u/:a'], '/u/1'), 2);
  assert.equal(routeOf([/^\/x$/, /^\/x$/], '/x'), 1);
  assert.equal(routeOf(['/u/:a', ['POST', '/u/:a']], '/u/1'), 0);
  assert.equal(routeOf(['/u/:a?', '/u/:a'], '/u/1'), 1);
});

test('priority: variants of one route rank on their own', () => {
  assertBeats('/a/:y#int', '/a/:x?', '/a/1');
});

test('priority: D11 applies to variants, so an optional can replace a static route', () => {
  assert.equal(routeOf(['/a/:x?', '/a'], '/a'), 1);
  assert.equal(routeOf(['/a', '/a/:x?'], '/a'), 1);
  assert.equal(routeOf(['/a/:x?', '/a'], '/a/1'), 0);
});

test('priority: a shorter rank counts its missing segments as 0', () => {
  assertBeats('/files', '/files/:path*', '/files');
  assertBeats('/files', '/files/*', '/files');
  assertBeats('/a/:y(.+)/b', '/a/:x(.+)', '/a/q/b');
  assert.equal(routeOf(['/a/:x(.+)', '/a/:y(.+)/:z'], '/a/q/b'), 0);
  assert.equal(routeOf(['/a/:y(.+)/:z', '/a/:x(.+)'], '/a/q/b'), 0);
});

test('tiers: all four, in order', () => {
  const entries = [
    ['GET', '/a/:id'],
    ['*', '/a/b'],
    ['GET', /^\/a\/b$/],
    ['*', /^\/a\/b$/],
  ];
  for (let first = 0; first < entries.length; first += 1) {
    assert.equal(routeOf(entries.slice(first), '/a/b', 'GET'), 0, `tiers from ${first}`);
  }
});

test('tiers: a higher tier wins however well the lower route scores', () => {
  assert.equal(routeOf([['*', '/a/b'], ['GET', '/a/:id']], '/a/b', 'GET'), 1);
  assert.equal(routeOf([['GET', /^\/a\/b$/], ['*', '/a/:rest*']], '/a/b', 'GET'), 1);
  assert.equal(routeOf([['*', /^\/a\/b$/], ['GET', /^\/a/]], '/a/b', 'GET'), 1);
});

test('tiers: other methods skip the tiers for GET', () => {
  const entries = [['GET', '/a/:id'], ['*', '/a/b'], ['GET', /^\/a\/b$/], ['*', /^\/a\/b$/]];
  assert.equal(routeOf(entries, '/a/b', 'POST'), 1);
  assert.equal(routeOf(entries, '/a/c', 'POST'), null);
  assert.equal(routeOf([['GET', '/a'], ['*', /^\/a$/]], '/a', 'POST'), 1);
});

test('tiers: regex routes go by registration order, not specificity', () => {
  assert.equal(routeOf([/^\/a/, /^\/a\/b$/], '/a/b'), 0);
  assert.equal(routeOf([/^\/a\/b$/, /^\/a/], '/a/b'), 0);
  assert.equal(routeOf([/^\/z/, /^\/a/], '/a/b'), 1);
});

test('tiers: a pattern route beats a matching regex route', () => {
  assert.equal(routeOf([/^\/users\/\d+$/, '/users/:id#int'], '/users/42'), 1);
});

test('methods: arrays, case, whitespace, and blanks', () => {
  const multi = table([[['GET', 'POST'], '/multi']]);
  assert.equal(multi('/multi', 'GET')?.route, 0);
  assert.equal(multi('/multi', 'POST')?.route, 0);
  assert.equal(multi('/multi', 'PUT'), null);

  assert.equal(routeOf([['get', '/case']], '/case', '  GeT  '), 0);
  assert.equal(routeOf([['  ', '/blank']], '/blank', 'PUT'), 0);
  assert.equal(routeOf([['*', '/any']], '/any', ''), 0);
});

test('methods: unknown methods resolve to * routes only', () => {
  const entries = [['GET', '/a'], ['*', '/b']];
  assert.equal(routeOf(entries, '/a', 'PURGE'), null);
  assert.equal(routeOf(entries, '/b', 'PURGE'), 1);
  assert.equal(routeOf(entries, '/a', '*'), null);
  assert.equal(routeOf(entries, '/b', '*'), 1);
});

test('methods: routes and lookups default to GET', () => {
  assert.equal(routeOf(['/a'], '/a'), 0);
  assert.equal(routeOf(['/a'], '/a', 'GET'), 0);
  assert.equal(routeOf(['/a'], '/a', 'POST'), null);
});

test('wildcards: capture the rest of the path', () => {
  assert.deepEqual(paramsOf(['/files/*'], '/files/a/b/c'), { '*': 'a/b/c' });
  assert.deepEqual(paramsOf(['/assets/:path*'], '/assets/css/app.css'), { path: 'css/app.css' });
  assert.deepEqual(paramsOf(['/*'], '/a/b'), { '*': 'a/b' });
});

test('wildcards: also match the bare prefix, with an empty capture', () => {
  assert.deepEqual(paramsOf(['/files/:path*'], '/files'), { path: '' });
  assert.deepEqual(paramsOf(['/files/*'], '/files'), { '*': '' });
  assert.deepEqual(paramsOf(['/files/:path*'], '/files/'), { path: '' });
  assert.equal(routeOf(['/files/:path*'], '/filesystem'), null);
});

test('wildcards: end the pattern', () => {
  assert.deepEqual(paramsOf(['/a/:first*/b/:second*'], '/a/one/two/b/three/four'), {
    first: 'one/two/b/three/four',
  });
});

test('wildcards: stop at the query string', () => {
  assert.deepEqual(paramsOf(['/files/*'], '/files/a/b?x=/c'), { '*': 'a/b' });
});

test('aliases: each matches its table regex', () => {
  const cases = [
    ['int', '0123', ['12a', 'a', '1.5']],
    ['alpha', 'aBc', ['alice-1', 'a1']],
    ['slug', 'hello-World-2', ['hello_world', 'a.b']],
    ['locale', 'en-US', ['en-us', 'EN-US', 'eng-US']],
    ['uuid', UUID, ['not-a-uuid', `${UUID}0`, UUID.replace(/-/g, '')]],
  ];
  for (const [alias, good, bads] of cases) {
    assert.deepEqual(paramsOf([`/x/:v#${alias}`], `/x/${good}`), { v: good }, alias);
    for (const bad of bads) assert.equal(routeOf([`/x/:v#${alias}`], `/x/${bad}`), null, `${alias}: ${bad}`);
  }
});

test('aliases: can be optional', () => {
  const ref = table(['/users/:id#int?']);
  assert.deepEqual(ref('/users'), { route: 0, params: {} });
  assert.deepEqual(ref('/users/123'), { route: 0, params: { id: '123' } });
  assert.equal(ref('/users/abc'), null);
});

test('aliases: an unknown alias throws', () => {
  assert.throws(() => table(['/users/:id#doesnotexist']), /Unknown validator alias/);
  assert.throws(() => table(['/users/:id#constructor']), /Unknown validator alias/);
});

test('patterns: optional params and alternation', () => {
  const ref = table(['/(catalog|portal)/:locale([a-z]{2}-[A-Z]{2})?/items/:id?']);
  assert.deepEqual(ref('/catalog/items'), { route: 0, params: {} });
  assert.deepEqual(ref('/portal/en-GB/items/7'), { route: 0, params: { locale: 'en-GB', id: '7' } });
  assert.equal(ref('/other/items'), null);
  assert.equal(ref('/catalog/english/items'), null);
});

test('patterns: an optional first segment leaves the root', () => {
  assert.deepEqual(paramsOf(['/:id?'], '/'), {});
  assert.deepEqual(paramsOf(['/:id?'], '/7'), { id: '7' });
});

test('patterns: a param needs at least one character and stays in its segment', () => {
  const ref = table(['/users/:id']);
  assert.equal(ref('/users/'), null);
  assert.equal(ref('/users/1/2'), null);
});

test('patterns: regex params are matched whole, and their groups do not shift later params', () => {
  assert.equal(routeOf(['/x/:v(a|ab)'], '/x/abc'), null);
  assert.deepEqual(paramsOf(['/x/:v(a|ab)'], '/x/ab'), { v: 'ab' });
  assert.deepEqual(paramsOf(['/:a((x)|(y))/:b'], '/y/2'), { a: 'y', b: '2' });
});

test('patterns: `.` and negated classes can cross `/`', () => {
  assert.deepEqual(paramsOf(['/shop/:categories(.+)'], '/shop/a/b/c'), { categories: 'a/b/c' });
  assert.deepEqual(paramsOf(['/x/:v([^z]+)/end'], '/x/a/b/end'), { v: 'a/b' });
});

test('patterns: a slash inside a param regex does not split the segment', () => {
  assert.deepEqual(paramsOf(['/x/:v([^/]+)/end'], '/x/a/end'), { v: 'a' });
  assert.equal(routeOf(['/x/:v([^/]+)/end'], '/x/a/b/end'), null);
});

test('patterns: static text is literal', () => {
  assert.equal(routeOf(['/a.b'], '/a.b'), 0);
  assert.equal(routeOf(['/a.b'], '/axb'), null);
  assert.equal(routeOf(['/a+b'], '/aab'), null);
});

test('paths: trailing and double slashes are significant (D2)', () => {
  assert.equal(routeOf(['/items'], '/items/'), null);
  assert.equal(routeOf(['/items/'], '/items'), null);
  assert.equal(routeOf(['/items/'], '/items/'), 0);
  assert.equal(routeOf(['/a/b'], '/a//b'), null);
  assert.equal(routeOf(['/a//b'], '/a//b'), 0);
});

test('paths: `?` ends the path (D3)', () => {
  assert.deepEqual(paramsOf(['/users/:id'], '/users/42?tab=a/b'), { id: '42' });
  assert.equal(routeOf(['/'], '/?x=1'), 0);
  assert.equal(routeOf(['/items'], '/items/?x=1'), null);
  assert.equal(routeOf([/^\/a$/], '/a?x=1'), 0);
});

test('paths: a leading slash is added, and an empty path is the root', () => {
  assert.equal(routeOf(['status'], '/status'), 0);
  assert.equal(routeOf(['/status'], 'status'), 0);
  assert.equal(routeOf([''], '/'), 0);
  assert.equal(routeOf(['/'], ''), 0);
  assert.equal(routeOf(['/'], '?x=1'), 0);
});

test('paths: `%` stays undecoded, and non-ASCII characters match', () => {
  assert.deepEqual(paramsOf(['/x/:v'], '/x/a%2Fb'), { v: 'a%2Fb' });
  assert.deepEqual(paramsOf(['/x/:v'], '/x/café'), { v: 'café' });
  assert.equal(routeOf(['/café'], '/cafü'), null);
});

test('regex routes: expose named groups only (D6)', () => {
  assert.deepEqual(paramsOf([/^\/orders\/(?<id>\d+)$/], '/orders/7'), { id: '7' });
  assert.deepEqual(paramsOf([/^\/orders\/(\d+)$/], '/orders/7'), {});
  assert.deepEqual(paramsOf([/^\/o(?:\/(?<id>\d+))?$/], '/o'), {});
});

test('regex routes: unanchored regexes match anywhere in the path', () => {
  assert.equal(routeOf([/health/], '/api/health/x'), 0);
  assert.equal(routeOf([/health/], '/api?health'), null);
});

test('regex routes: `g` and `y` do not make matching stateful', () => {
  for (const regex of [/^\/a$/g, /^\/a$/y]) {
    const ref = table([regex]);
    assert.equal(ref('/a')?.route, 0);
    assert.equal(ref('/a')?.route, 0);
  }
});

test('regex routes: other flags are kept', () => {
  assert.equal(routeOf([/^\/A$/i], '/a'), 0);
});

test('a route may hold several patterns, and its id is its index', () => {
  const ref = createReference([
    { concretePaths: ['/a'] },
    { concretePaths: ['/b', '/c/:id', /^\/d$/] },
  ]);
  assert.equal(ref('/a')?.route, 0);
  assert.equal(ref('/b')?.route, 1);
  assert.deepEqual(ref('/c/1'), { route: 1, params: { id: '1' } });
  assert.equal(ref('/d')?.route, 1);
  assert.equal(ref('/e'), null);
});

function seededRng(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// Every generated URL must resolve to the route that generated it, and nothing else may.
function assertRoutesOwnTheirUrls(routes) {
  const ref = createReference(routes);
  const rng = seededRng(42);
  let checked = 0;
  routes.forEach((route, id) => {
    for (let i = 0; i < 64; i += 1) {
      const url = route.generateUrl(rng);
      assert.equal(ref(url)?.route, id, `route ${route.path} from ${url}`);
      assert.equal(ref(`/__404__${url}`), null, `/__404__${url}`);
      assert.equal(ref(`${url}?a=1&b=/x/y`)?.route, id, `query on ${url}`);
      checked += 1;
    }
  });
  assert.ok(checked > 0);
}

test('bench route set: generic', async () => {
  const { routes } = await import('../bench/routes-generic.mjs');
  assertRoutesOwnTheirUrls(routes);
});

const specificUrl = new URL('../bench/routes-specific.mjs', import.meta.url);
const skipSpecific = existsSync(specificUrl) ? false : 'bench/routes-specific.mjs is not present';

test('bench route set: specific', { skip: skipSpecific }, async () => {
  const { routes } = await import(specificUrl.href);
  assertRoutesOwnTheirUrls(routes);
});
