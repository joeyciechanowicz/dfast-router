import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../src/index';
import type { Params, RouteHandler, RouteMethod } from '../src/index';

// `npm run typecheck` is what checks this file: tsx strips types. Each `@ts-expect-error` is a call
// that must not compile, and those calls are harmless at runtime.

interface Meta {
  auth: boolean;
}
interface Req {
  url: string;
}
interface Res {
  body: string;
}

const noop = () => {};

test('no type argument: any handler, and an optional store of unknown type', () => {
  const router = createRouter();
  router.on('GET', '/a', noop).on('POST', '/a', noop, { feature: 'beta' });
  const store: unknown = router.find('POST', '/a')?.store;
  assert.deepEqual(store, { feature: 'beta' });
});

test('methods: every standard method, `*`, and arrays that may be readonly', () => {
  const methods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE'] as const;
  const router = createRouter().on(methods, '/all', noop).on('*', '/any', noop).on(['GET', 'POST'], '/two', noop);
  for (const method of methods) assert.ok(router.find(method, '/all'));
  assert.ok(router.find('PURGE', '/any'));
});

test('methods: anything else does not compile', () => {
  const router = createRouter();
  // @ts-expect-error not an HTTP method
  router.on('FETCH', '/a', noop);
  // @ts-expect-error the type is uppercase, though JS callers get normalized
  router.on('get', '/b', noop);
  // @ts-expect-error one bad method in the array
  router.on(['GET', 'NOPE'], '/c', noop);
  const widened: string = 'GET';
  // @ts-expect-error a plain string could be anything
  router.on(widened, '/d', noop);
  assert.ok(router.find('GET', '/d'));
});

test('find takes any string, because it gets a runtime value', () => {
  const method: string = 'PURGE';
  const custom = 'PURGE' as RouteMethod;
  assert.ok(createRouter().on(custom, '/a', noop).find(method, '/a'));
});

test('a Node handler takes req and res after params and store', () => {
  type Handler = (params: Params, store: Meta, req: Req, res: Res) => void;
  const router = createRouter<Handler>();
  router.on('GET', '/users/:id', (params, store, req, res) => {
    res.body = `${params.id} ${store.auth} ${req.url}`;
  }, { auth: true });

  const match = router.find('GET', '/users/42');
  assert.ok(match);
  const res = { body: '' };
  match.handler(match.params, match.store, { url: '/users/42' }, res);
  assert.equal(res.body, '42 true /users/42');
  // @ts-expect-error req and res are required
  assert.throws(() => match.handler(match.params, match.store));
});

test('a browser handler needs no req or res, and keeps its return type', () => {
  type Handler = (params: Params, store: Meta) => { title: string };
  const router = createRouter<Handler>();
  router.on('*', '/docs/:page', (params) => ({ title: params.page }), { auth: false });

  const match = router.find('GET', '/docs/intro');
  assert.ok(match);
  const title: string = match.handler(match.params, match.store).title;
  assert.equal(title, 'intro');
});

test('RouteHandler<TStore> types the store alone', () => {
  const router = createRouter<RouteHandler<Meta>>();
  router.on('GET', '/a', (_, store) => store.auth, { auth: true });
  const auth: boolean | undefined = router.find('GET', '/a')?.store.auth;
  assert.equal(auth, true);
});

test('a store whose type excludes undefined must be given, and must fit', () => {
  const router = createRouter<(params: Params, store: Meta) => void>();
  // @ts-expect-error the handler would get undefined
  router.on('GET', '/missing', noop);
  // @ts-expect-error the wrong shape
  router.on('GET', '/wrong', noop, { auth: 'yes' });
  router.on('GET', '/right', noop, { auth: true });
  assert.equal(router.find('GET', '/right')?.store.auth, true);
});

test('a store whose type allows undefined is optional', () => {
  const router = createRouter<(params: Params, store: Meta | undefined) => void>();
  router.on('GET', '/none', noop).on('GET', '/some', noop, { auth: true });
  assert.equal(router.find('GET', '/none')?.store, undefined);
  assert.equal(router.find('GET', '/some')?.store?.auth, true);
});

test('a handler that ignores the store leaves it optional', () => {
  const router = createRouter<(params: Params) => string>();
  router.on('GET', '/a', () => 'a');
  const match = router.find('GET', '/a');
  assert.equal(match?.handler(match.params), 'a');
});

test('a handler must take params first', () => {
  // @ts-expect-error the old (req, res, params) shape
  assert.ok(createRouter<(req: Req, res: Res, params: Params) => void>());
});

test('params are read-only', () => {
  const match = createRouter().on('GET', '/static', noop).find('GET', '/static');
  assert.ok(match);
  assert.ok(Object.isFrozen(match.params));
  // Never called: only strict-mode code throws on the write.
  const write = () => {
    // @ts-expect-error frozen on a route with no params (D5)
    match.params.x = 'y';
  };
  assert.ok(write);
});
