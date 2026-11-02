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
  // radix3 spreads the data it was given into its result, and a function spreads to nothing, so
  // there's no handler to check. It also ignores the method.
  inspect: (route) => {
    const match = router.lookup(route.path);
    return match && { handler: undefined, params: match.params };
  },
};
