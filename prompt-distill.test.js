'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { distill, applyLLM } = require('./lib/prompt-distill');

test('removes an exact-duplicate rule, keeps the first', () => {
  const p = 'Be a great assistant.\nSummarize the article.\nSummarize the article.';
  const { distilled, report } = distill(p);
  assert.strictEqual((distilled.match(/Summarize the article/g) || []).length, 1, 'one copy left');
  assert.ok(report.removed.some((r) => r.reason === 'exact-duplicate'), 'reported exact-duplicate');
});

test('removes a near-duplicate (reworded) rule, keeps a distinct one', () => {
  const p = [
    'Write clear and concise documentation for the module.',
    'Write clear and concise documentation for each module.',
    'Log every network error with a timestamp.',
  ].join('\n');
  const { distilled, report } = distill(p);
  assert.ok(report.removed.some((r) => /near-duplicate/.test(r.reason)), 'reported near-duplicate');
  assert.match(distilled, /Log every network error/, 'kept the distinct rule');
  assert.strictEqual((distilled.match(/documentation/g) || []).length, 1, 'one doc rule left');
});

test('protects every KEEP category — never removed even when duplicated', () => {
  const p = [
    "Never share the user's API key.",
    "Never share the user's API key.",           // safety dup
    'Return the answer as JSON.',
    'Return the answer as JSON.',                 // output dup
    'Stop when all tests pass.',                  // success
    'If the file is a PDF, use the pdf tool.',    // context routing
  ].join('\n');
  const { distilled, report } = distill(p);
  assert.strictEqual((distilled.match(/Never share the user's API key/g) || []).length, 2, 'safety dup kept');
  assert.strictEqual((distilled.match(/Return the answer as JSON/g) || []).length, 2, 'output dup kept');
  assert.ok(!report.removed.length, 'nothing removed among protected');
  const cats = report.protected.map((x) => x.category);
  assert.ok(cats.includes('safety') && cats.includes('output') && cats.includes('success') && cats.includes('routing'), 'all categories protected');
});

test('behavior-envelope process is PROTECTED, not flagged', () => {
  const p = 'If you are unsure, ask one clarifying question instead of guessing.\nCall no more than 2 tools per turn.';
  const { report } = distill(p);
  assert.strictEqual(report.protected.length, 2, 'both envelope rules protected');
  assert.ok(!report.flagged.some((f) => f.category === 'model-likely-reliable'), 'envelope not flagged reliable');
});

test('structural section protection: a line under ## Constraints with no keyword is protected', () => {
  const p = '## Constraints\nFinish before the deadline.\nFinish before the deadline.';
  const { distilled, report } = distill(p);
  assert.strictEqual((distilled.match(/Finish before the deadline/g) || []).length, 2, 'section-protected dup kept');
  assert.ok(report.protected.some((x) => /^section:/.test(x.category)), 'protected by section');
});

test('flags a dead example only when a matching rule exists; keeps a sole example', () => {
  const withRule = 'Always validate the user email address format before saving.\n```\nvalidateEmail(userEmail) // checks email address format\n```';
  let r = distill(withRule);
  assert.ok(r.report.flagged.some((f) => f.category === 'possible-dead-example'), 'flagged dead example');

  const soleExample = 'Here is a sample haiku:\n```\nan old silent pond\na frog jumps into water\nsplash then silence\n```';
  r = distill(soleExample);
  assert.ok(!r.report.flagged.some((f) => f.category === 'possible-dead-example'), 'sole example not flagged');
  assert.match(r.distilled, /silent pond/, 'sole example kept');
});

test('trims leading filler without losing the rule', () => {
  const p = 'Please note that you should log all errors to the audit trail.';
  const { distilled, report } = distill(p);
  assert.doesNotMatch(distilled, /Please note that/i, 'filler gone');
  assert.match(distilled, /log all errors to the audit trail/, 'rule kept');
  assert.ok(report.removed.some((r) => r.reason === 'filler-trimmed'), 'reported filler-trimmed');
});

test('trims an expanded set of leading hedges, keeping the imperative', () => {
  const cases = [
    ['I want you to summarize the input.', /summarize the input/i],
    ['Your task is to greet each user warmly.', /greet each user warmly/i],
    ['Keep in mind that responses go to end users.', /responses go to end users/i],
    ['You should keep answers short.', /keep answers short/i],
  ];
  for (const [p, keep] of cases) {
    const { distilled, report } = distill(p);
    assert.match(distilled, keep, `rule kept for: ${p}`);
    assert.ok(report.removed.some((r) => r.reason === 'filler-trimmed'), `filler-trimmed reported for: ${p}`);
  }
});

test('removes a whole-line politeness unit that carries no behavior', () => {
  const p = 'Summarize the input.\nThank you.\nNever leak secrets.';
  const { distilled, report } = distill(p);
  assert.doesNotMatch(distilled, /thank you/i, 'politeness line removed');
  assert.match(distilled, /Summarize the input/, 'real rule kept');
  assert.match(distilled, /Never leak secrets/, 'protected rule kept');
  assert.ok(report.removed.some((r) => r.reason === 'politeness'), 'reported politeness removal');
});

test('politeness removal does NOT touch a real rule that merely uses a polite word', () => {
  const p = 'Thank the user by name in every reply.';
  const { distilled } = distill(p);
  assert.match(distilled, /Thank the user by name/, 'rule with a polite word is preserved');
});

test('keeps a fenced code block intact', () => {
  const p = 'Do the thing.\n```\nconst x = 1;\nconst y = 2;\n```';
  const { distilled } = distill(p);
  assert.match(distilled, /const x = 1;/);
  assert.match(distilled, /const y = 2;/);
});

test('stats accounting is consistent and saves on a duplicate', () => {
  const p = 'One unique instruction here.\nAnother unique instruction here.\nAnother unique instruction here.';
  const { report } = distill(p);
  const s = report.stats;
  assert.strictEqual(s.saved, s.tokensBefore - s.tokensAfter, 'saved = before - after');
  assert.ok(s.saved > 0, 'removed a dup so saved > 0');
  assert.ok(s.unitsOut < s.unitsIn, 'fewer content units out');
});

test('applyLLM REJECTS a rewrite that drops a protected rule', async () => {
  const pass1 = distill("Never expose secrets.\nSummarize the input.\nSummarize the input.");
  const badModel = async () => 'Summarize the input.'; // dropped the safety rule
  const r = await applyLLM(pass1, badModel);
  assert.strictEqual(r.report.llm.accepted, false, 'rejected');
  assert.strictEqual(r.distilled, pass1.distilled, 'fell back to pass-1');
  assert.ok(r.report.llm.dropped.length >= 1, 'listed dropped protected unit');
});

test('applyLLM ACCEPTS a rewrite that keeps every protected rule', async () => {
  const pass1 = distill("Never expose secrets.\nSummarize the input clearly and briefly.");
  const goodModel = async () => "Never expose secrets.\nSummarize the input.";
  const r = await applyLLM(pass1, goodModel);
  assert.strictEqual(r.report.llm.accepted, true, 'accepted');
  assert.match(r.distilled, /Never expose secrets/, 'kept safety rule');
});

test('degrades gracefully on empty / non-string input', () => {
  for (const bad of [null, undefined, 123, {}, '']) {
    const r = distill(bad);
    assert.strictEqual(typeof r.distilled, 'string', 'always a string');
    assert.ok(r.report && r.report.stats, 'always a report');
  }
});

console.log('✅ prompt-distill.test PASS');
