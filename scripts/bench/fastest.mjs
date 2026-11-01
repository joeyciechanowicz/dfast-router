// One message for each reason `target` can't be called the fastest. No messages means it is.
// A router with no result fails too: bench.mjs logs a router that won't build and still exits 0, so
// otherwise a rival that dropped out would count as beaten.
export function findFastestFailures(results, routerNames, target) {
  const measured = new Map(results.filter(({ hz }) => hz > 0).map((entry) => [entry.name, entry]));
  const failures = routerNames
    .filter((name) => !measured.has(name))
    .map((name) => `${name} has no result`);

  const targetEntry = measured.get(target);
  if (!targetEntry) return failures;

  for (const name of routerNames) {
    const entry = measured.get(name);
    if (entry && entry.hz > targetEntry.hz) {
      const lead = (entry.hz / targetEntry.hz).toFixed(2);
      failures.push(
        `${name} is ${lead}x faster than ${target}: ${Math.round(entry.hz)} vs ${Math.round(targetEntry.hz)} ops/sec`,
      );
    }
  }
  return failures;
}
