export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'CONNECT' | 'TRACE';

/** A method a route can name. `*` matches any method. */
export type RouteMethod = HttpMethod | '*';

/** Frozen on a route with no params, which shares one result between matches (D5). */
export type Params = Readonly<Record<string, string>>;

/**
 * The router only hands the handler back, so the application decides how to call it. `rest` is for
 * what it adds, such as `req` and `res`. Without it, a handler taking them wouldn't fit this type.
 */
export type RouteHandler<TStore = unknown> = (params: Params, store: TStore, ...rest: any[]) => unknown;

/** The type of a handler's second param, which is what `on` takes as `store`. */
export type StoreOf<THandler> = THandler extends (params: any, store: infer TStore, ...rest: any[]) => unknown
  ? TStore
  : never;

export interface RouteMatch<THandler extends RouteHandler<any> = RouteHandler> {
  handler: THandler;
  params: Params;
  store: StoreOf<THandler>;
}
