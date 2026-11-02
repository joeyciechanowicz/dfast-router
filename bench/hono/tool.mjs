// Ported from honojs/hono benchmarks/routers/src/tool.mts. Keep these routes as they are there,
// so results line up with Hono's published numbers.
export const handler = () => {};

export const routes = [
  { method: "GET", path: "/user" },
  { method: "GET", path: "/user/comments" },
  { method: "GET", path: "/user/avatar" },
  { method: "GET", path: "/user/lookup/username/:username" },
  { method: "GET", path: "/user/lookup/email/:address" },
  { method: "GET", path: "/event/:id" },
  { method: "GET", path: "/event/:id/comments" },
  { method: "POST", path: "/event/:id/comment" },
  { method: "GET", path: "/map/:location/events" },
  { method: "GET", path: "/status" },
  { method: "GET", path: "/very/deeply/nested/route/hello/there" },
  { method: "GET", path: "/static/*" },
];

// The URLs Hono's bench looks up, one per group. `params` is ours, for check.mjs: the values a
// router should capture. Only values, since routers name a wildcard differently.
export const benchRoutes = [
  { name: "short static", method: "GET", path: "/user", params: [] },
  { name: "static with same radix", method: "GET", path: "/user/comments", params: [] },
  { name: "dynamic route", method: "GET", path: "/user/lookup/username/hey", params: ["hey"] },
  { name: "mixed static dynamic", method: "GET", path: "/event/abcd1234/comments", params: ["abcd1234"] },
  { name: "post", method: "POST", path: "/event/abcd1234/comment", params: ["abcd1234"] },
  { name: "long static", method: "GET", path: "/very/deeply/nested/route/hello/there", params: [] },
  { name: "wildcard", method: "GET", path: "/static/index.html", params: ["index.html"] },
];
