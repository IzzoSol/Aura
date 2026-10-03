'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Isolate the cache into a throwaway dir; pin a known cost rate for the $ math.
process.env.AURA_HOME = path.join(os.tmpdir(), 'aura-test-' + Date.now());
process.env.AURA_COST_PER_1K = '0.003'; // $3/M — must be honored by stats()
const A = require('./aura-core');
const CACHE_FILE = path.join(process.env.AURA_HOME, 'aura-cache.json');
function readCache() { try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (_) { return {}; } }

test('recordAnswer REFUSES to persist secrets (prompt OR answer)', () => {
  const pairs = [
    ['deploy with key', 'use sk-abcdefghijklmnopqrstuv in the header'],
    ['what is my token', 'npm_aaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ['hash this jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def456ghi789'],
    ['conn string for prod', 'postgres://admin:supersecret@db.internal:5432/prod'],
    ['cat the env file', 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENGbPxRfiCYEXAMPLEKEY'],
    ['what is the github pat', 'ghp_1234567890abcdefghijklmnopqrstuv']
  ];
  for (const [p, a] of pairs) {
    assert.strictEqual(A.recordAnswer(p, a), false, `refused: ${p}`);
  }
  assert.strictEqual(Object.keys(readCache()).length, 0, 'nothing secret hit the disk');
});

test('remember() reports WHY a secret pair was refused', () => {
  const r = A.remember('api key for openai', 'the key is sk-1234567890abcdefgh');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'secret-detected');
  const ok = A.remember('shaddai support email', 'support@shaddai.example');
  assert.strictEqual(ok.ok, true);
});

test('recordAnswer still accepts normal facts', () => {
  assert.strictEqual(A.recordAnswer('capital of france', 'Paris'), true);
  const r = A.route('capital of france');
  assert.ok(r.hit && r.method === 'fetch');
});

test('VOLATILE prompts get a SHORT ttl (15 min), not the flat 24h', () => {
  A.recordAnswer('price of bitcoin', '61234 USD');
  A.recordAnswer('who wrote hamlet', 'William Shakespeare');
  const disk = readCache();
  let vol, stable;
  for (const k of Object.keys(disk)) {
    if (/price of bitcoin/.test(disk[k].prompt)) vol = disk[k];
    if (/hamlet/.test(disk[k].prompt)) stable = disk[k];
  }
  assert.ok(vol, 'volatile entry stored');
  assert.ok(vol.ttl <= 15 * 60 * 1000 + 1000, 'volatile TTL is short');
  assert.ok(stable.ttl >= 24 * 60 * 60 * 1000, 'stable entry keeps the 24h default');
});

test('explicit ttlMs beats the volatility heuristic', () => {
  A.recordAnswer('price of solana today', 'about 150', { ttlMs: 60 * 1000 });
  const disk = readCache();
  let e;
  for (const k of Object.keys(disk)) if (/solana/.test(disk[k].prompt)) e = disk[k];
  assert.ok(e && e.ttl <= 60 * 1000 + 1000, 'explicit ttl honored over volatility rule');
});

test('compute-path caching refuses secret-bearing prompts too', () => {
  // "md5 <jwt>" computes locally, but the PROMPT itself carries a secret — it must NOT be persisted
  A.route('md5 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def456ghi789xyz123abc');
  const disk = readCache();
  for (const k of Object.keys(disk)) {
    assert.ok(!/eyJhbGciOi/.test(disk[k].prompt), 'no secret-bearing prompt cached');
  }
});

test('stats() honors AURA_COST_PER_1K', () => {
  const s = A.stats();
  assert.ok(s.tokensSaved >= 0);
  assert.ok(Math.abs(s.costSavedUsd - (s.tokensSaved / 1000) * 0.003) < 0.001, 'cost uses the env rate');
});

test('stats() includes the outputTrim method bucket', () => {
  const s = A.stats();
  assert.ok(typeof s.byMethod.outputTrim === 'number');
  assert.ok(typeof s.tokensByMethod.outputTrim === 'number');
  assert.ok(typeof s.costByMethod.outputTrim === 'number');
});

test('trimOutput is exported from the core facade', () => {
  assert.strictEqual(typeof A.trimOutput, 'function');
  const r = A.trimOutput({ name: 'npm install', output: ('dep\n').repeat(200) + 'added 3 packages\n' });
  assert.ok(r.report && typeof r.report.tokensSaved === 'number');
});

test('REGRESSION: the shared secret screen is LINEAR on huge uniform values (was a P0 ReDoS)', () => {
  const hostile = [
    'x'.repeat(400000),                                  // uniform letters (old conn-string regex: quadratic)
    ('ab ').repeat(130000),                              // many word boundaries + lookaheads
    'E' + 'A'.repeat(400000),                            // errno-token flood
    'postgres://admin:s3cretpw@db.host:5432/prod ' + 'x'.repeat(400000) // real secret + 400KB tail
  ];
  const t0 = Date.now();
  for (const h of hostile) {
    const r = A.remember('screen this output', h);
    assert.ok(r && typeof r.ok === 'boolean', 'returned safely');
  }
  const dt = Date.now() - t0;
  assert.ok(dt < 2000, `4 hostile 400KB screens completed in ${dt}ms (< 2s)`);
  // behavior preserved: the real conn string must still be refused
  assert.strictEqual(A.remember('conn', 'postgres://admin:supersecret@db.internal:5432/prod').reason, 'secret-detected');
});
