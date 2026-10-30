import test from 'node:test';
import assert from 'node:assert/strict';
import { createReference } from '../bench/reference.mjs';
import { createRouter } from '../src/index';

const noop = () => {};

test('matches static routes', () => {
  const router = createRouter();
  router.on('GET', '/users', noop);

  const match = router.find('GET', '/users');
  assert.ok(match);
  assert.equal(match.handler, noop);
  assert.equal(Object.keys(match.params).length, 0);
});

test('matches param routes and captures params', () => {
  const router = createRouter();
  router.on('GET', '/users/:id', noop);

  const match = router.find('GET', '/users/42');
  assert.ok(match);
  assert.equal(match.handler, noop);
  assert.deepEqual({ ...match.params }, { id: '42' });
});

test('matches param routes with regex constraints', () => {
  const router = createRouter();
  router.on('GET', '/orders/:id(\\d+)', noop);

  const numeric = router.find('GET', '/orders/123');
  const nonNumeric = router.find('GET', '/orders/abc');
  assert.ok(numeric);
  assert.equal(numeric?.handler, noop);
  assert.equal(nonNumeric, null);
});

test('matches wildcard routes', () => {
  const router = createRouter();
  router.on('GET', '/files/*', noop);

  const match = router.find('GET', '/files/a/b/c');
  assert.ok(match);
  assert.deepEqual({ ...match.params }, { '*': 'a/b/c' });
});

test('matches named wildcard routes', () => {
  const router = createRouter();
  router.on('GET', '/assets/:path*', noop);

  const match = router.find('GET', '/assets/css/app.css');
  assert.ok(match);
  assert.deepEqual({ ...match.params }, { path: 'css/app.css' });
});

test('matches regex routes', () => {
  const router = createRouter();
  router.on('GET', /^\/api\/v\d+\/health$/, noop);

  const match = router.find('GET', '/api/v2/health');
  assert.ok(match);
  assert.equal(match.handler, noop);
});

test('falls back to method wildcard', () => {
  const router = createRouter();
  router.on('*', '/health', noop);

  const match = router.find('POST', '/health');
  assert.ok(match);
  assert.equal(match.handler, noop);
});

test('returns null when no route matches', () => {
  const router = createRouter();
  router.on('GET', '/users', noop);

  const match = router.find('POST', '/missing');
  assert.equal(match, null);
});

test('supports method arrays', () => {
  const router = createRouter();
  router.on(['GET', 'POST'], '/multi', noop);

  assert.ok(router.find('GET', '/multi'));
  assert.ok(router.find('POST', '/multi'));
  assert.equal(router.find('PUT', '/multi'), null);
});

test('normalizes paths without a leading slash', () => {
  const router = createRouter();
  router.on('GET', 'status', noop);

  const match = router.find('GET', 'status');
  assert.ok(match);
  assert.equal(match.handler, noop);
});

test('normalizes method casing and trims whitespace', () => {
  const router = createRouter();
  router.on('get', '/case', noop);

  const match = router.find('  GeT  ', '/case');
  assert.ok(match);
  assert.equal(match.handler, noop);
});

test('wildcard param captures empty when path ends at wildcard node', () => {
  const router = createRouter();
  router.on('GET', '/files/:path*', noop);

  const match = router.find('GET', '/files');
  assert.ok(match);
  assert.deepEqual({ ...match.params }, { path: '' });
});

test('prioritizes static over param and wildcard', () => {
  const router = createRouter();
  const staticHandler = () => 'static';
  const paramHandler = () => 'param';
  const wildcardHandler = () => 'wildcard';

  router.on('GET', '/items/all', staticHandler);
  router.on('GET', '/items/:id', paramHandler);
  router.on('GET', '/items/:rest*', wildcardHandler);

  const match = router.find('GET', '/items/all');
  assert.equal(match?.handler, staticHandler);
});

test('regex routes do not match when pattern fails', () => {
  const router = createRouter();
  router.on('GET', /^\/api\/v\d+\/health$/, noop);

  const match = router.find('GET', '/api/vx/health');
  assert.equal(match, null);
});

test('matches root path', () => {
  const router = createRouter();
  router.on('GET', '/', noop);

  const match = router.find('GET', '/');
  assert.ok(match);
  assert.equal(match.handler, noop);
});

test('wildcard consumes the rest of the path', () => {
  const router = createRouter();
  router.on('GET', '/a/:first*/b/:second*', noop);

  const match = router.find('GET', '/a/one/two/b/three/four');
  assert.ok(match);
  assert.deepEqual({ ...match.params }, { first: 'one/two/b/three/four' });
});

test('prefers method-specific handler over method wildcard', () => {
  const router = createRouter();
  const anyHandler = () => 'any';
  const getHandler = () => 'get';

  router.on('*', '/status', anyHandler);
  router.on('GET', '/status', getHandler);

  const match = router.find('GET', '/status');
  assert.equal(match?.handler, getHandler);
});

test('stores route metadata', () => {
  const router = createRouter();
  const store = { feature: 'beta' };
  router.on('GET', '/meta', noop, store);

  const match = router.find('GET', '/meta');
  assert.ok(match);
  assert.equal(match.store, store);
});

test('routes methods on regex routes', () => {
  const router = createRouter();
  const getHandler = () => 'get';
  const postHandler = () => 'post';
  router.on('GET', /^\/api\/v\d+\/health$/, getHandler);
  router.on('POST', /^\/api\/v\d+\/health$/, postHandler);

  const getMatch = router.find('GET', '/api/v1/health');
  const postMatch = router.find('POST', '/api/v1/health');
  assert.equal(getMatch?.handler, getHandler);
  assert.equal(postMatch?.handler, postHandler);
});

test('supports optional segments', () => {
  const router = createRouter();
  router.on('GET', '/items/:id?', noop);
  assert.ok(router.find('GET', '/items'));
  assert.ok(router.find('GET', '/items/123'));
});

test('supports the int alias validator', () => {
  const router = createRouter();
  router.on('GET', '/users/:id#int', noop);
  assert.ok(router.find('GET', '/users/123'));
  assert.equal(router.find('GET', '/users/abc'), null);
});

test('supports alpha alias validator', () => {
  const router = createRouter();
  router.on('GET', '/name/:value#alpha', noop);
  assert.ok(router.find('GET', '/name/Alice'));
  assert.equal(router.find('GET', '/name/alice-1'), null);
});

test('supports slug alias validator', () => {
  const router = createRouter();
  router.on('GET', '/post/:value#slug', noop);
  assert.ok(router.find('GET', '/post/hello-world-2'));
  assert.equal(router.find('GET', '/post/hello_world'), null);
});

test('supports locale alias validator', () => {
  const router = createRouter();
  router.on('GET', '/locale/:value#locale', noop);
  assert.ok(router.find('GET', '/locale/en-US'));
  assert.equal(router.find('GET', '/locale/en-us'), null);
});

test('supports uuid alias validator', () => {
  const router = createRouter();
  router.on('GET', '/id/:value#uuid', noop);
  assert.ok(router.find('GET', '/id/550e8400-e29b-41d4-a716-446655440000'));
  assert.equal(router.find('GET', '/id/not-a-uuid'), null);
});

test('supports optional alias segments', () => {
  const router = createRouter();
  router.on('GET', '/users/:id#int?', noop);
  assert.ok(router.find('GET', '/users'));
  assert.ok(router.find('GET', '/users/123'));
  assert.equal(router.find('GET', '/users/abc'), null);
});

test('throws on unknown alias', () => {
  const router = createRouter();
  assert.throws(
    () => router.on('GET', '/users/:id#doesnotexist', noop).find('GET', '/users/1'),
    /Unknown validator alias/,
  );
});

test('prefers concrete route over matching regex route', () => {
  const router = createRouter();
  const regexHandler = () => 'regex';
  const concreteHandler = () => 'concrete';
  router.on('GET', /^\/users\/\d+$/, regexHandler);
  router.on('GET', '/users/:id#int', concreteHandler);
  assert.equal(router.find('GET', '/users/42')?.handler, concreteHandler);
});

test('registering more than once on one method: the last handler wins (D11)', () => {
  const router = createRouter();
  const first = () => 'first';
  const second = () => 'second';
  router.on('GET', '/same', first).on('GET', '/same', second);
  assert.equal(router.find('GET', '/same')?.handler, second);
});

test('D11 applies per variant, so `/a` replaces the shorter variant of `/a/:x?`', () => {
  const router = createRouter();
  const optional = () => 'optional';
  const exact = () => 'exact';
  router.on('GET', '/a/:x?', optional).on('GET', '/a', exact);
  assert.equal(router.find('GET', '/a')?.handler, exact);
  assert.equal(router.find('GET', '/a/1')?.handler, optional);
});

test('ties go to registration order', () => {
  const router = createRouter();
  const first = () => 'first';
  router.on('GET', '/u/:a', first).on('GET', '/u/:b', noop);
  const match = router.find('GET', '/u/1');
  assert.equal(match?.handler, first);
  assert.deepEqual({ ...match?.params }, { a: '1' });
});

test('trailing and double slashes are significant (D2)', () => {
  const router = createRouter();
  router.on('GET', '/items', noop).on('GET', '/a/b', noop).on('GET', '/dir/', noop);
  assert.equal(router.find('GET', '/items/'), null);
  assert.equal(router.find('GET', '/a//b'), null);
  assert.equal(router.find('GET', '//a/b'), null);
  assert.equal(router.find('GET', '/dir'), null);
  assert.ok(router.find('GET', '/dir/'));
});

test('`?` ends the path (D3)', () => {
  const router = createRouter();
  router.on('GET', '/users/:id', noop).on('GET', '/files/*', noop).on('GET', '/', noop);
  assert.deepEqual({ ...router.find('GET', '/users/42?a=/b/c')?.params }, { id: '42' });
  assert.deepEqual({ ...router.find('GET', '/files/a/b?x=1')?.params }, { '*': 'a/b' });
  assert.ok(router.find('GET', '/?x=1'));
  assert.ok(router.find('GET', '?x=1'));
  assert.equal(router.find('GET', '/users?id=1'), null);
});

test('params are built once, on first read (D4)', () => {
  const router = createRouter();
  router.on('GET', '/users/:id', noop);
  const match = router.find('GET', '/users/42');
  assert.ok(match);
  assert.equal(match.params, match.params);
  assert.deepEqual({ ...match.params }, { id: '42' });
});

test('matches do not share params', () => {
  const router = createRouter();
  router.on('GET', '/users/:id', noop);
  const a = router.find('GET', '/users/1');
  const b = router.find('GET', '/users/2');
  assert.equal(b?.params.id, '2');
  assert.equal(a?.params.id, '1');
});

test('static results are shared and frozen (D5)', () => {
  const router = createRouter();
  router.on('GET', '/static', noop);
  const a = router.find('GET', '/static');
  const b = router.find('GET', '/static');
  assert.equal(a, b);
  assert.ok(Object.isFrozen(a?.params));
});

test('regex routes expose named groups as params (D6)', () => {
  const router = createRouter();
  router.on('GET', /^\/orders\/(?<id>\d+)$/, noop).on('GET', /^\/users\/(\d+)$/, noop);
  assert.deepEqual({ ...router.find('GET', '/orders/7')?.params }, { id: '7' });
  assert.deepEqual({ ...router.find('GET', '/users/7')?.params }, {});
});

test('a route over 256 variants throws, and one at the limit does not (D9)', () => {
  const optionals = (n: number) => Array.from({ length: n }, (_, i) => `/:p${i}?`).join('');
  assert.doesNotThrow(() => createRouter().on('GET', optionals(8), noop).compile());
  assert.throws(() => createRouter().on('GET', optionals(9), noop).compile(), /256/);
});

test('non-ASCII paths are exact, though the DFA can not tell them apart (D10)', () => {
  const router = createRouter();
  const cafe = () => 'cafe';
  router.on('GET', '/café', cafe);
  router.on('GET', '/dot/:v(.+)', noop);
  router.on('GET', '/not/:v([^é]+)', noop);
  router.on('GET', '/param/:v', noop);
  assert.equal(router.find('GET', '/café')?.handler, cafe);
  assert.equal(router.find('GET', '/cafü'), null);
  assert.equal(router.find('GET', '/dot/a b'), null);
  assert.deepEqual({ ...router.find('GET', '/dot/aüb')?.params }, { v: 'aüb' });
  assert.equal(router.find('GET', '/not/aéb'), null);
  assert.deepEqual({ ...router.find('GET', '/not/aüb')?.params }, { v: 'aüb' });
  assert.deepEqual({ ...router.find('GET', '/param/café')?.params }, { v: 'café' });
});

test('a non-ASCII character deep inside a long param is still confirmed (D10)', () => {
  const router = createRouter();
  router.on('GET', '/not/:v([^é]+)', noop);
  router.on('GET', '/any/:v', noop);
  const long = 'a'.repeat(100);
  assert.equal(router.find('GET', `/not/${long}é${long}`), null);
  assert.ok(router.find('GET', `/not/${long}ü${long}`));
  assert.deepEqual({ ...router.find('GET', `/any/${long}é`)?.params }, { v: `${long}é` });
});

test('an inexact route on a shared path does not hide an exact one (D10)', () => {
  const plain = () => 'plain';
  const router = createRouter();
  router.on('GET', '/p/:w', plain).on('GET', '/p/:v(.+)', noop); // the regex outranks the plain param
  assert.equal(router.find('GET', '/p/a\u2028b')?.handler, plain);
  assert.equal(router.find('GET', `/p/${'a'.repeat(100)}\u2028b`)?.handler, plain);
  assert.notEqual(router.find('GET', '/p/aüb')?.handler, plain);
});

test('a wildcard tail is captured whole, however long, and stops at `?`', () => {
  const router = createRouter().on('GET', '/static/*', noop).on('GET', '/n/:v([^é]*)', noop);
  const tail = 'a/b/'.repeat(100);
  assert.deepEqual({ ...router.find('GET', `/static/${tail}`)?.params }, { '*': tail });
  assert.deepEqual({ ...router.find('GET', `/static/${tail}?x=/y/z`)?.params }, { '*': tail });
  assert.deepEqual({ ...router.find('GET', '/static/x')?.params }, { '*': 'x' });
  assert.deepEqual({ ...router.find('GET', '/static/é')?.params }, { '*': 'é' });
  assert.deepEqual({ ...router.find('GET', `/static/${tail}é`)?.params }, { '*': `${tail}é` });
});

test('a tail that over-accepts above ASCII is still confirmed (D10)', () => {
  const router = createRouter().on('GET', '/n/:v([^é]*)', noop);
  const long = 'a/'.repeat(50);
  assert.ok(router.find('GET', `/n/${long}`));
  assert.ok(router.find('GET', `/n/${long}ü`));
  assert.equal(router.find('GET', `/n/${long}é`), null);
  assert.equal(router.find('GET', '/n/é'), null);
  assert.ok(router.find('GET', `/n/${long}?q=é`));
});

test('`%` stays undecoded', () => {
  const router = createRouter();
  router.on('GET', '/x/:v', noop);
  assert.deepEqual({ ...router.find('GET', '/x/a%2Fb')?.params }, { v: 'a%2Fb' });
});

test('a wildcard rest may be empty', () => {
  const router = createRouter();
  router.on('GET', '/files/:path*', noop).on('GET', '/any/*', noop);
  assert.deepEqual({ ...router.find('GET', '/files/')?.params }, { path: '' });
  assert.deepEqual({ ...router.find('GET', '/any')?.params }, { '*': '' });
  assert.deepEqual({ ...router.find('GET', '/any/')?.params }, { '*': '' });
});

test('static beats a wildcard empty match in either order', () => {
  const exact = () => 'exact';
  const one = createRouter().on('GET', '/files', exact).on('GET', '/files/:path*', noop);
  const two = createRouter().on('GET', '/files/:path*', noop).on('GET', '/files', exact);
  assert.equal(one.find('GET', '/files')?.handler, exact);
  assert.equal(two.find('GET', '/files')?.handler, exact);
});

test('priority ignores registration order', () => {
  const staticHandler = () => 'static';
  const router = createRouter();
  router.on('GET', '/items/:rest*', noop).on('GET', '/items/:id', noop).on('GET', '/items/all', staticHandler);
  assert.equal(router.find('GET', '/items/all')?.handler, staticHandler);
});

test('tiers: all four, in order', () => {
  const tiers = { get: () => 'get', any: () => 'any', regexGet: () => 'regexGet', regexAny: () => 'regexAny' };
  const router = createRouter();
  router.on('*', /^\/t\/.*$/, tiers.regexAny);
  router.on('GET', /^\/t\/[a-z0-9]+$/, tiers.regexGet);
  router.on('*', '/t/:v#alpha', tiers.any);
  router.on('GET', '/t/get', tiers.get);
  assert.equal(router.find('GET', '/t/get')?.handler, tiers.get);
  assert.equal(router.find('GET', '/t/abc')?.handler, tiers.any);
  assert.equal(router.find('GET', '/t/123')?.handler, tiers.regexGet);
  assert.equal(router.find('GET', '/t/a/b')?.handler, tiers.regexAny);
});

test('a broad route for the method beats a specific route for `*`', () => {
  const get = () => 'get';
  const router = createRouter();
  router.on('*', '/t/static', noop).on('GET', '/t/:a', get);
  assert.equal(router.find('GET', '/t/static')?.handler, get);
  assert.notEqual(router.find('POST', '/t/static')?.handler, get);
});

test('a method no route names reaches only `*` routes', () => {
  const router = createRouter();
  router.on('GET', '/get', noop).on('*', '/any', noop);
  assert.equal(router.find('PATCH', '/get'), null);
  assert.ok(router.find('PATCH', '/any'));
});

test('regex tiers keep each method its own order', () => {
  const first = () => 'first';
  const second = () => 'second';
  const router = createRouter();
  router.on('GET', /^\/r\/a$/, first);
  router.on('POST', /^\/r\/.$/, second);
  router.on('POST', /^\/r\/a$/, first);
  router.on('GET', /^\/r\/.$/, second);
  assert.equal(router.find('GET', '/r/a')?.handler, first);
  assert.equal(router.find('POST', '/r/a')?.handler, second);
});

test('a regex that is global or sticky is not stateful', () => {
  const router = createRouter();
  router.on('GET', /^\/g$/g, noop).on('GET', /^\/y$/y, noop);
  for (let i = 0; i < 3; i += 1) {
    assert.ok(router.find('GET', '/g'));
    assert.ok(router.find('GET', '/y'));
  }
});

test('a regex route can match non-ASCII paths, and paths the DFA rejects', () => {
  const router = createRouter();
  router.on('GET', /^\/é+$/, noop).on('GET', /\.png$/, noop).on('GET', '/plain', noop);
  assert.ok(router.find('GET', '/éé'));
  assert.ok(router.find('GET', '/any/where/a.png'));
  assert.equal(router.find('GET', '/any/where/a.gif'), null);
});

test('a route added after a lookup is found', () => {
  const router = createRouter();
  const late = () => 'late';
  router.on('GET', '/first', noop);
  assert.equal(router.find('GET', '/late'), null);
  router.on('GET', '/late', late);
  assert.equal(router.find('GET', '/late')?.handler, late);
  assert.ok(router.find('GET', '/first'));
});

test('on returns the router, and compile can run up front', () => {
  const router = createRouter();
  assert.equal(router.on('GET', '/a', noop), router);
  router.compile();
  assert.ok(router.find('GET', '/a'));
});

test('an empty path is the root', () => {
  const router = createRouter();
  router.on('GET', '', noop);
  assert.ok(router.find('GET', ''));
  assert.ok(router.find('GET', '/'));
});

test('an empty router matches nothing', () => {
  assert.equal(createRouter().find('GET', '/'), null);
  assert.equal(createRouter().find('GET', ''), null);
});

test('regex routes compile into the DFA, and hold their own order against patterns', () => {
  const router = createRouter();
  const regex = () => 'regex';
  router.on('GET', /^\/v\d+\/health$/, regex).on('GET', '/v1/:x', noop);
  assert.equal(router.residual().length, 0);
  assert.notEqual(router.find('GET', '/v1/health')?.handler, regex);
  assert.equal(router.find('GET', '/v2/health')?.handler, regex);
  assert.equal(router.find('GET', '/vx/health'), null);
});

test('an unanchored regex can match anywhere in the path', () => {
  const router = createRouter();
  router.on('GET', /\.png$/, noop).on('GET', /^\/start/, noop).on('GET', /mid/, noop);
  assert.equal(router.residual().length, 0);
  assert.ok(router.find('GET', '/a/b.png?x=1'));
  assert.ok(router.find('GET', '/start/more'));
  assert.ok(router.find('GET', '/a/mid/b'));
  assert.equal(router.find('GET', '/a/b.gif'), null);
});

test('flags: `i` and `s` compile, and `m` and `u` stay residual but work', () => {
  const router = createRouter();
  router.on('GET', /^\/case$/i, noop).on('GET', /^\/dot.x$/s, noop);
  assert.equal(router.residual().length, 0);
  assert.ok(router.find('GET', '/CASE'));
  assert.ok(router.find('GET', '/dot\nx'));
  const other = createRouter().on('GET', /^\/m$/m, noop).on('GET', /^\/\u{1F600}$/u, noop);
  assert.equal(other.residual().length, 2);
  assert.ok(other.find('GET', '/m'));
  assert.ok(other.find('GET', '/😀'));
});

test('regexes the DFA cannot hold still work, as residual routes', () => {
  const router = createRouter();
  router.on('GET', /^\/back\/(a+)\/\1$/, noop).on('GET', /^\/look\/(?=x)\w+$/, noop);
  assert.deepEqual(router.residual(), [String(/^\/back\/(a+)\/\1$/), String(/^\/look\/(?=x)\w+$/)]);
  assert.ok(router.find('GET', '/back/aa/aa'));
  assert.equal(router.find('GET', '/back/aa/a'), null);
  assert.ok(router.find('GET', '/look/xy'));
  assert.equal(router.find('GET', '/look/yx'), null);
});

test('compiled and residual regexes keep registration order, in both directions', () => {
  const compiled = () => 'compiled';
  const residual = () => 'residual';
  const one = createRouter().on('GET', /^\/m\/[a-z]+$/, compiled).on('GET', /^\/m\/(?=a)[a-z]+$/, residual);
  const two = createRouter().on('GET', /^\/m\/(?=a)[a-z]+$/, residual).on('GET', /^\/m\/[a-z]+$/, compiled);
  assert.equal(one.find('GET', '/m/abc')?.handler, compiled);
  assert.equal(two.find('GET', '/m/abc')?.handler, residual);
  assert.equal(two.find('GET', '/m/bcd')?.handler, compiled);
});

test('a pattern route still beats a residual regex', () => {
  const pattern = () => 'pattern';
  const router = createRouter().on('GET', /^\/p\/(?=1)\d+$/, noop).on('GET', '/p/:id#int', pattern);
  assert.equal(router.find('GET', '/p/123')?.handler, pattern);
});

test('a residual regex for `*` loses to one for the method', () => {
  const get = () => 'get';
  const router = createRouter().on('*', /^\/q\/(?=a).+$/, noop).on('GET', /^\/q\/a(?=b).+$/, get);
  assert.equal(router.find('GET', '/q/abc')?.handler, get);
  assert.notEqual(router.find('POST', '/q/abc')?.handler, get);
});

test('the prefix filter never hides a residual match', () => {
  const cases: [RegExp, string][] = [
    [/^\/ab*c(?=$)/, '/ac'],
    [/^\/a?b(?=$)/, '/b'],
    [/^\/a{0,2}b(?=$)/, '/b'],
    [/^\/x(?=$)|^\/y(?=$)/, '/y'],
    [/^\/X(?=$)/i, '/x'],
    [/^\/a\/b(?=$)/, '/a/b'],
    [/^\/a\.b(?=$)/, '/a.b'],
  ];
  for (const [regex, path] of cases) {
    const router = createRouter().on('GET', regex, noop);
    assert.equal(router.residual().length, 1, String(regex));
    assert.ok(router.find('GET', path), String(regex));
  }
});

test('a residual route is found on a path with a non-ASCII character', () => {
  const router = createRouter().on('GET', /^\/é(?=x)x$/, noop);
  assert.ok(router.find('GET', '/éx'));
  assert.equal(router.find('GET', '/üx'), null);
});

test('a param regex the DFA cannot hold is confirmed, and keeps its rank', () => {
  const backref = () => 'backref';
  const router = createRouter().on('GET', '/a/:x', noop).on('GET', '/a/:v((.)\\2)', backref);
  assert.deepEqual(router.residual(), ['/a/:v((.)\\2)']);
  assert.equal(router.find('GET', '/a/zz')?.handler, backref);
  assert.deepEqual({ ...router.find('GET', '/a/zz')?.params }, { v: 'zz' });
  assert.notEqual(router.find('GET', '/a/zy')?.handler, backref);
  assert.ok(router.find('GET', '/a/zy'));
});

test('an invalid param regex throws before any request', () => {
  assert.throws(() => createRouter().on('GET', '/a/:v([)', noop).compile());
});

test('one explosive route is demoted, not fatal', () => {
  const started = performance.now();
  const router = createRouter();
  router.on('GET', '/x/:a([ab]*a[ab]{14})', noop).on('GET', /^\/y\/[ab]*a[ab]{14}$/, noop).on('GET', '/plain', noop);
  assert.equal(router.residual().length, 2);
  assert.ok(router.find('GET', `/x/a${'b'.repeat(14)}`));
  assert.equal(router.find('GET', `/x/b${'b'.repeat(14)}`), null);
  assert.ok(router.find('GET', `/y/a${'b'.repeat(14)}`));
  assert.ok(router.find('GET', '/plain'));
  assert.ok(performance.now() - started < 5_000);
});

function overlappingPaths(count: number): string[] {
  let seed = 7;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const words = Array.from({ length: Math.round(Math.sqrt(count)) }, (_, i) => `w${i}x${i * 7}`);
  const seen = new Set<string>();
  while (seen.size < count) {
    let path = '';
    let param = 0;
    const depth = 2 + Math.floor(random() * 4);
    for (let i = 0; i < depth; i += 1) {
      path += random() < 0.4 ? `/:p${param++}` : `/${words[Math.floor(random() * words.length)]}`;
    }
    seen.add(path);
  }
  return [...seen];
}

test('a table over budget fails fast, and names a route', () => {
  const router = createRouter({ maxStates: 2_000 });
  for (const path of overlappingPaths(300)) router.on('GET', path, noop);
  const started = performance.now();
  assert.throws(() => router.compile(), /more than 2000 DFA states.*\/.* goes over/);
  assert.ok(performance.now() - started < 5_000);
});

test('the default budget holds a heavily overlapping table, in a 32-bit table', () => {
  const paths = overlappingPaths(300);
  const router = createRouter();
  paths.forEach((path, route) => router.on('GET', path, noop, { route }));
  const started = performance.now();
  router.compile();
  assert.ok(performance.now() - started < 10_000);

  const reference = createReference(paths.map((path) => ({ concretePaths: [path] })));
  paths.forEach((path) => {
    const url = path.replace(/:p\d+/g, (name) => `v${name.slice(2)}`);
    const want = reference(url);
    assert.ok(want, url);
    const match = router.find('GET', url);
    assert.equal((match?.store as { route: number }).route, want.route, url);
    assert.deepEqual({ ...match?.params }, want.params, url);
    const longer = `${url}x/y/z/q/r/s/t`;
    assert.equal(router.find('GET', longer) === null, reference(longer) === null, longer);
  });
});
