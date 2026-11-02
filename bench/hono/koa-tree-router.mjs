import KoaRouter from "koa-tree-router";
import { routes, handler } from "./tool.mjs";

const name = "koa-tree-router";
const router = new KoaRouter();

for (const route of routes) {
  router.on(route.method, route.path.replace("*", "*foo"), handler);
}

export const koaTreeRouter = {
  name,
  match: (route) => {
    router.find(route.method, route.path);
  },
  inspect: (route) => {
    const { handle, params } = router.find(route.method, route.path);
    if (!handle) return null;
    return { handler: handle[0], params: Object.fromEntries(params.map((p) => [p.key, p.value])) };
  },
};
