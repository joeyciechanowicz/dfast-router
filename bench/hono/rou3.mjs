import { addRoute, createRouter, findRoute } from "rou3";
import { handler, routes } from "./tool.mjs";

const name = "rou3";
const router = createRouter();

for (const route of routes) {
  addRoute(router, route.path, route.method, handler);
}

export const rou3Router = {
  name,
  match: (route) => {
    findRoute(router, route.path, route.method, {
      ignoreParams: false, // Don't ignore params
    });
  },
};
