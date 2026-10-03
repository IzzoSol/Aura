'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Isolate so any ledger writes never touch the real ~/.shaddai-aura
process.env.AURA_HOME = path.join(os.tmpdir(), 'aura-test-' + Date.now());
const A = require('./aura-core');
const { trimOutput } = require('./lib/output-trim');

// a realistic noisy npm install (family: package-install -> tail 20)
function fakeInstall() {
  const lines = ['npm warn deprecated left-pad@1.3.0: this module is no longer maintained'];
  for (let i = 0; i < 60; i++) lines.push(`npm warn eslint@8.x requires a peer of typescript@>=4.0.0 but none is installed (line ${i})`);
  lines.push('added 1245 packages, and audited 1246 packages in 12s');
  lines.push('found 0 vulnerabilities');
  return lines.join('\n');
}

test('trimOutput: npm install family collapses to the tail', () => {
  const r = trimOutput({ name: 'npm install', output: fakeInstall() });
  assert.ok(r.report.tokensSaved > 0, 'saved tokens');
  assert.strictEqual(r.report.reason, 'family:package-install');
  assert.match(r.output, /added 1245 packages/);
  assert.match(r.output, /found 0 vulnerabilities/);
  assert.ok(r.output.length < fakeInstall().length / 2, 'at least half the noise gone');
});

test('trimOutput: test-runner keep preserves FAILED lines and summary', () => {
  const lines = [];
  for (let i = 0; i < 40; i++) lines.push(`test_pass_${i} PASSED`);
  for (let i = 0; i < 20; i++) lines.push(`test_flaky_${i} PASSED`);
  lines.push('FAILED test_aura_core - AssertionError: expected 3 to be 4');
  lines.push('FAILED test_aura_route - TypeError: cannot read props of undefined');
  lines.push('2 failed, 58 passed in 3.45s');
  const r = trimOutput({ name: 'pytest', output: lines.join('\n') });
  assert.match(r.output, /FAILED test_aura_core/);
  assert.match(r.output, /FAILED test_aura_route/);
  assert.match(r.output, /2 failed, 58 passed/);
  assert.ok(r.report.tokensSaved > 0);
});

test('trimOutput: CRITICAL-LINE RECOVERY re-appends errors that fell off the tail', () => {
  const lines = [];
  for (let i = 0; i < 200; i++) lines.push(`build step ${i} ok`);
  lines.push('ERROR at src/main.rs:412: cannot borrow `x` as mutable');
  for (let i = 0; i < 100; i++) lines.push(`more output ${i}`);
  lines.push('error: could not compile `shaddai` (bin "shaddai") due to 1 previous error');
  const r = trimOutput({ name: 'cargo build', output: lines.join('\n'), failed: true });
  // the mid-output ERROR is gone from the tail keep but must be recovered
  assert.match(r.output, /cannot borrow/);
  assert.match(r.output, /could not compile/);
  assert.ok(r.report.recovered >= 1, 'recovery count reported');
});

test('trimOutput: RATIO GATE returns the original when shaping gains nothing', () => {
  const short = 'all good\n' + 'done\n' + 'ok'.repeat(10) + '\n';
  const r = trimOutput({ name: 'some tool', output: short });
  assert.ok(r.report.tokensSaved === 0 || r.report.reason === 'too-small' || r.report.reason === 'no-gain');
  assert.strictEqual(r.output, short, 'untouched output when no gain');
});

test('trimOutput: too-small outputs pass through untouched', () => {
  const tiny = 'ok';
  const r = trimOutput({ name: 'git status', output: tiny });
  assert.strictEqual(r.report.reason, 'too-small');
  assert.strictEqual(r.output, tiny);
});

test('trimOutput: generic success keeps ~5 tail lines, failure keeps ~50', () => {
  const lines = [];
  for (let i = 0; i < 500; i++) lines.push('row ' + i);
  const ok = trimOutput({ name: 'list rows', output: lines.join('\n'), failed: false });
  assert.ok(ok.report.reason === 'asymmetric-tail');
  assert.ok(ok.output.split('\n').length <= 10, 'success keeps a tiny tail');
  const bad = trimOutput({ name: 'list rows', output: lines.join('\n'), failed: true });
  assert.ok(bad.output.split('\n').length <= 55, 'failure keeps a wider tail');
});

test('trimOutput: ANSI escapes stripped and repeated lines collapsed', () => {
  const noisy = '\x1b[32mOK\x1b[0m\n' + ('retry...\n').repeat(30) + 'done';
  const r = trimOutput({ name: 'deploy script', output: noisy, failed: false });
  assert.ok(!r.output.includes('\x1b['), 'ANSI gone');
  assert.match(r.output, /repeated/);
});

test('trimOutput: never throws on hostile input', () => {
  const r1 = trimOutput({});
  const r2 = trimOutput({ name: null, output: null });
  const r3 = trimOutput({ name: 'x', output: { weird: true } });
  assert.ok(r1 && r2 && r3, 'all returned safely');
});

test('recordOutputTrim books the shared ledger under outputTrim', () => {
  const before = A.stats().tokensSaved;
  const r = trimOutput({ name: 'npm install', output: fakeInstall() });
  assert.ok(r.report.tokensSaved > 0);
  A.recordOutputTrim(r.report.tokensSaved);
  const after = A.stats();
  assert.strictEqual(after.tokensSaved, before + r.report.tokensSaved);
  assert.ok(after.tokensByMethod.outputTrim >= r.report.tokensSaved);
  assert.ok(after.byMethod.outputTrim >= 1);
  assert.ok(Number.isFinite(after.costByMethod.outputTrim));
});
