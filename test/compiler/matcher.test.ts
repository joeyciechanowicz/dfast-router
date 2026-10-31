import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createReference } from '../../bench/reference.mjs';
import { buildTable } from '../../src/compiler/table';
import { ALPHABET, NON_ASCII, QMARK, SLASH } from '../../src/compiler/types';
import type { Dfa, Extractor, Miss, Results, Table } from '../../src/compiler/types';
import { Match, MatchTarget } from '../../src/match';
import { createMatcher } from '../../src/matcher';
import type { RouteMatch } from '../../src/types';
import { compileFixture } from '../helpers/dfa-fixture';
import type { FixturePattern } from '../helpers/dfa-fixture';

const GET = 1;
const handler = () => {};
const SEEDS = { fuzz: 7, corpus: 42 };

interface Entry {
  route: number;
  regex: RegExp;
  names: string[];
}

interface Options {
  scanAfter?: number;
  scanRun?: number;
  methodBits?: number;
  allows?: (tag: number, method: number) => boolean;
  exact?: Record<string, RegExp>; // pattern path to the regex `miss` confirms with, when not derivable
  exactResults?: boolean; // results need no confirming; they all do by default
}

interface MissCall {
  path: string;
  method: number;
  end: number;
  row: number;
}

/** A pattern as an exact RegExp, with params as named groups so nested groups can't shift them. */
function toEntry(pattern: FixturePattern, exact?: RegExp): Entry {
  if (pattern.path === '/') return { route: pattern.route, regex: /^\/$/, names: [] };
  const names: string[] = [];
  const source = pattern.path.replace(
    /\/:([A-Za-z0-9_]+)(\((?:[^()]|\([^)]*\))*\))?/g,
    (_, name: string, group?: string) => {
      names.push(name);
      return `/(?<p${names.length - 1}>${group ? group.slice(1, -1) : '[^/]+'})`;
    },
  );
  return { route: pattern.route, regex: exact ?? new RegExp(`^${source}$`), names };
}

/** Builds rows and results over a DFA, and a `miss` doing what WP-8's will. Row = tag = result index. */
function assemble(dfa: Dfa, entries: Entry[], options: Options = {}) {
  const { scanAfter = 8, scanRun = 8, methodBits = 1, allows = (_, m) => m === GET } = options;
  const counts = { extract: 0 };
  const misses: MissCall[] = [];

  const rowOf = new Int32Array(dfa.states).fill(-1);
  dfa.accepts.forEach((tags, state) => {
    if (tags !== null) rowOf[state] = tags[0];
  });
  const rows = new Int32Array(entries.length << methodBits).fill(-1);
  entries.forEach((_, tag) => {
    for (let m = 0; m < 1 << methodBits; m += 1) if (allows(tag, m)) rows[(tag << methodBits) + m] = tag;
  });

  const extractorFor = ({ regex, names }: Entry): Extractor => (path, end) => {
    counts.extract += 1;
    const found = regex.exec(path.slice(0, end));
    if (found === null) throw new Error(`extractor given a bad range: ${JSON.stringify([path, end])}`);
    return Object.fromEntries(names.map((name, i) => [name, found.groups![`p${i}`]]));
  };
  const results: Results = {
    rows,
    methodBits,
    targets: entries.map((entry) => (
      new MatchTarget(handler, entry.route, entry.names.length > 0 ? extractorFor(entry) : null)
    )),
    inexact: new Uint8Array(entries.length).fill(options.exactResults ? 0 : 1),
  };
  const table = buildTable(dfa, rowOf, { scanAfter, scanRun });

  const miss: Miss = (path, method, end, row) => {
    misses.push({ path, method, end, row });
    const stop = end >= 0 ? end : (path.indexOf('?') + 1 || path.length + 1) - 1;
    if (path.charCodeAt(0) !== SLASH) return find(`/${path.slice(0, stop)}`, method);
    if (row < 0) return null;
    const r = rows[(row << methodBits) + method];
    if (r < 0 || !entries[r].regex.test(path.slice(0, stop))) return null;
    return results.targets[r].prebuilt ?? new Match(results.targets[r], path, stop, null);
  };
  const find = createMatcher(table, results, miss);
  return { find, table, results, dfa, rowOf, misses, counts };
}

function harness(patterns: (string | FixturePattern)[], options: Options = {}) {
  const list = patterns.map((p, route) => (typeof p === 'string' ? { path: p, route } : p));
  const { dfa } = compileFixture(list);
  return assemble(dfa, list.map((p) => toEntry(p, options.exact?.[p.path])), options);
}

/** Walks the table as the hot loop would, independently of `find`, to show which way a path leaves. */
function hotExit(table: Table, path: string): { kind: 'end' | 'stop' | 'slow'; at: number } {
  let st = table.start;
  for (let i = 0; i < path.length; i += 1) {
    const c = path.charCodeAt(i);
    const x = table.tt[(st << table.shift) + table.cls[c < 128 ? c : 128]];
    if (x >= table.scan) return { kind: 'slow', at: i };
    if (x >= table.stop) return { kind: 'stop', at: i };
    st = x;
  }
  return { kind: 'end', at: path.length };
}

/** Counts `indexOf` calls for one needle while `run` executes. */
function countIndexOf(needle: string, run: () => void): number {
  const original = String.prototype.indexOf;
  let calls = 0;
  String.prototype.indexOf = function indexOf(this: string, search: string, from?: number) {
    if (search === needle) calls += 1;
    return original.call(this, search, from);
  };
  try {
    run();
  } finally {
    String.prototype.indexOf = original;
  }
  return calls;
}

/** `(/[^/?]+)+`: its scan state goes round through `/`, so one path can gallop many times. */
function segmentsDfa(): Dfa {
  const classOf = new Uint8Array(ALPHABET).fill(1);
  classOf[SLASH] = 0;
  classOf[QMARK] = 2;
  const D = -1;
  const trans = Int32Array.from([1, D, D, /**/ D, 2, D, /**/ 1, 2, D]);
  return { states: 3, classes: 3, classOf, trans, start: 0, accepts: [null, null, Int32Array.of(0)] };
}
const segmentsEntry: Entry = { route: 0, regex: /^(?:\/[^/?]+)+$/, names: [] };

function rng(seed: number) {
  let x = seed;
  return () => (x = (x * 1664525 + 1013904223) >>> 0) / 4294967296;
}

const repeat = (n: number) => 'abcdefghij'.repeat(Math.ceil(n / 10)).slice(0, n);

describe('buildTable', () => {
  test('gives NON_ASCII a class of its own, and leaves `?` where it was', () => {
    const { table, dfa } = harness(['/items/:id', '/a/b']);
    assert.notEqual(dfa.classOf.filter((k) => k === dfa.classOf[NON_ASCII]).length, 1);
    assert.equal(table.cls.filter((k) => k === table.cls[NON_ASCII]).length, 1);
    assert.equal(table.cls[NON_ASCII], dfa.classes);
    assert.equal(table.cls[QMARK], dfa.classOf[QMARK]);
    assert.equal(table.shift, 32 - Math.clz32(dfa.classes));
    assert.deepEqual([...table.cls.slice(0, NON_ASCII)], [...dfa.classOf.slice(0, NON_ASCII)]);
  });

  test('adds no class when NON_ASCII is already alone', () => {
    const { table, dfa } = harness(['/:x([^\u0000-\u007f])']);
    assert.equal(dfa.classOf.filter((k) => k === dfa.classOf[NON_ASCII]).length, 1);
    assert.deepEqual([...table.cls], [...dfa.classOf]);
    assert.equal(table.shift, 32 - Math.clz32(dfa.classes - 1));
  });

  test('splits NON_ASCII from `?` when no set holds it, leaving every transition dead', () => {
    const { table, dfa } = harness(['/a']);
    assert.equal(dfa.classOf[NON_ASCII], dfa.classOf[QMARK]);
    assert.notEqual(table.cls[NON_ASCII], table.cls[QMARK]);
    for (let st = 0; st < table.stop; st += 1) {
      assert.equal(table.tt[(st << table.shift) + table.cls[NON_ASCII]], table.stop);
    }
  });

  test('puts every NON_ASCII transition in the scan band, and leaves missing ones dead', () => {
    const { table, dfa } = harness(['/items/:id', '/items/:id(\\d+)/x', '/docs/:rest(.+)', '/a/b']);
    let live = 0;
    let dead = 0;
    for (let st = 0; st < table.stop; st += 1) {
      const x = table.tt[(st << table.shift) + table.cls[NON_ASCII]];
      assert.ok(x === table.stop || x >= table.scan, `state ${st} encodes ${x}`);
      if (st >= dfa.states) continue;
      const next = dfa.trans[st * dfa.classes + dfa.classOf[NON_ASCII]];
      assert.equal(x, next === -1 ? table.stop : table.scan + next);
      if (next === -1) dead += 1;
      else live += 1;
    }
    assert.ok(live > 0 && dead > 0);
  });

  test('remaps rowOf onto chain states, and adds scanAfter states per scan state', () => {
    const scanAfter = 3;
    const { table, dfa, rowOf } = harness(['/items/:id', '/users/:name/edit'], { scanAfter });
    const added = table.stop - dfa.states;
    assert.ok(added > 0 && added % scanAfter === 0);
    assert.equal(table.rowOf.length, table.stop);
    assert.deepEqual([...table.rowOf.slice(0, dfa.states)], [...rowOf]);

    // Each chain state must carry the row of the DFA state it copies.
    let st = table.start;
    const path = '/items/a';
    for (let i = 0; i < path.length; i += 1) st = table.tt[(st << table.shift) + table.cls[path.charCodeAt(i)]];
    assert.ok(st >= dfa.states, 'expected to be in a chain');
    assert.equal(table.rowOf[st], 0);
    const mid = '/users/a';
    st = table.start;
    for (let i = 0; i < mid.length; i += 1) st = table.tt[(st << table.shift) + table.cls[mid.charCodeAt(i)]];
    assert.ok(st >= dfa.states, 'expected to be in a chain');
    assert.equal(table.rowOf[st], -1);
  });

  for (const scanAfter of [0, 1, 2, 8]) {
    test(`stays in the table for scanAfter=${scanAfter} characters of a param`, () => {
      const { table } = harness(['/:id'], { scanAfter });
      const fits = `/${repeat(scanAfter)}`;
      assert.equal(hotExit(table, `/${repeat(scanAfter + 1)}`).kind, 'slow');
      assert.equal(hotExit(table, `/${repeat(scanAfter + 1)}`).at, scanAfter === 0 ? 1 : scanAfter + 1);
      if (scanAfter > 0) assert.equal(hotExit(table, fits).kind, 'end');
    });
  }

  test('carries scanRun through to the table', () => {
    assert.equal(harness(['/:id'], { scanRun: 5 }).table.scanRun, 5);
  });

  /** A line of states on 'a', ending in an accepting state. */
  const line = (states: number): Dfa => {
    const classOf = new Uint8Array(ALPHABET).fill(1);
    classOf[97] = 0;
    const trans = new Int32Array(states * 2).fill(-1);
    for (let s = 0; s + 1 < states; s += 1) trans[s * 2] = s + 1;
    const accepts: Dfa['accepts'] = new Array(states).fill(null);
    accepts[states - 1] = Int32Array.of(0);
    return { states, classes: 2, classOf, trans, start: 0, accepts };
  };

  test('uses 16 bits until the largest value stops fitting', () => {
    const options = { scanAfter: 8, scanRun: 8 };
    const fits = buildTable(line(32767), new Int32Array(32767).fill(-1), options);
    const over = buildTable(line(32768), new Int32Array(32768).fill(-1), options);
    assert.ok(fits.tt instanceof Uint16Array);
    assert.ok(over.tt instanceof Uint32Array);
    assert.ok(fits.scan + 32767 - 1 <= 0xffff);
    assert.ok(over.scan + 32768 - 1 > 0xffff);
  });

  test('a 32-bit table matches the same way', () => {
    const states = 33000;
    const { find, table } = assemble(line(states), [{ route: 0, regex: /^a+$/, names: [] }]);
    assert.ok(table.tt instanceof Uint32Array);
    assert.equal(find('a'.repeat(states - 1), GET)?.store, 0);
    assert.equal(find('a'.repeat(states - 2), GET), null);
  });
});

describe('Match', () => {
  const extractor = () => {
    const calls: [string, number][] = [];
    const extract: Extractor = (path, end) => {
      calls.push([path, end]);
      return { id: path.slice(1, end) };
    };
    return { calls, extract };
  };

  test('builds params on first read only, and passes path and end', () => {
    const { calls, extract } = extractor();
    const match = new Match(new MatchTarget(handler, 'store', extract), '/5?x', 2, null);
    assert.equal(calls.length, 0);
    const first = match.params;
    assert.deepEqual(first, { id: '5' });
    assert.equal(match.params, first);
    assert.equal(match.params, first);
    assert.deepEqual(calls, [['/5?x', 2]]);
  });

  test('keeps an empty params object without extracting again', () => {
    let calls = 0;
    const target = new MatchTarget(handler, 0, () => {
      calls += 1;
      return {};
    });
    const match = new Match(target, '/', 1, null);
    assert.equal(match.params, match.params);
    assert.equal(calls, 1);
  });

  test('exposes handler and store, and params spread as usual', () => {
    const match = new Match(new MatchTarget(handler, 'store', extractor().extract), '/5', 2, null);
    assert.equal(match.handler, handler);
    assert.equal(match.store, 'store');
    assert.deepEqual({ ...match.params }, { id: '5' });
  });

  test('a route with no params gets one shared Match, with frozen empty params', () => {
    const match = new MatchTarget(handler, 'store', null).prebuilt as Match;
    assert.ok(match instanceof Match);
    assert.ok(Object.isFrozen(match.params));
    assert.deepEqual(match.params, {});
    assert.equal(match.handler, handler);
    assert.equal(match.store, 'store');
  });
});

describe('find: results', () => {
  test('returns the same Match for a static route, without calling miss', () => {
    const { find, misses } = harness(['/about', '/items/:id']);
    const first = find('/about', GET);
    assert.ok(first instanceof Match);
    assert.ok(find('/items/1', GET) instanceof Match);
    assert.equal(find('/about', GET), first);
    assert.equal(find('/about?x=1', GET), first);
    assert.equal(misses.length, 0);
  });

  test('defers params, and extracts them once', () => {
    const { find, counts } = harness(['/items/:id']);
    const match = find('/items/42', GET)!;
    assert.ok(match instanceof Match);
    assert.equal(counts.extract, 0);
    assert.deepEqual(match.params, { id: '42' });
    assert.deepEqual(match.params, { id: '42' });
    assert.equal(counts.extract, 1);
    assert.equal(match.store, 0);
    assert.equal(match.handler, handler);
  });

  test('`?` ends the path', () => {
    const { find, misses } = harness(['/items/:id', '/about']);
    assert.deepEqual(find('/items/42?a=1', GET)?.params, { id: '42' });
    assert.deepEqual(find('/items/42?', GET)?.params, { id: '42' });
    assert.deepEqual(find('/items/42?a=/b/c?d', GET)?.params, { id: '42' });
    assert.equal(find('/about?x', GET)?.store, 1);
    assert.equal(misses.length, 0);
  });

  test('a trailing or doubled slash is significant', () => {
    const { find } = harness(['/items/:id', '/about']);
    assert.equal(find('/about/', GET), null);
    assert.equal(find('//about', GET), null);
    assert.equal(find('/items/42/', GET), null);
    assert.equal(find('/items//', GET), null);
  });

  test('sends a method with no result to miss, with the final row and real end', () => {
    const allows = (tag: number, m: number) => (tag === 0 ? m === 1 : m === 2);
    const { find, misses } = harness(['/a', '/b/:id'], { methodBits: 2, allows });
    assert.equal(find('/a', 1)?.store, 0);
    assert.equal(find('/b/5', 2)?.store, 1);
    assert.equal(find('/a', 2), null);
    assert.equal(find('/a?x', 0), null);
    assert.equal(find('/b/5', 3), null);
    assert.deepEqual(misses, [
      { path: '/a', method: 2, end: 2, row: 0 },
      { path: '/a?x', method: 0, end: 2, row: 0 },
      { path: '/b/5', method: 3, end: 4, row: 1 },
    ]);
  });
});

describe('find: miss', () => {
  const routes = ['/items/:id', '/items/:id/edit', '/about', '/num/:n(\\d+)'];

  test('a character in no set shares a class with `?`, but is not `?`', () => {
    const { find, misses, dfa } = harness(['/about']); // params would put `~` in a set
    assert.equal(dfa.classOf[126], dfa.classOf[QMARK], 'expected ~ to be in no set');
    assert.equal(find('/about~', GET), null);
    assert.deepEqual(misses, [{ path: '/about~', method: GET, end: -1, row: -1 }]);
  });

  test('a dead stop passes end -1 and row -1, from an accepting state too', () => {
    const { find, table, misses } = harness(routes);
    for (const path of ['/about/x', '/abc', '/num/12a', '/nope?x=1']) {
      assert.equal(hotExit(table, path).kind, 'stop', path);
      assert.equal(find(path, GET), null, path);
    }
    assert.deepEqual(misses.map(({ end, row }) => [end, row]), Array(4).fill([-1, -1]));
  });

  test('a dead stop after galloping passes end -1 and row -1', () => {
    const { find, table, misses } = harness(routes);
    const path = `/items/${repeat(40)}/nope?x=1`;
    assert.equal(hotExit(table, path).kind, 'slow');
    assert.equal(find(path, GET), null);
    assert.deepEqual(misses, [{ path, method: GET, end: -1, row: -1 }]);
  });

  test('a dead stop never searches for the end of the path', () => {
    const { table, results } = harness(routes);
    const find = createMatcher(table, results, () => null); // only the matcher's own calls count
    const calls = countIndexOf('?', () => {
      find('/abc', GET);
      find('/about/x', GET);
      find('/num/12a?x=1', GET);
    });
    assert.equal(calls, 0);
  });

  test('stopping at a real `?` in a state with no row passes the real end', () => {
    const { find, misses } = harness(routes);
    assert.equal(find('/abo?x', GET), null);
    assert.deepEqual(misses, [{ path: '/abo?x', method: GET, end: 4, row: -1 }]);
  });

  test('running out of input in a state with no row passes the real end', () => {
    const { find, misses } = harness(routes);
    assert.equal(find('/abo', GET), null);
    assert.deepEqual(misses, [{ path: '/abo', method: GET, end: 4, row: -1 }]);
  });

  test('an empty path reaches miss, with no special case', () => {
    const { find, misses } = harness([...routes, '/']);
    assert.equal(find('', GET)?.store, 4);
    assert.deepEqual(misses[0], { path: '', method: GET, end: 0, row: -1 });
  });

  test('a path with no leading `/` reaches miss, with no special case', () => {
    const { find, misses } = harness(routes);
    assert.equal(find('about', GET)?.store, 2);
    assert.deepEqual(misses[0], { path: 'about', method: GET, end: -1, row: -1 });
    misses.length = 0;
    assert.equal(find('?x', GET), null);
    assert.deepEqual(misses[0], { path: '?x', method: GET, end: 0, row: -1 });
  });
});

describe('find: long params', () => {
  for (const [scanAfter, scanRun] of [[0, 0], [0, 8], [1, 0], [2, 3], [8, 0], [8, 8]]) {
    test(`every length gives the right params with scanAfter=${scanAfter}, scanRun=${scanRun}`, () => {
      const { find, table, misses } = harness(['/items/:id', '/items/:id/edit', '/x/:a/:b'], { scanAfter, scanRun });
      const exits = new Set<string>();
      for (let length = 1; length <= 80; length += 1) {
        const id = repeat(length);
        exits.add(hotExit(table, `/items/${id}`).kind);
        assert.deepEqual(find(`/items/${id}`, GET)?.params, { id });
        assert.deepEqual(find(`/items/${id}?q=/a/b`, GET)?.params, { id });
        assert.equal(find(`/items/${id}/edit`, GET)?.store, 1);
        assert.deepEqual(find(`/items/${id}/edit?q`, GET)?.params, { id });
        assert.deepEqual(find(`/x/${id}/${id}`, GET)?.params, { a: id, b: id });
        assert.equal(find(`/items/${id}/`, GET), null);
        assert.equal(find(`/items/${id}/nope`, GET), null);
      }
      assert.ok(exits.has('slow'));
      if (scanAfter > 0) assert.ok(exits.has('end'), 'expected some lengths to stay in the hot loop');
      assert.equal(misses.filter((call) => call.row >= 0).length, 0, 'ASCII hits must not reach miss');
    });
  }

  test('a param of 100,000 characters gallops to the right end', () => {
    const { find, table } = harness(['/items/:id/edit']);
    const id = repeat(100_000);
    const path = `/items/${id}/edit?x=/y`;
    assert.equal(hotExit(table, path).kind, 'slow');
    assert.deepEqual(find(path, GET)?.params, { id });
  });

  test('gallops across segments without letting a `/` in the query end the path', () => {
    const { find, table, misses } = assemble(segmentsDfa(), [segmentsEntry]);
    const long = repeat(40);
    const path = `/${long}/${long}/${long}`;
    assert.equal(hotExit(table, path).kind, 'slow');
    assert.equal(find(path, GET)?.store, 0);
    assert.equal(find(`${path}?a=/b/c`, GET)?.store, 0);
    assert.equal(find(`${path}/`, GET), null);
    assert.equal(misses.length, 1);
    assert.deepEqual(misses[0], { path: `${path}/`, method: GET, end: path.length + 1, row: -1 });
  });

  test('searches for `?` once however many segments a path has', () => {
    const { find } = assemble(segmentsDfa(), [segmentsEntry]);
    const path = `/${repeat(40)}`.repeat(500);
    let result: RouteMatch | null = null;
    assert.equal(countIndexOf('?', () => { result = find(path, GET); }), 1);
    assert.equal(result!.store, 0);
    assert.equal(countIndexOf('?', () => { result = find(`${path}?a=1`, GET); }), 1);
    assert.equal(result!.store, 0);
  });

  test('a short gallop never reaches indexOf', () => {
    const { find } = harness(['/items/:id']);
    const calls = countIndexOf('/', () => {
      assert.ok(find(`/items/${repeat(16)}`, GET) !== null);
    });
    assert.equal(calls, 0);
  });
});

describe('find: non-ASCII', () => {
  const chars = ['é', 'ÿ', 'Ā', ' ', '😀'];

  test('/café and /cafü differ, though they share a DFA path', () => {
    const path = '/:word(caf[^\u0000-\u007f])';
    const { find, misses } = harness([path], { exact: { [path]: /^\/café$/ } });
    assert.equal(find('/café', GET)?.store, 0);
    assert.equal(find('/cafü', GET), null);
    assert.deepEqual(misses.map(({ end, row }) => [end, row]), [[5, 0], [5, 0]]);
  });

  test('.+ stays exact above ASCII', () => {
    const { find } = harness(['/docs/:rest(.+)']);
    assert.deepEqual(find('/docs/é/x', GET)?.params, { rest: 'é/x' });
    assert.equal(find('/docs/a b', GET), null);
    assert.equal(find(`/docs/${repeat(40)} `, GET), null);
  });

  test('a param that excludes one non-ASCII character is confirmed, however it was scanned', () => {
    const { find, misses } = harness(['/:x([^é/]+)']);
    assert.equal(find('/aé', GET), null);
    assert.equal(find('/aü', GET)?.store, 0);
    assert.equal(find(`/${repeat(40)}é${repeat(40)}`, GET), null);
    assert.equal(find(`/${repeat(40)}ü${repeat(40)}`, GET)?.store, 0);
    assert.deepEqual(misses.map(({ row }) => row), [0, 0, 0, 0]);
  });

  test('at every position in a param, the path reaches miss with its real end and row', () => {
    const { find, misses, table } = harness(['/items/:id', '/items/:id/edit']);
    const exits = new Set<string>();
    for (const ch of chars) {
      for (let length = 1; length <= 48; length += 1) {
        for (let at = 0; at < length; at += 1) {
          const id = `${repeat(at)}${ch}${repeat(length - at - 1)}`;
          for (const [path, row, want] of [
            [`/items/${id}`, 0, 0],
            [`/items/${id}?q=1`, 0, 0],
            [`/items/${id}/edit`, 1, 1],
          ] as const) {
            exits.add(hotExit(table, path).kind);
            misses.length = 0;
            const match = find(path, GET);
            assert.equal(match?.store, want, path);
            assert.deepEqual(match?.params, { id }, path);
            const end = path.indexOf('?') < 0 ? path.length : path.indexOf('?');
            assert.deepEqual(misses, [{ path, method: GET, end, row }], path);
          }
        }
      }
    }
    assert.deepEqual([...exits], ['slow'], 'every one of these paths must leave the hot loop');
  });

  test('a character skipped by indexOf is found, for any scanAfter and scanRun', () => {
    for (const [scanAfter, scanRun] of [[0, 0], [1, 0], [2, 3], [8, 0], [8, 8]]) {
      const { find, misses } = harness(['/items/:id'], { scanAfter, scanRun });
      const path = `/items/${repeat(200)}é${repeat(200)}`;
      assert.ok(find(path, GET) !== null);
      assert.deepEqual(misses, [{ path, method: GET, end: path.length, row: 0 }]);
      misses.length = 0;
      const last = `/items/${repeat(200)}é`;
      assert.ok(find(last, GET) !== null);
      assert.deepEqual(misses, [{ path: last, method: GET, end: last.length, row: 0 }]);
    }
  });

  test('a character skipped in any of several galloped segments is found', () => {
    const { find, misses } = assemble(segmentsDfa(), [segmentsEntry]);
    const long = repeat(40);
    for (const path of [
      `/${long}é${long}/${long}/${long}`,
      `/${long}/${long}é${long}/${long}`,
      `/${long}/${long}/${long}é${long}`,
    ]) {
      misses.length = 0;
      assert.equal(find(path, GET)?.store, 0, path);
      assert.deepEqual(misses, [{ path, method: GET, end: path.length, row: 0 }], path);
    }
  });

  test('an exact result needs no confirming, even on a non-ASCII path', () => {
    const { find, misses } = harness(['/x/:v'], { exactResults: true });
    assert.ok(find('/x/é', GET));
    assert.ok(find(`/x/${'a'.repeat(100)}é${'a'.repeat(100)}`, GET));
    assert.deepEqual(misses, []);
  });

  test('characters in the query do not flag the path', () => {
    const { find, misses, table } = harness(['/items/:id']);
    const long = repeat(40);
    assert.deepEqual(find('/items/5?q=é', GET)?.params, { id: '5' });
    assert.equal(hotExit(table, `/items/${long}?q=é`).kind, 'slow');
    assert.deepEqual(find(`/items/${long}?q=é`, GET)?.params, { id: long });
    assert.deepEqual(find(`/items/${long}?q=é/é`, GET)?.params, { id: long });
    assert.equal(misses.length, 0);
  });

  test('a missing transition is an exact rejection, with end -1 and row -1', () => {
    const { find, misses, table } = harness(['/num/:n(\\d+)', '/items/:id/edit']);
    assert.equal(hotExit(table, '/num/1é').kind, 'stop');
    assert.equal(find('/num/1é', GET), null);
    assert.equal(find('/é', GET), null);
    assert.deepEqual(misses.map(({ end, row }) => [end, row]), [[-1, -1], [-1, -1]]);
  });

  test('a flagged path that dies part-way passes end -1 and row -1', () => {
    const { find, misses, table } = harness(['/items/:id/edit']);
    for (const path of ['/items/é/nope', `/items/${repeat(40)}é${repeat(40)}/nope?q=1`]) {
      assert.equal(hotExit(table, path).kind, 'slow', path);
      misses.length = 0;
      assert.equal(find(path, GET), null, path);
      assert.deepEqual(misses, [{ path, method: GET, end: -1, row: -1 }], path);
    }
  });

  test('a flagged path with no row for the method still passes its real end and row', () => {
    const { find, misses } = harness(['/items/:id'], { methodBits: 2, allows: (_, m) => m === 1 });
    assert.equal(find('/items/é', 2), null);
    assert.deepEqual(misses, [{ path: '/items/é', method: 2, end: 8, row: 0 }]);
  });
});

/** Compares `find` with the reference on route and params, and counts how each path left. */
function compareWithReference(routes: any[], urls: string[]) {
  const reference = createReference(routes);
  const patterns = routes.flatMap((route, id) => route.concretePaths.map((path: string) => ({ path, route: id })));
  const { find, table, misses } = harness(patterns);
  const seen = { hits: 0, hot: 0, slow: 0, flagged: 0 };
  const mismatches: unknown[] = [];
  for (const url of urls) {
    const want = reference(url);
    const got = find(url, GET);
    if (want !== null) seen.hits += 1;
    if (hotExit(table, url).kind === 'slow') seen.slow += 1;
    else seen.hot += 1;
    const gotShape = got === null ? null : { route: got.store, params: { ...got.params } };
    try {
      assert.deepEqual(gotShape, want === null ? null : { route: want.route, params: { ...want.params } });
    } catch {
      if (mismatches.length < 5) mismatches.push({ url, want, got: gotShape });
      else mismatches.length += 0;
      seen.flagged += 0;
      assert.fail(`mismatch: ${JSON.stringify(mismatches)}`);
    }
  }
  seen.flagged = misses.filter((call) => call.row >= 0).length;
  return seen;
}

/** A sample of the corpus, with verify.mjs's mutations, plus params long enough to gallop. */
function sampleUrls(corpus: string[], seed: number): string[] {
  const random = rng(seed);
  const unique = [...new Set(corpus)];
  const pick = () => unique[Math.floor(random() * unique.length)];
  const chars = 'abz09-/?_%é';
  const urls: string[] = [];
  for (let i = 0; i < 15_000; i += 1) urls.push(pick());
  for (let i = 0; i < 15_000; i += 1) {
    const url = pick();
    const at = Math.floor(random() * (url.length + 1));
    const ch = chars[Math.floor(random() * chars.length)];
    switch (i % 6) {
      case 0: urls.push(url.slice(0, at) + ch + url.slice(at + 1)); break;
      case 1: urls.push(url.slice(0, at) + ch + url.slice(at)); break;
      case 2: urls.push(url.slice(0, at) + url.slice(at + 1)); break;
      case 3: urls.push(`${url}/`); break;
      case 4: urls.push(`${url}/extra`); break;
      default: urls.push(`${url}?a=1&b=/x/y`); break;
    }
  }
  for (let i = 0; i < 6_000; i += 1) {
    const segments = pick().split('/');
    const at = 1 + Math.floor(random() * (segments.length - 1));
    const middle = i % 3 === 0 ? 'é' : '';
    segments[at] = `${repeat(20 + (i % 60))}${middle}${repeat(i % 40)}`;
    urls.push(segments.join('/'));
  }
  return urls;
}

const specificPath = fileURLToPath(new URL('../../bench/routes-specific.mjs', import.meta.url));
const specificUrlsPath = fileURLToPath(new URL('../../bench/routes-specific.urls.mjs', import.meta.url));
const hasSpecific = existsSync(specificPath) && existsSync(specificUrlsPath);
if (!hasSpecific) console.log('# SKIPPING routes-specific: bench/routes-specific*.mjs are not present');

describe('find: route sets', () => {
  test('generic routes: zero mismatches against the reference', async () => {
    const { routes, precomputedUrls } = await import('../../bench/routes-generic.mjs');
    const seen = compareWithReference(routes, sampleUrls(precomputedUrls, SEEDS.corpus));
    console.log('# generic', JSON.stringify(seen));
    assert.ok(seen.hits > 0 && seen.hot > 0 && seen.slow > 0 && seen.flagged > 0, JSON.stringify(seen));
  });

  test('specific routes: zero mismatches against the reference', { skip: !hasSpecific }, async () => {
    const { routes } = await import(specificPath);
    const { precomputedUrls } = await import(specificUrlsPath);
    const seen = compareWithReference(routes, sampleUrls(precomputedUrls, SEEDS.corpus));
    console.log('# specific', JSON.stringify(seen));
    assert.ok(seen.hits > 0 && seen.hot > 0 && seen.slow > 0 && seen.flagged > 0, JSON.stringify(seen));
  });

  for (const [scanAfter, scanRun] of [[0, 0], [1, 0], [2, 3], [8, 8]]) {
    test(`random paths agree with the reference at scanAfter=${scanAfter}, scanRun=${scanRun}`, () => {
      const routes = [
        { concretePaths: ['/'] },
        { concretePaths: ['/about/team'] },
        { concretePaths: ['/items/:id'] },
        { concretePaths: ['/items/:id/edit'] },
        { concretePaths: ['/num/:n(\\d+)'] },
        { concretePaths: ['/users/:user/posts/:post'] },
        { concretePaths: ['/docs/:rest(.+)'] },
      ];
      const reference = createReference(routes);
      const patterns = routes.flatMap((route, id) => route.concretePaths.map((path) => ({ path, route: id })));
      const { find } = harness(patterns, { scanAfter, scanRun });
      const pieces = [
        '/', '/', '/', '?', 'about', 'team', 'items', 'edit', 'num', 'users', 'posts', 'docs',
        '12', 'a', '-', '~', 'é', ' ', '😀', repeat(9), repeat(17), repeat(45),
      ];
      const random = rng(SEEDS.fuzz);
      for (let i = 0; i < 40_000; i += 1) {
        let url = random() < 0.9 ? '/' : '';
        for (let k = Math.floor(random() * 8); k > 0; k -= 1) url += pieces[Math.floor(random() * pieces.length)];
        const want = reference(url);
        const got = find(url, GET);
        const gotShape = got === null ? null : { route: got.store, params: { ...got.params } };
        const wantShape = want === null ? null : { route: want.route, params: { ...want.params } };
        assert.deepEqual(gotShape, wantShape, `seed ${SEEDS.fuzz}, url ${JSON.stringify(url)}`);
      }
    });
  }
});
