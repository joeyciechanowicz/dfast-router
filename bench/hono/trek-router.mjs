import TrekRouter from "trek-router";
import { routes, handler } from "./tool.mjs";

const name = "trek-router";

const router = new TrekRouter();
for (const route of routes) {
  router.add(route.method, route.path, handler());
}

export const trekRouter = {
  name,
  match: (route) => {
    router.find(route.method, route.path);
  },
};
