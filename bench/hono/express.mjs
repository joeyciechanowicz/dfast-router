import express from "express";
import { routes, handler } from "./tool.mjs";

const router = express.Router();
const name = "express (WARNING: includes handling)";

for (const route of routes) {
  // path-to-regexp v8 (express 5) requires named wildcards
  const path = route.path.replace(/\/\*$/, "/*splat");
  if (route.method === "GET") {
    router.route(path).get(handler);
  } else {
    router.route(path).post(handler);
  }
}

export const expressRouter = {
  name,
  match: (route) => {
    router.handle({ method: route.method, url: route.path }, {}, () => {});
  },
  // Express runs the handler, not returns it. Its routing is synchronous, so a miss has called
  // `done` by the time handle() returns.
  inspect: (route) => {
    const req = { method: route.method, url: route.path };
    let missed = false;
    router.handle(req, {}, () => {
      missed = true;
    });
    return missed ? null : { handler, params: req.params };
  },
};
