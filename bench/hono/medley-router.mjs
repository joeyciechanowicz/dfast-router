import Router from "@medley/router";
import { routes, handler } from "./tool.mjs";

const name = "@medley/router";
const router = new Router();

for (const route of routes) {
  const store = router.register(route.path);
  store[route.method] = handler;
}

export const medleyRouter = {
  name,
  match: (route) => {
    const match = router.find(route.path);
    match.store[route.method]; // get handler
  },
  inspect: (route) => {
    const match = router.find(route.path);
    return match && match.store[route.method] ? { handler: match.store[route.method], params: match.params } : null;
  },
};
