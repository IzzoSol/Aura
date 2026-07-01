// Verifies the AURA MCP server: handshake, tools, graceful method handling,
// a free compute answer, and that oversized input is capped (never crashes).
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

function run(frames) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'mcp.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
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
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope_unknown' } }
  ]);
  const byId = {};
  for (const m of msgs) if (m.id != null) byId[m.id] = m;

  assert.equal(byId[1].result.serverInfo.name, 'aura', 'initialize returns serverInfo');
  assert.ok(Array.isArray(byId[2].result.tools) && byId[2].result.tools.length === 3, '3 tools listed');
  assert.deepEqual(byId[3].result.resources, [], 'resources/list returns empty (no client error noise)');
  const ask = JSON.parse(byId[4].result.content[0].text);
  assert.equal(ask.answer, '3600', 'aura_ask computed 15*240=3600 for free (no LLM)');
  assert.ok(byId[5] && byId[5].result, 'oversized 500k-char prompt handled (capped), no crash');
  assert.ok(byId[6] && byId[6].result && byId[6].result.isError, 'unknown tool returns isError, not a crash');

  console.log('✅ mcp.test PASS — handshake · tools · resources · free compute · oversized-input · unknown-tool');
})().catch((e) => { console.error('❌ mcp.test FAIL:', e.message); process.exit(1); });
