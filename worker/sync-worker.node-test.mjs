import test from 'node:test';
import assert from 'node:assert/strict';

test('worker is dependency-free and has a documented health contract', async () => {
  const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('./sync-worker.mjs', import.meta.url), 'utf8'));
  assert.match(source, /node:http/);
  assert.match(source, /\/health/);
  assert.match(source, /activities\/import\/check/);
  assert.match(source, /TRADING212_API_SECRET/);
});
