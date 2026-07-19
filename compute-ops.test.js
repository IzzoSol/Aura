'use strict';
/* Tests for lib/compute-ops.js — the extended deterministic COMPUTE ops.
   Each op turns a whole class of prompts into a free, forever answer.
   Run: node compute-ops.test.js   (exit 0 = all pass) */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
// Isolate the cache into a throwaway dir so a prior compute answer can't persist
// and turn a `compute` hit into a `fetch` hit on the next run.
process.env.AURA_HOME = path.join(os.tmpdir(), 'aura-computeops-test-' + Date.now());
const { computeExtra } = require('./lib/compute-ops');
const A = require('./aura-core');

// ── number-base conversion ───────────────────────────────────────────────────
test('base: decimal → hex/bin/oct', () => {
  assert.strictEqual(computeExtra('hex of 255'), '0xff');
  assert.strictEqual(computeExtra('255 to hex'), '0xff');
  assert.strictEqual(computeExtra('binary of 10'), '0b1010');
  assert.strictEqual(computeExtra('10 in binary'), '0b1010');
  assert.strictEqual(computeExtra('octal of 64'), '0o100');
});
test('base: hex/bin/oct → decimal', () => {
  assert.strictEqual(computeExtra('0xff to decimal'), '255');
  assert.strictEqual(computeExtra('0b1010 to decimal'), '10');
  assert.strictEqual(computeExtra('0o17 to decimal'), '15');
});
test('base: "convert" prefix is tolerated', () => {
  assert.strictEqual(computeExtra('convert 255 to hex'), '0xff');
});
test('base: garbage source → null', () => {
  assert.strictEqual(computeExtra('0xZZ to decimal'), null);
});

// ── character count ──────────────────────────────────────────────────────────
test('chars: character count', () => {
  assert.strictEqual(computeExtra('character count of: hello'), '5');
  assert.strictEqual(computeExtra('char count: abc'), '3');
  assert.strictEqual(computeExtra('how many characters in hello world'), '11');
});

// ── url encode / decode (payload casing preserved) ───────────────────────────
test('url: encode/decode', () => {
  assert.strictEqual(computeExtra('url encode hello world'), 'hello%20world');
  assert.strictEqual(computeExtra('url decode hello%20world'), 'hello world');
  assert.strictEqual(computeExtra('urlencode a=b&c=d'), 'a%3Db%26c%3Dd');
});

// ── hashing (crypto, dependency-free) ────────────────────────────────────────
test('hash: md5/sha1/sha256', () => {
  assert.strictEqual(computeExtra('md5 of hello'), '5d41402abc4b2a76b9719d911017c592');
  assert.strictEqual(computeExtra('sha1 of hello'), 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');
  assert.strictEqual(computeExtra('sha256 of hello'),
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
});

// ── rot13 (round-trips, preserves case) ──────────────────────────────────────
test('rot13: transforms and round-trips', () => {
  assert.strictEqual(computeExtra('rot13 hello'), 'uryyb');
  assert.strictEqual(computeExtra('rot13: Uryyb'), 'Hello');
});

// ── text case / slug ─────────────────────────────────────────────────────────
test('textcase: title/capitalize/slugify', () => {
  assert.strictEqual(computeExtra('titlecase: hello world'), 'Hello World');
  assert.strictEqual(computeExtra('capitalize: hello world'), 'Hello world');
  assert.strictEqual(computeExtra('slugify: Hello, World!'), 'hello-world');
});

// ── hex ↔ rgb (design-heavy value) ───────────────────────────────────────────
test('color: hex → rgb', () => {
  assert.strictEqual(computeExtra('hex #ff8800 to rgb'), 'rgb(255, 136, 0)');
  assert.strictEqual(computeExtra('#ff8800 to rgb'), 'rgb(255, 136, 0)');
  assert.strictEqual(computeExtra('#f80 to rgb'), 'rgb(255, 136, 0)');
});
test('color: rgb → hex', () => {
  assert.strictEqual(computeExtra('rgb(255, 136, 0) to hex'), '#ff8800');
  assert.strictEqual(computeExtra('rgb 255 136 0 to hex'), '#ff8800');
});
test('color: out-of-range rgb → null', () => {
  assert.strictEqual(computeExtra('rgb(300, 0, 0) to hex'), null);
});

// ── negatives (must not steal real LLM prompts) ──────────────────────────────
test('negatives: real questions pass through', () => {
  assert.strictEqual(computeExtra('what is the capital of France'), null);
  assert.strictEqual(computeExtra('hello world'), null);
  assert.strictEqual(computeExtra('write me a poem about the sea'), null);
});

// ── wiring: route() surfaces these as method=compute ─────────────────────────
test('route: extended ops resolve as free compute hits', () => {
  const r = A.route('sha256 of hello');
  assert.strictEqual(r.hit, true);
  assert.strictEqual(r.method, 'compute');
  assert.strictEqual(r.answer, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
});
test('route: unit convert still wins over extended ops', () => {
  const r = A.route('convert 10 km to miles');
  assert.strictEqual(r.hit, true);
  assert.strictEqual(r.method, 'compute');
  assert.ok(/miles/.test(r.answer));
});
