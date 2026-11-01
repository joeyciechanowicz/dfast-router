import findMyWay from "find-my-way";
import { routes, handler } from "./tool.mjs";

const name = "find-my-way";
const router = findMyWay();

for (const route of routes) {
  router.on(route.method, route.path, handler);
}

export const findMyWayRouter = {
  name,
  match: (route) => {
    router.find(route.method, route.path);
  },
};
