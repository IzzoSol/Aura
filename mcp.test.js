// Verifies the AURA MCP server: handshake, tools, graceful method handling,
// a free compute answer, and that oversized input is capped (never crashes).
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

// Isolate into a throwaway cache so the test never reads/writes the real ~/.shaddai-aura
// (otherwise a stale fuzzy cache entry can shadow the expected compute answer).
const TEST_HOME = path.join(os.tmpdir(), 'aura-mcp-test-' + process.pid);

function run(frames) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'mcp.js')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, AURA_HOME: TEST_HOME }
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', () => {
      try { resolve(out.split('\n').filter(Boolean).map((l) => JSON.parse(l))); }
      catch (e) { reject(new Error('bad stdout (protocol pollution?): ' + out.slice(0, 200))); }
    });
    for (const f of frames) p.stdin.write(JSON.stringify(f) + '\n');
    p.stdin.end();
  });
}

(async () => {
  const msgs = await run([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'resources/list' },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'aura_ask', arguments: { prompt: 'what is 15 * 240' } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'aura_ask', arguments: { prompt: 'x'.repeat(500000) } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope_unknown' } },
    // aura_compress: a history with a big repeated tool output that should compress away.
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'aura_compress', arguments: {
      keepRecent: 2,
      messages: [
        { role: 'system', content: 'You are a helpful agent.' },
        { role: 'user', content: 'Read the config file.' },
        { role: 'tool', content: 'CONFIG '.repeat(400) },   // big old block
        { role: 'assistant', content: 'Done, here is the config.' },
        { role: 'user', content: 'Read the config file again.' },
        { role: 'tool', content: 'CONFIG '.repeat(400) },   // identical -> dedup keeps this one
        { role: 'assistant', content: 'Same config as before.' }
      ]
    } } },
    // aura_compress malformed input -> isError, no crash.
    { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'aura_compress', arguments: { messages: 'not-an-array' } } },
    // aura_savings: combined answer-cache + tool-cache view.
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'aura_savings' } },
    // aura_distill: trim a prompt with a duplicated rule; a safety rule must survive.
    { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'aura_distill', arguments: {
      prompt: 'Never leak secrets.\nSummarize the input.\nSummarize the input.'
    } } },
    // aura_select_tools: pick the relevant tools for a prompt out of a bigger toolbox.
    { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'aura_select_tools', arguments: {
      prompt: 'what is the weather in Paris',
      k: 2,
      tools: [
        { name: 'get_weather', description: 'current weather forecast for a city' },
        { name: 'send_email', description: 'send an email to a recipient' },
        { name: 'run_sql', description: 'run a sql query against the database' },
        { name: 'search_web', description: 'search the internet for information' },
        { name: 'create_file', description: 'create or write a file on disk' },
        { name: 'delete_file', description: 'delete a file from disk' }
      ]
    } } },
    // aura_optimize: full request in, leaner request + report out.
    { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'aura_optimize', arguments: {
      system: 'You are helpful. Be concise. Be concise. Never delete data.',
      k: 2,
      messages: [
        { role: 'user', content: 'TASK' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'BLOCK ' + 'x'.repeat(600) },
        { role: 'assistant', content: 'read it' },
        { role: 'user', content: 'BLOCK ' + 'x'.repeat(600) },
        { role: 'user', content: 'what is the weather in Paris' }
      ],
      tools: [
        { name: 'get_weather', description: 'current weather forecast for a city' },
        { name: 'send_email', description: 'send an email to a recipient' },
        { name: 'run_sql', description: 'run a sql query against the database' },
        { name: 'search_web', description: 'search the internet for information' },
        { name: 'create_file', description: 'create or write a file on disk' },
        { name: 'delete_file', description: 'delete a file from disk' }
      ]
    } } },
    // resources/read: pull the savings ledger as a resource.
    { jsonrpc: '2.0', id: 13, method: 'resources/read', params: { uri: 'aura://savings' } }
  ]);
  const byId = {};
  for (const m of msgs) if (m.id != null) byId[m.id] = m;

  assert.equal(byId[1].result.serverInfo.name, 'aura', 'initialize returns serverInfo');
  const toolNames = byId[2].result.tools.map((t) => t.name);
  assert.ok(Array.isArray(byId[2].result.tools) && byId[2].result.tools.length === 8, '8 tools listed');
  assert.ok(toolNames.includes('aura_compress'), 'tools/list advertises aura_compress');
  assert.ok(toolNames.includes('aura_savings'), 'tools/list advertises aura_savings');
  assert.ok(toolNames.includes('aura_distill'), 'tools/list advertises aura_distill');
  assert.ok(toolNames.includes('aura_select_tools'), 'tools/list advertises aura_select_tools');
  assert.ok(toolNames.includes('aura_optimize'), 'tools/list advertises aura_optimize');
  const compressTool = byId[2].result.tools.find((t) => t.name === 'aura_compress');
  assert.ok(compressTool.inputSchema.properties.messages, 'aura_compress schema has messages');
  assert.ok(byId[3].result.resources.some((r) => r.uri === 'aura://savings'), 'resources/list advertises the savings resource');
  const ask = JSON.parse(byId[4].result.content[0].text);
  assert.equal(ask.answer, '3600', 'aura_ask computed 15*240=3600 for free (no LLM)');
  assert.ok(byId[5] && byId[5].result, 'oversized 500k-char prompt handled (capped), no crash');
  assert.ok(byId[6] && byId[6].result && byId[6].result.isError, 'unknown tool returns isError, not a crash');

  // aura_compress returns compressed messages + a positive saved count.
  const comp = JSON.parse(byId[7].result.content[0].text);
  assert.ok(Array.isArray(comp.messages), 'aura_compress returns a messages array');
  assert.ok(comp.stats && comp.stats.saved > 0, 'aura_compress saved > 0 tokens (dedup/truncate)');
  assert.ok(comp.stats.tokensBefore > comp.stats.tokensAfter, 'aura_compress tokensAfter < tokensBefore');

  // aura_compress malformed input -> isError, not a crash.
  assert.ok(byId[8] && byId[8].result && byId[8].result.isError, 'aura_compress malformed input returns isError');

  // aura_savings returns combined answer-cache + tool-cache payload.
  const savings = JSON.parse(byId[9].result.content[0].text);
  assert.ok(savings.answerCache && typeof savings.answerCache === 'object', 'aura_savings includes answerCache');
  assert.ok(savings.toolCache && typeof savings.toolCache.tokensSaved === 'number', 'aura_savings includes toolCache stats');

  // aura_distill trims the duplicate but keeps the safety rule.
  const dist = JSON.parse(byId[10].result.content[0].text);
  assert.ok((dist.distilled.match(/Summarize the input/g) || []).length === 1, 'aura_distill removed the duplicate rule');
  assert.match(dist.distilled, /Never leak secrets/, 'aura_distill kept the protected safety rule');
  assert.ok(dist.report.stats.saved > 0, 'aura_distill saved > 0 tokens');

  // aura_select_tools trims a 6-tool box down for a weather prompt, keeping get_weather.
  const sel = JSON.parse(byId[11].result.content[0].text);
  assert.ok(Array.isArray(sel.tools) && sel.tools.length < 6, 'aura_select_tools trimmed the toolbox');
  assert.ok(sel.tools.map((t) => t.name).includes('get_weather'), 'aura_select_tools kept the relevant tool');
  assert.ok(sel.report && sel.report.sent < sel.report.total, 'aura_select_tools report shows the cut');

  // aura_optimize returns a leaner request + a per-surface report.
  const opt = JSON.parse(byId[12].result.content[0].text);
  assert.ok(opt.request && Array.isArray(opt.request.tools) && opt.request.tools.length < 6, 'aura_optimize trimmed tools');
  assert.ok(opt.report && opt.report.tokensSaved > 0, 'aura_optimize reports tokens saved');
  assert.ok(opt.report.instructions && opt.report.instructions.saved > 0, 'aura_optimize distilled the system');

  // resources/read returns the savings ledger as JSON.
  const res = byId[13].result;
  assert.ok(res && Array.isArray(res.contents) && res.contents[0].uri === 'aura://savings', 'resources/read returns the savings resource');
  const ledger = JSON.parse(res.contents[0].text);
  assert.ok(ledger.answerCache && typeof ledger.answerCache === 'object', 'savings resource carries the answer-cache ledger');

  try { require('node:fs').rmSync(TEST_HOME, { recursive: true, force: true }); } catch (_) {}
  console.log('✅ mcp.test PASS — handshake · 8 tools · savings resource · select_tools · optimize · free compute · oversized-input · unknown-tool · compress · savings · distill');
})().catch((e) => { console.error('❌ mcp.test FAIL:', e.message); process.exit(1); });
