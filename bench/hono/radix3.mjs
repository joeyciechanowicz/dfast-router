import { createRouter } from "radix3";
import { routes, handler } from "./tool.mjs";

const name = "radix3";
const router = createRouter();

for (const route of routes) {
  router.insert(route.path, handler);
}

export const radix3Router = {
  name,
  match: (route) => {
    router.lookup(route.path);
  },
};
