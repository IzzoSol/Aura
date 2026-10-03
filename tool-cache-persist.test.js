'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

// Persistent tool-cache integration test. The interesting property (stats + entries
// survive a PROCESS RESTART) requires actual separate node processes, so we spawn
// children with an isolated AURA_HOME and talk to them over stdout.
const REPO = __dirname;

// fresh HOME per test so persisted stats from one test never seed the next
function freshHome() { return path.join(os.tmpdir(), 'aura-toolcache-test-' + Date.now() + '-' + process.pid); }

function runChild(code, home) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', code], { cwd: REPO, env: Object.assign({}, process.env, { AURA_HOME: home }) },
      (err, stdout, stderr) => { if (err) reject(new Error(err.message + '\n' + stderr)); else resolve(stdout.trim()); });
  });
}

test('tool-cache: savings persist across process restarts', async () => {
  const HOME = freshHome();
  // session 1 — miss + fetch, exit (exit flush persists)
  await runChild(`(async () => {
    const { wrap, toolStats } = require('./lib/tool-cache');
    const readFile = wrap('read_file', async (a) => 'contents of ' + a.path);
    await readFile({ path: 'config.json' });
    console.log(JSON.stringify(toolStats()));
  })()`, HOME);
  const file = path.join(HOME, 'aura-tool-cache.json');
  assert.ok(fs.existsSync(file), 'persist file written');
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(disk.stats.misses, 1, 'miss stat persisted');
  assert.ok(Object.keys(disk.entries).length === 1, 'entry persisted');

  // session 2 — fresh process: SAME call must be a HIT and must NOT run the tool
  const out = await runChild(`(async () => {
    const { wrap, toolStats } = require('./lib/tool-cache');
    let ran = 0;
    const readFile = wrap('read_file', async (a) => { ran++; return 'SHOULD NOT RUN'; });
    const v = await readFile({ path: 'config.json' });
    console.log(JSON.stringify({ v, ran, stats: toolStats() }));
  })()`, HOME);
  const j = JSON.parse(out);
  assert.strictEqual(j.v, 'contents of config.json', 'result revived from disk');
  assert.strictEqual(j.ran, 0, 'underlying tool never ran');
  assert.strictEqual(j.stats.hits, 1, 'hit counted in the fresh process');
  assert.ok(j.stats.tokensSaved > 0, 'tokensSaved carried across restart');
});

test('tool-cache: multi-arg tools are cached per argument set', async () => {
  const out = await runChild(`(async () => {
    const { wrap, toolStats } = require('./lib/tool-cache');
    let calls = 0;
    const add = wrap('add_values', async (a, b) => { calls++; return a + b; });
    await add(2, 3);
    await add(2, 3);
    await add(10, 20);
    console.log(JSON.stringify({ calls, stats: toolStats() }));
  })()`, freshHome());
  const j = JSON.parse(out);
  assert.strictEqual(j.calls, 2, 'same args ran once, different args ran');
  assert.strictEqual(j.stats.hits, 1);
  assert.strictEqual(j.stats.misses, 2);
});

test('tool-cache: object arg order does not split the cache', async () => {
  const out = await runChild(`(async () => {
    const { wrap, toolStats } = require('./lib/tool-cache');
    let calls = 0;
    const get = wrap('get_user', async (q) => { calls++; return q.name; });
    await get({ name: 'x', id: 1 });
    await get({ id: 1, name: 'x' });
    console.log(JSON.stringify({ calls }));
  })()`, freshHome());
  const j = JSON.parse(out);
  assert.strictEqual(j.calls, 1, 'keyed content-wise, not insertion-order-wise');
});

test('tool-cache: AURA_TOOL_CACHE_PERSIST=0 disables the disk layer', async () => {
  const off = path.join(os.tmpdir(), 'aura-toolcache-off-' + Date.now() + '-' + process.pid);
  await new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', `(async () => {
      const { wrap, toolStats } = require('./lib/tool-cache');
      const f = wrap('read_file', async (a) => 'v');
      await f({ p: 1 });
      console.log(JSON.stringify(toolStats()));
    })()`], { cwd: REPO, env: Object.assign({}, process.env, { AURA_HOME: off, AURA_TOOL_CACHE_PERSIST: '0' }) },
      (err, stdout) => { if (err) reject(err); else resolve(stdout.trim()); });
  });
  assert.ok(!fs.existsSync(path.join(off, 'aura-tool-cache.json')), 'no file written when disabled');
});

test('tool-cache: clearToolCache wipes stats AND disk', async () => {
  const HOME = freshHome();
  await runChild(`(async () => {
    const { wrap, toolStats, clearToolCache } = require('./lib/tool-cache');
    const f = wrap('read_file', async (a) => 'v');
    await f({ p: 1 });
    clearToolCache();
    console.log(JSON.stringify(toolStats()));
  })()`, HOME);
  const file = path.join(HOME, 'aura-tool-cache.json');
  assert.ok(fs.existsSync(file), 'zero-file written by clear');
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(disk.stats.misses, 0, 'stats zeroed');
  assert.strictEqual(Object.keys(disk.entries).length, 0, 'entries emptied');
});

test('tool-cache: SECRET-BEARING tool results never hit the disk (audit fix)', async () => {
  const HOME = freshHome();
  await runChild(`(async () => {
    const { wrap, flush } = require('./lib/tool-cache');
    const catEnv = wrap('read_file', async (a) => 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENGbPxRfiCYEXAMPLEKEY');
    await catEnv({ path: '.env' });
    const normal = wrap('read_file', async (a) => 'plain config text');
    await normal({ path: 'config.json' });
    flush(true);
  })()`, HOME);
  const file = path.join(HOME, 'aura-tool-cache.json');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('wJalrXUtnFEMI'), 'no secret material persisted');
  assert.ok(!raw.includes('SECRET_ACCESS_KEY'), 'no secret key name persisted');
  const disk = JSON.parse(raw);
  assert.strictEqual(Object.keys(disk.entries).length, 1, 'only the clean entry persisted (secret stays memory-only)');
});

test('tool-cache: oversized values stay memory-only (no 1GB persist file)', async () => {
  const HOME = freshHome();
  await runChild(`(async () => {
    const { wrap, flush } = require('./lib/tool-cache');
    const dump = wrap('read_file', async (a) => 'x'.repeat(400 * 1000)); // 400KB — over the 100KB persist cap
    await dump({ path: 'huge.log' });
    flush(true);
  })()`, HOME);
  const file = path.join(HOME, 'aura-tool-cache.json');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(raw.length < 150 * 1000, 'persist file stays small');
  const disk = JSON.parse(raw);
  assert.strictEqual(Object.keys(disk.entries).length, 0, 'oversized entry not persisted');
});
