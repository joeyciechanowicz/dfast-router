// Routes where URLs match several routes at once, so that wrong ranking changes the answer. No URL in
// the bench route sets matches more than one route, so they can't detect a ranking bug.
//
// Broad routes are registered first throughout, so registration order can't explain a specific win.

const UUID = '550e8400-e29b-41d4-a716-446655440000';

const route = (path, method) => ({
  path,
  concretePaths: [path],
  ...(method === undefined ? {} : { method }),
});

export const routes = [
  // Segment scores.
  route('/items/:rest*'),
  route('/items/:id'),
  route('/items/:id([a-z]+_[a-z]+)'),
  route('/items/:id#slug'),
  route('/items/:id#alpha'),
  route('/items/:id#locale'),
  route('/items/:id#uuid'),
  route('/items/:id#int'),
  route('/items/all'),

  // The first difference decides, left to right.
  route('/x/:a/static'),
  route('/x/static/:b'),
  route('/x/:a/:b#int'),
  route('/x/:a#int/:b'),

  // Ties go to registration order.
  route('/u/:a'),
  route('/u/:b'),

  // A repeated variant replaces the earlier one (D11), also through an optional.
  route('/dup/:a'),
  route('/dup/:a'),
  route('/opt/:a?'),
  route('/opt'),

  // Wildcards, empty matches, and ranks of unequal length.
  route('/files/:path*'),
  route('/files/:a/:b'),
  route('/files'),
  route('/anon/*'),
  route('/deep/:x(.+)'),
  route('/deep/:y(.+)/b'),

  // Alternation and optional segments.
  route('/foo/:v'),
  route('/(foo|bar)/baz'),
  route('/:lang#locale?/home'),

  // Method tiers, including a broad route for a method beating a specific route for `*`.
  route('/t/static', '*'),
  route('/t/:a', 'GET'),
  route('/t/post', 'POST'),
  route('/t/multi', ['GET', 'DELETE']),
  route(/^\/t\/.+\/deep$/, 'GET'),
  route(/^\/t\/x\/.+$/, '*'),

  // Regex tiers go by each method's registration order. No named groups until WP-9 adds them.
  route(/^\/r\/.*$/, '*'),
  route(/^\/r\/[a-z0-9]+$/, 'GET'),
  route(/^\/r\/\d+$/, 'POST'),
  route('/r/:id#alpha', '*'),

  // A pattern route beats a regex route registered before it.
  route(/^\/n\/\d+$/, 'GET'),
  route('/n/:id#int', 'GET'),

  // Above ASCII the DFA over-accepts, so these need confirming (D10).
  route('/café'),
  route('/cafè/:v'),
  route('/dot/:v(.+)'),
  route('/not/:v([^é]+)'),
];

const indexOf = (path) => routes.findIndex((r) => String(r.path) === String(path));

/** Routes that must never win: a tie's loser, a replaced variant, and a shadowed regex. */
export const neverWin = [indexOf('/u/:b'), indexOf('/dup/:a'), indexOf(/^\/n\/\d+$/)].sort((a, b) => a - b);

const PREFIXES = [
  '', '/items', '/x', '/x/static', '/x/1', '/x/a', '/u', '/dup', '/opt', '/files', '/anon', '/deep',
  '/deep/q', '/foo', '/bar', '/en-GB', '/t', '/t/x', '/r', '/n', '/dot', '/not', '/café', '/cafè', '/cafü',
];
const VALUES = [
  '', 'all', '123', 'en-GB', 'abc', 'hello-world', 'hello_world', 'a.b', UUID, 'a/b', 'a/b/c', 'static',
  'post', 'multi', 'baz', 'home', 'é', 'aéb', 'aüb', 'a b', 'é'.repeat(30), 'a'.repeat(30),
  `${'a'.repeat(30)}é`,
];
const SUFFIXES = ['', '/', '/b', '/static', '/2', '/deep', '/home', '?q=/x', '/b?x=1'];

export const methods = ['GET', 'POST', 'DELETE', 'PUT'];

export function urls() {
  const list = [];
  for (const prefix of PREFIXES) {
    if (prefix !== '') list.push(prefix);
    for (const value of VALUES) {
      for (const suffix of SUFFIXES) list.push(`${prefix}/${value}${suffix}`);
    }
  }
  return [...new Set(list)];
}
