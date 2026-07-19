'use strict';
/* Tests for lib/tool-select.js — selective tool injection.
   Send only the tools relevant to THIS turn, not the whole toolbox, on every call.
   Run: node tool-select.test.js   (exit 0 = all pass) */
const test = require('node:test');
const assert = require('node:assert');
const { selectTools } = require('./lib/tool-select');

// A realistic 8-tool agent toolbox (Anthropic shape).
const TOOLS = [
  { name: 'get_weather', description: 'Get the current weather and forecast for a city or location',
    input_schema: { type: 'object', properties: { city: { type: 'string', description: 'city name' } } } },
  { name: 'send_email', description: 'Send an email message to a recipient',
    input_schema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' } } } },
  { name: 'search_web', description: 'Search the internet for web pages and information',
    input_schema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'create_file', description: 'Create or write a file on disk',
    input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'delete_file', description: 'Delete a file from the filesystem',
    input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'run_sql', description: 'Run a SQL query against the database',
    input_schema: { type: 'object', properties: { sql: { type: 'string' } } } },
  { name: 'book_flight', description: 'Book a flight ticket between two airports',
    input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } } },
  { name: 'convert_currency', description: 'Convert an amount from one currency to another',
    input_schema: { type: 'object', properties: { amount: { type: 'number' } } } },
];

test('selects the relevant tool by prompt and drops the rest', () => {
  const r = selectTools('what is the weather in Paris tomorrow', TOOLS, { k: 2 });
  const names = r.tools.map((t) => t.name);
  assert.ok(names.includes('get_weather'), 'kept the weather tool');
  assert.ok(!names.includes('delete_file'), 'dropped an irrelevant tool');
  assert.ok(r.report.sent < r.report.total, 'sent fewer than total');
  assert.strictEqual(r.report.total, 8);
});

test('matches on description vocabulary, not just the tool name', () => {
  // prompt never says "search_web" but says "look up on the internet"
  const r = selectTools('look up information on the internet about tigers', TOOLS, { k: 2 });
  assert.ok(r.tools.map((t) => t.name).includes('search_web'), 'description match found search_web');
});

test('alwaysInclude tools are sent even when irrelevant', () => {
  const r = selectTools('what is the weather in Paris', TOOLS, { k: 1, alwaysInclude: ['run_sql'] });
  const names = r.tools.map((t) => t.name);
  assert.ok(names.includes('run_sql'), 'alwaysInclude honored');
  assert.ok(names.includes('get_weather'), 'still selected the relevant tool');
});

test('FAILS OPEN when the prompt shares no vocabulary with any tool (no silent starvation)', () => {
  const r = selectTools('lorem ipsum dolor sit amet consectetur', TOOLS, { k: 2 });
  assert.strictEqual(r.report.sent, r.report.total, 'sent everything');
  assert.strictEqual(r.report.reason, 'no-signal');
  assert.strictEqual(r.tools.length, TOOLS.length);
});

test('FAILS OPEN for a tiny toolbox (nothing to gain)', () => {
  const small = TOOLS.slice(0, 3);
  const r = selectTools('what is the weather', small, { k: 1 });
  assert.strictEqual(r.report.reason, 'pool-too-small');
  assert.strictEqual(r.tools.length, 3);
});

test('never returns zero tools', () => {
  const r = selectTools('weather', TOOLS, { k: 0 });
  assert.ok(r.tools.length >= 1, 'at least one tool always sent');
});

test('reports real token savings and preserves original tool objects + order', () => {
  const r = selectTools('send an email to my boss about the meeting', TOOLS, { k: 2 });
  assert.ok(r.report.savedTokens > 0, 'reported positive savings');
  // identity preserved (same object references, original order)
  r.tools.forEach((t) => assert.ok(TOOLS.includes(t), 'returned the original tool object'));
  const idxs = r.tools.map((t) => TOOLS.indexOf(t));
  assert.deepStrictEqual(idxs, [...idxs].sort((a, b) => a - b), 'order preserved');
  assert.ok(r.tools.map((t) => t.name).includes('send_email'));
});

test('shape-agnostic: OpenAI function shape works too', () => {
  const openai = TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  const r = selectTools('book me a flight from JFK to LAX', openai, { k: 2 });
  const names = r.tools.map((t) => t.function.name);
  assert.ok(names.includes('book_flight'), 'selected across OpenAI shape');
  assert.ok(r.report.sent < r.report.total);
});

test('context-aware: a terse follow-up still selects the right tool from recent turns', () => {
  const msgs = [
    { role: 'user', content: 'I need to send an email to the team about the launch' },
    { role: 'assistant', content: 'Sure — want me to send it now?' },
    { role: 'user', content: 'yes, do it' }, // terse: no tool vocabulary on its own
  ];
  const r = selectTools(msgs, TOOLS, { k: 2 });
  assert.ok(r.tools.map((t) => t.name).includes('send_email'), 'context recovered the email tool');
  assert.ok(r.report.sent < r.report.total, 'still trimmed');
});

test('context-aware: a big file dump in history does not skew tool choice away from the real ask', () => {
  const dump = 'FILE CONTENTS\n' + Array.from({ length: 60 }, (_, i) => `create write file line number ${i}`).join('\n');
  const msgs = [
    { role: 'user', content: 'open the file' },
    { role: 'assistant', content: dump },              // large tool-ish dump: must NOT dominate the query
    { role: 'user', content: 'now what is the weather in Paris' },
  ];
  const r = selectTools(msgs, TOOLS, { k: 2 });
  assert.ok(r.tools.map((t) => t.name).includes('get_weather'), 'the real ask (weather) still chosen');
});

test('string input still works (backward compatible)', () => {
  const r = selectTools('what is the weather in Paris', TOOLS, { k: 2 });
  assert.ok(r.tools.map((t) => t.name).includes('get_weather'));
});

test('empty / invalid inputs degrade gracefully', () => {
  assert.deepStrictEqual(selectTools('hi', [], {}).tools, []);
  assert.strictEqual(selectTools('', TOOLS, {}).report.reason, 'no-prompt');
  assert.doesNotThrow(() => selectTools(null, null, null));
});

// core wiring: aura-core re-exports selectTools and records the savings in the ledger
test('aura-core exposes selectTools and records toolInject savings', () => {
  const path = require('path'); const os = require('os');
  process.env.AURA_HOME = path.join(os.tmpdir(), 'aura-toolsel-' + Date.now());
  const A = require('./aura-core');
  assert.strictEqual(typeof A.selectTools, 'function');
  const before = A.stats().tokensSaved;
  const r = A.selectTools('what is the weather in Paris', TOOLS, { k: 2 });
  assert.ok(r.report.savedTokens > 0);
  assert.ok(A.stats().tokensSaved >= before + r.report.savedTokens, 'ledger updated');
  assert.ok((A.stats().byMethod.toolInject || 0) >= 1, 'toolInject counted');
});
