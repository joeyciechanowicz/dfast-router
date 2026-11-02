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
};
