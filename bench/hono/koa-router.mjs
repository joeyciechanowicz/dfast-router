import KoaRouter from "koa-router";
import { routes, handler } from "./tool.mjs";

const name = "koa-router";
const router = new KoaRouter();

for (const route of routes) {
  if (route.method === "GET") {
    // path-to-regexp v8 (koa-router 14) requires named wildcards
    router.get(route.path.replace(/\/\*$/, "/*splat"), handler);
  } else {
    router.post(route.path, handler);
  }
}

export const koaRouter = {
  name,
  match: (route) => {
    router.match(route.path, route.method); // only matching
  },
  // match() only finds layers. Params come later, from the layer, so they aren't checked.
  inspect: (route) => {
    const { pathAndMethod } = router.match(route.path, route.method);
    return pathAndMethod.length === 0 ? null : { handler: pathAndMethod[0].stack[0], params: null };
  },
};
