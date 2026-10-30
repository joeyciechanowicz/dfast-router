import { compile } from "./rc.mjs";
for (const k of [4, 8, 10, 12, 14]) {
  const t = performance.now();
  const d = compile([{ path: `/x/:a([ab]*a[ab]{${k}})`, route: 0 }], { acceptByPattern: true });
  console.log(`k=${k}: 1 route -> raw=${d.rawStates} min=${d.states} states, ${(performance.now() - t).toFixed(0)}ms`);
}
