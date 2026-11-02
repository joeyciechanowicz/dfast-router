import { Memoirist } from "memoirist";
import { routes, handler } from "./tool.mjs";

const name = "Memoirist";
const router = new Memoirist();

for (const route of routes) {
  router.add(route.method, route.path, handler);
}

export const memoiristRouter = {
  name,
  match: (route) => {
    router.find(route.method, route.path);
  },
  inspect: (route) => {
    const match = router.find(route.method, route.path);
    return match && { handler: match.store, params: match.params };
  },
};
