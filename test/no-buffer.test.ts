import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Runs the compiled JS in plain node, because tsx itself needs `Buffer` to load a file. `matcher.ts`
// picks its check when it loads, so `Buffer` has to be gone by then.
test('non-ASCII checks work without Buffer, as in a browser', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'dfast-router-'));
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json', '--outDir', outDir]);

  const script = `
    delete globalThis.Buffer;
    const { createRouter } = require(${JSON.stringify(outDir)});
    const router = createRouter().on('GET', '/not/:v([^é]+)', () => {}).on('GET', '/n/:v([^é]*)', () => {});
    const long = 'a'.repeat(100);
    const paths = ['/not/short', '/not/' + long, '/not/' + long + 'ü' + long, '/not/' + long + 'é' + long,
      '/n/' + 'a/'.repeat(50), '/n/' + 'a/'.repeat(50) + 'é', '/n/' + 'a/'.repeat(50) + '?q=é'];
    console.log(JSON.stringify(paths.map((path) => router.find('GET', path) !== null)));
  `;
  const output = execFileSync(process.execPath, ['--eval', script], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), [true, true, true, false, true, false, true]);
});
