'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { compress, contentString } = require('./lib/context-compress');

const big = (label, n) => `${label}: ` + 'x'.repeat(n);

test('protects system, first user (task), and recent messages verbatim', () => {
  const msgs = [
    { role: 'system', content: 'you are a helpful agent' },
    { role: 'user', content: 'THE TASK: migrate the database' },
    { role: 'assistant', content: big('old tool dump', 3000) },
    { role: 'user', content: 'recent-1' },
    { role: 'assistant', content: 'recent-2' }
  ];
  const { messages } = compress(msgs, { keepRecent: 2 });
  assert.strictEqual(messages[0].content, 'you are a helpful agent', 'system untouched');
  assert.strictEqual(messages[1].content, 'THE TASK: migrate the database', 'task untouched');
  assert.strictEqual(messages[messages.length - 1].content, 'recent-2', 'recent untouched');
});

test('truncates a big OLD tool output but keeps head+tail', () => {
  const dump = 'HEAD_START' + 'y'.repeat(4000) + 'TAIL_END';
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'task' },
    { role: 'assistant', content: dump },   // old, unpinned -> truncated
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' }
  ];
  const { messages, stats } = compress(msgs, { keepRecent: 2, headChars: 20, tailChars: 10 });
  const t = messages[2].content;
  assert.ok(t.startsWith('HEAD_START'), 'kept head');
  assert.ok(t.endsWith('TAIL_END'), 'kept tail');
  assert.ok(/AURA elided \d+ chars/.test(t), 'has elision marker');
  assert.ok(stats.saved > 0);
});

test('dedups an identical large block, keeping the LATER full copy', () => {
  const shared = big('config file', 1500);
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'task' },
    { role: 'assistant', content: shared },   // earlier copy -> elided
    { role: 'user', content: 'middle' },
    { role: 'assistant', content: shared },   // later copy -> kept (but is it pinned?)
    { role: 'user', content: 'r1' },
    { role: 'assistant', content: 'r2' }
  ];
  const { messages } = compress(msgs, { keepRecent: 2, dedupOver: 200 });
  assert.ok(/identical to a later message/.test(messages[2].content), 'earlier copy elided');
  assert.strictEqual(messages[4].content, shared, 'later copy kept in full');
});

test('near-dedup: elides an OLDER near-identical file re-read, keeps the later full copy', () => {
  const fileV1 = Array.from({ length: 20 }, (_, i) => `const item${i} = ${i};`).join('\n');
  const fileV2 = fileV1.replace('const item5 = 5;', 'const item5 = 500;'); // 1 of 20 lines changed → ~90% same
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'task' },
    { role: 'assistant', content: fileV1 },   // first read (stale) -> should be elided
    { role: 'user', content: 'edit item5' },
    { role: 'assistant', content: fileV2 },   // second read (current) -> kept full
    { role: 'user', content: 'r1' },
    { role: 'assistant', content: 'r2' }
  ];
  const { messages, stats } = compress(msgs, { keepRecent: 2, dedupOver: 100 });
  assert.ok(/identical to a later message/.test(messages[2].content), 'stale re-read elided');
  assert.strictEqual(messages[4].content, fileV2, 'current copy kept in full');
  assert.ok(stats.saved > 0);
});

test('near-dedup: two GENUINELY DIFFERENT large blocks are both kept (no false collapse)', () => {
  const a = Array.from({ length: 20 }, (_, i) => `alpha config key_${i} = ${i}`).join('\n');
  const b = Array.from({ length: 20 }, (_, i) => `beta handler route /path/${i} -> fn${i}()`).join('\n');
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'task' },
    { role: 'assistant', content: a },
    { role: 'user', content: 'next' },
    { role: 'assistant', content: b },
    { role: 'user', content: 'r1' },
    { role: 'assistant', content: 'r2' }
  ];
  const { messages } = compress(msgs, { keepRecent: 2, dedupOver: 100 });
  assert.strictEqual(messages[2].content, a, 'different block A untouched');
  assert.strictEqual(messages[4].content, b, 'different block B untouched');
});

test('near-dedup can be disabled with nearDedup:false', () => {
  const fileV1 = Array.from({ length: 20 }, (_, i) => `const item${i} = ${i};`).join('\n');
  const fileV2 = fileV1.replace('const item5 = 5;', 'const item5 = 500;');
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'task' },
    { role: 'assistant', content: fileV1 },
    { role: 'user', content: 'x' },
    { role: 'assistant', content: fileV2 },
    { role: 'user', content: 'r1' },
    { role: 'assistant', content: 'r2' }
  ];
  const { messages } = compress(msgs, { keepRecent: 2, dedupOver: 100, nearDedup: false });
  assert.strictEqual(messages[2].content, fileV1, 'near-dedup off → stale copy retained');
});

test('maxTokens drops oldest non-pinned and leaves a marker', () => {
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'task' },
    { role: 'assistant', content: big('a', 2000) },
    { role: 'user', content: big('b', 2000) },
    { role: 'assistant', content: big('c', 2000) },
    { role: 'user', content: 'recent-q' },
    { role: 'assistant', content: 'recent-a' }
  ];
  const { messages, stats } = compress(msgs, { keepRecent: 2, maxTokens: 400, truncateOver: 100000 });
  assert.ok(stats.dropped > 0, 'dropped some');
  assert.ok(messages.some((m) => /older message\(s\) elided/.test(m.content)), 'drop marker present');
  // pins survive
  assert.strictEqual(messages[0].content, 'sys');
  assert.strictEqual(messages[1].content, 'task');
  assert.strictEqual(messages[messages.length - 1].content, 'recent-a');
});

test('collapses runs of repeated identical lines in a big old block (smarter than truncation)', () => {
  const spam = Array.from({ length: 40 }, () => 'ERROR: timeout while connecting to upstream').join('\n');
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'task' },
    { role: 'assistant', content: spam },   // old, unpinned, ~1720 chars of one repeated line
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
  ];
  const { messages, stats } = compress(msgs, { keepRecent: 2, truncateOver: 1000 });
  const t = messages[2].content;
  assert.match(t, /repeated 40×/, 'run collapsed with a count marker');
  assert.match(t, /ERROR: timeout while connecting/, 'the line itself is kept once');
  assert.doesNotMatch(t, /AURA elided \d+ chars/, 'no blind head/tail cut needed — collapse fit it');
  assert.ok(stats.saved > 0);
});

test('repeat-collapse can be disabled and does not touch a non-repeating block', () => {
  const varied = Array.from({ length: 40 }, (_, i) => `line ${i}: distinct content value ${i * 7}`).join('\n');
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'task' },
    { role: 'assistant', content: varied },
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
  ];
  const off = compress(msgs.map((m) => ({ ...m })), { keepRecent: 2, truncateOver: 1000, collapseRepeats: false });
  assert.doesNotMatch(off.messages[2].content, /repeated \d+×/, 'disabled → no collapse');
  const on = compress(msgs.map((m) => ({ ...m })), { keepRecent: 2, truncateOver: 1000 });
  assert.doesNotMatch(on.messages[2].content, /repeated \d+×/, 'non-repeating block is never collapsed');
});

test('a small conversation under budget is returned unchanged', () => {
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' }
  ];
  const { messages, stats } = compress(msgs);
  assert.strictEqual(stats.saved, 0);
  assert.deepStrictEqual(messages.map((m) => m.content), ['sys', 'hello', 'hi there']);
});

test('token accounting is consistent (after = before - saved)', () => {
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'task' },
    { role: 'assistant', content: big('dump', 5000) },
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a' }
  ];
  const { stats } = compress(msgs, { keepRecent: 2 });
  assert.strictEqual(stats.tokensAfter, stats.tokensBefore - stats.saved);
});

test('handles block-array content (text + tool blocks) without throwing', () => {
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: [{ type: 'text', text: 'task' }] },
    { role: 'assistant', content: [{ type: 'text', text: big('note', 3000) }, { type: 'tool_use', id: '1' }] },
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a' }
  ];
  assert.doesNotThrow(() => compress(msgs, { keepRecent: 2 }));
  assert.ok(contentString(msgs[2].content).length > 0);
});
