'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

// Isolate BEFORE require: with v0.7 the tool-cache persists to <AURA_HOME>, so an
// unisolated run would both seed assertions from the real cache and ZERO the live
// file via clearToolCache().
process.env.AURA_HOME = path.join(os.tmpdir(), 'aura-toolcache-unit-' + Date.now() + '-' + process.pid);
const { wrap, toolStats, clearToolCache, pickTtl, isMutating } = require('./lib/tool-cache');

test('repeat call with same args is served from cache (fn runs once)', async () => {
  clearToolCache();
  let calls = 0;
  const readFile = wrap('read_file', async (a) => { calls++; return `contents of ${a.path}`; });
  const a = await readFile({ path: 'config.json' });
  const b = await readFile({ path: 'config.json' });
  assert.strictEqual(a, b);
  assert.strictEqual(calls, 1, 'underlying tool ran only once');
  assert.strictEqual(toolStats().hits, 1);
  assert.ok(toolStats().tokensSaved > 0);
});

test('different args are distinct cache entries', async () => {
  clearToolCache();
  let calls = 0;
  const read = wrap('read_file', async (a) => { calls++; return a.path; });
  await read({ path: 'a.txt' });
  await read({ path: 'b.txt' });
  await read({ path: 'a.txt' }); // cached
  assert.strictEqual(calls, 2);
});

test('mutating tools are NEVER cached (safety)', async () => {
  clearToolCache();
  let calls = 0;
  const writeFile = wrap('write_file', async (a) => { calls++; return 'ok'; });
  await writeFile({ path: 'x', data: '1' });
  await writeFile({ path: 'x', data: '1' });
  assert.strictEqual(calls, 2, 'write ran both times — state changes are never served from cache');
  // underscore + camelCase names must still be recognized as mutating (the bug this caught)
  assert.strictEqual(isMutating('write_file'), true);
  assert.strictEqual(isMutating('deploy_prod'), true);
  assert.strictEqual(isMutating('send_payment'), true);
  assert.strictEqual(isMutating('sendPayment'), true);
  assert.strictEqual(isMutating('delete-user'), true);
  assert.strictEqual(isMutating('read_file'), false);
  assert.strictEqual(isMutating('get_price'), false);
});

test('argument order does not create a false miss', async () => {
  clearToolCache();
  let calls = 0;
  const q = wrap('search', async () => { calls++; return 'result'; });
  await q({ a: 1, b: 2 });
  await q({ b: 2, a: 1 }); // same args, different key order
  assert.strictEqual(calls, 1);
});

test('volatility-aware TTLs: prices short, file reads long', () => {
  assert.ok(pickTtl('get_price') <= 60 * 1000);
  assert.ok(pickTtl('read_file') >= 60 * 60 * 1000);
  assert.strictEqual(pickTtl('anything', 1234), 1234); // explicit override wins
});

test('null result is a soft miss (retried), not cached by default', async () => {
  clearToolCache();
  let calls = 0;
  const flaky = wrap('fetch_data', async () => { calls++; return calls === 1 ? null : 'ok'; });
  assert.strictEqual(await flaky({ id: 1 }), null);
  assert.strictEqual(await flaky({ id: 1 }), 'ok'); // not served the null
  assert.strictEqual(calls, 2);
});
