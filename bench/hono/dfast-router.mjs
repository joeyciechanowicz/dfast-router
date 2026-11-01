import { createRequire } from "node:module";
import { routes, handler } from "./tool.mjs";

const require = createRequire(import.meta.url);
// The built package, as the main bench uses. Run `npm run build` first.
const { createRouter } = require("../../dist/index.js");

export function buildDfastRouter() {
  const router = createRouter();
  for (const route of routes) router.on(route.method, route.path, handler);
  router.compile();
  return router;
}

const router = buildDfastRouter();

// dfast-router builds params on first read, and every other router here builds them eagerly. So
// the adapter reads them, as a handler would, or the comparison would flatter it.
export const dfastRouter = {
  name: "dfast-router",
  match: (route) => {
    const match = router.find(route.method, route.path);
    return match.handler === handler ? match.params : null;
  },
};

// The same lookup with params left unread, to show what lazy params save.
export const dfastRouterUnread = {
  name: "dfast-router (params unread)",
  match: (route) => router.find(route.method, route.path),
};
