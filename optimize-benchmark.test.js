'use strict';
/* Regression guard for the end-to-end optimize() pipeline via the capstone benchmark.
   If any surface (tool injection / compress / distill) silently stops saving, this fails.
   Run: node optimize-benchmark.test.js */
const test = require('node:test');
const assert = require('node:assert');
const { run } = require('./benchmarks/optimize-benchmark');

test('capstone session benchmark saves a large fraction across all three surfaces', () => {
  const r = run();
  assert.ok(r.saved > 0, 'net positive savings');
  assert.ok(r.pct > 30, `saves a meaningful fraction (got ${r.pct.toFixed(1)}%)`);
  assert.ok(r.optimizedTotal < r.baselineTotal, 'optimized request is smaller');
  const tbm = r.ledger.tokensByMethod || {};
  assert.ok(tbm.toolInject > 0, 'tool injection contributed');
  assert.ok(tbm.compress > 0, 'history compression contributed');
  assert.ok(tbm.distill > 0, 'distillation contributed');
});
