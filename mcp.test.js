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
    for (const f of frames) p.stdin.write((typeof f === 'string' ? f : JSON.stringify(f)) + '\n');
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
    { jsonrpc: '2.0', id: 13, method: 'resources/read', params: { uri: 'aura://savings' } },
    // ping: must return an empty result.
    { jsonrpc: '2.0', id: 14, method: 'ping' },
    // unknown method with an id -> JSON-RPC -32601.
    { jsonrpc: '2.0', id: 15, method: 'no/such/method' },
    // aura_trim_output: a noisy install log must shrink and be booked in the ledger.
    { jsonrpc: '2.0', id: 16, method: 'tools/call', params: { name: 'aura_trim_output', arguments: {
      name: 'npm install',
      output: ('npm warn deprecated left-pad\n').repeat(200) + 'added 1245 packages, and audited 1246 packages in 12s\n'
    } } },
    // aura_remember: a secret-bearing pair must be REFUSED with a reason.
    { jsonrpc: '2.0', id: 17, method: 'tools/call', params: { name: 'aura_remember', arguments: {
      prompt: 'my api key', answer: 'sk-abcdefghijklmnopqrstuv'
    } } },
    // aura_remember: a normal pair must be accepted.
    { jsonrpc: '2.0', id: 18, method: 'tools/call', params: { name: 'aura_remember', arguments: {
      prompt: 'what is the aura cache', answer: 'a bounded local answer cache'
    } } },
    // aura_compress with OVERSIZED block-array content -> bounded to a placeholder, no crash.
    { jsonrpc: '2.0', id: 19, method: 'tools/call', params: { name: 'aura_compress', arguments: {
      messages: [
        { role: 'user', content: 'read the log' },
        { role: 'tool', content: [{ type: 'text', text: 'LOG '.repeat(200000) }] },
        { role: 'assistant', content: 'ok' }
      ]
    } } },
    // an unparseable line -> JSON-RPC 2.0 Parse error (id: null)
    'this-is-not-valid-json'
  ]);
  const byId = {};
  for (const m of msgs) if (m.id != null) byId[m.id] = m;

  assert.equal(byId[1].result.serverInfo.name, 'aura', 'initialize returns serverInfo');
  const toolNames = byId[2].result.tools.map((t) => t.name);
  assert.ok(Array.isArray(byId[2].result.tools) && byId[2].result.tools.length === 9, '9 tools listed');
  assert.ok(toolNames.includes('aura_compress'), 'tools/list advertises aura_compress');
  assert.ok(toolNames.includes('aura_savings'), 'tools/list advertises aura_savings');
  assert.ok(toolNames.includes('aura_distill'), 'tools/list advertises aura_distill');
  assert.ok(toolNames.includes('aura_select_tools'), 'tools/list advertises aura_select_tools');
  assert.ok(toolNames.includes('aura_optimize'), 'tools/list advertises aura_optimize');
  assert.ok(toolNames.includes('aura_trim_output'), 'tools/list advertises aura_trim_output');
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
  assert.ok(typeof ledger.version === 'string' && ledger.version.length > 0, 'savings resource carries the server version');

  // ping -> empty result
  assert.ok(byId[14] && byId[14].result && Object.keys(byId[14].result).length === 0, 'ping returns an empty result');

  // unknown method -> JSON-RPC error -32601
  assert.ok(byId[15] && byId[15].error && byId[15].error.code === -32601, 'unknown method returns -32601');

  // aura_trim_output: saved tokens + kept the result tail.
  const trim = JSON.parse(byId[16].result.content[0].text);
  assert.ok(trim.report && trim.report.tokensSaved > 0, 'aura_trim_output saved tokens on the noisy install log');
  assert.ok(/added 1245 packages/.test(trim.output), 'aura_trim_output kept the result tail');

  // aura_remember: secret refused WITH a reason; normal pair accepted.
  const refused = JSON.parse(byId[17].result.content[0].text);
  assert.equal(refused.ok, false, 'secret pair refused');
  assert.equal(refused.reason, 'secret-detected', 'refusal carries the reason');
  const accepted = JSON.parse(byId[18].result.content[0].text);
  assert.equal(accepted.ok, true, 'normal pair remembered');

  // oversized block-array content is bounded to a placeholder — no crash, compresses fine
  const bounded = JSON.parse(byId[19].result.content[0].text);
  assert.ok(Array.isArray(bounded.messages), 'aura_compress handled oversized block content');
  assert.ok(bounded.stats && Number.isFinite(bounded.stats.saved), 'stats reported for the bounded content');

  // unparseable line -> Parse error with id: null (JSON-RPC 2.0 5.1)
  const parseErr = msgs.find((m) => m.id === null && m.error && m.error.code === -32700);
  assert.ok(parseErr, 'invalid JSON gets a -32700 Parse error response');

  // initialize: capabilities + instructions present (protocol polish)
  assert.ok(byId[1].result.capabilities && byId[1].result.capabilities.prompts, 'initialize advertises the prompts capability');
  assert.ok(typeof byId[1].result.instructions === 'string' && byId[1].result.instructions.length > 0, 'initialize returns instructions');

  try { require('node:fs').rmSync(TEST_HOME, { recursive: true, force: true }); } catch (_) {}
  console.log('mcp.test PASS - handshake, 9 tools, savings resource, select_tools, optimize, trim_output, secret-refusal, parse-error, free compute, oversized-input, unknown-tool, compress, savings, distill');
})().catch((e) => { console.error('mcp.test FAIL:', e.message); process.exit(1); });