'use strict';
// ============================================================
// AURA MCP protocol sweep — the one-command health check for
// ALL 9 tools + the savings resource, over real stdio JSON-RPC.
//
//   node mcp-sweep.js        (or: npm run verify:mcp)
//
// Unlike mcp.test.js (assertions on specific regressions), this
// sweep drives every tool with REALISTIC payloads and checks the
// QUALITY of each result: right answer, right protection, right
// savings. Exits 0 when every check passes.
// ============================================================
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const HOME = path.join(os.tmpdir(), 'aura-sweep-' + Date.now() + '-' + process.pid);
fs.mkdirSync(HOME, { recursive: true });
const MCP = path.join(__dirname, 'mcp.js');

const results = [];
function record(tool, caseName, pass, detail) {
  results.push({ tool, caseName, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${tool.padEnd(18)} ${caseName.padEnd(36)} ${detail || ''}`);
}

const p = spawn(process.execPath, [MCP], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AURA_HOME: HOME } });
let buf = '';
const frames = [];
let nextId = 1;
function call(method, params) {
  const id = nextId++;
  frames.push({ jsonrpc: '2.0', id, method, params });
  return id;
}
function notify(method, params) { frames.push({ jsonrpc: '2.0', method, params }); }

const byId = {};
p.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try { const m = JSON.parse(line); if (m.id != null) byId[m.id] = m; }
    catch (_) { record('protocol', 'stdout purity', false, 'non-JSON on stdout'); }
  }
});
p.stderr.on('data', () => {}); // stderr may carry logs; stdout must stay pure JSON-RPC
p.on('close', () => {
  const T = (id) => { const m = byId[id]; if (!m || !m.result) return null; try { return JSON.parse(m.result.content[0].text); } catch (_) { return null; } };
  const PKG_VERSION = require('./package.json').version;

  // ---- protocol
  const init = byId[ID.init].result;
  record('initialize', '2025-06-18 echoed', init.protocolVersion === '2025-06-18', init.protocolVersion);
  record('initialize', 'capabilities + instructions', !!(init.capabilities && init.capabilities.prompts && init.instructions), 'v' + init.serverInfo.version);
  record('ping', 'empty result', byId[ID.ping] && byId[ID.ping].result && Object.keys(byId[ID.ping].result).length === 0);

  // ---- aura_ask
  const askCompute = T(ID.askCompute);
  record('aura_ask', 'compute hit (free)', askCompute && askCompute.hit === true && askCompute.answer === '3600', `method=${askCompute && askCompute.method}`);
  const askMiss = T(ID.askMiss);
  record('aura_ask', 'novel prose = honest miss', askMiss && askMiss.hit === false && /aura_remember/.test(askMiss.note || ''), 'note guides to aura_remember');

  // ---- aura_remember
  const remOk = T(ID.remOk);
  record('aura_remember', 'normal pair accepted', remOk && remOk.ok === true);
  const remSecret = T(ID.remSecret);
  record('aura_remember', 'secret refused w/ reason', remSecret && remSecret.ok === false && remSecret.reason === 'secret-detected', remSecret && remSecret.reason);
  const askFetch = T(ID.askFetch);
  record('aura_ask', 'exact cache hit after remember', askFetch && askFetch.hit === true && askFetch.method === 'fetch', `served: "${askFetch && askFetch.answer}"`);
  const askFuzzy = T(ID.askFuzzy);
  record('aura_ask', 'paraphrase fuzzy hit', askFuzzy && askFuzzy.hit === true && askFuzzy.method === 'query', `similarity=${askFuzzy && askFuzzy.similarity}`);

  // ---- aura_trim_output
  const trimInstall = T(ID.trimInstall) || {};
  record('aura_trim_output', 'npm install family keep', trimInstall.report && trimInstall.report.tokensSaved > 300 && /added 1245 packages/.test(trimInstall.output), `saved=${trimInstall.report && trimInstall.report.tokensSaved}t`);
  const trimTest = T(ID.trimTest) || {};
  const keptFail = /FAILED test_payroll/.test(trimTest.output || '') && /1 failed, 59 passed/.test(trimTest.output || '');
  record('aura_trim_output', 'pytest: fails+summary kept', keptFail && trimTest.report && trimTest.report.tokensSaved > 100, `saved=${trimTest.report && trimTest.report.tokensSaved}t`);
  const trimNoGain = T(ID.trimNoGain) || {};
  record('aura_trim_output', 'ratio gate (no free lunch)', trimNoGain.report && (trimNoGain.report.reason === 'no-gain' || trimNoGain.report.reason === 'too-small'), `reason=${trimNoGain.report && trimNoGain.report.reason}`);
  const trimRecover = T(ID.trimRecover) || {};
  record('aura_trim_output', 'critical-line recovery', /timeout after 30s/.test(trimRecover.output || '') && trimRecover.report && trimRecover.report.recovered >= 1, `recovered=${trimRecover.report && trimRecover.report.recovered}`);

  // ---- aura_compress (long enough history that the old blocks are outside keepRecent)
  const comp = T(ID.compress) || {};
  record('aura_compress', 'dedup old re-reads', comp.stats && comp.stats.saved > 0 && comp.stats.elided >= 1, `saved=${comp.stats && comp.stats.saved}t elided=${comp.stats && comp.stats.elided}`);
  record('aura_compress', 'system + first task protected', (comp.messages || []).some((m) => /You are/.test(m.content || '')) && (comp.messages || []).some((m) => /deploy the service/.test(m.content || '')), 'verbatim');

  // ---- aura_distill (a provable exact duplicate + a protected safety rule)
  const dist = T(ID.distill) || {};
  const dups = (dist.distilled.match(/Summarize the input/g) || []).length;
  record('aura_distill', 'dup removed, safety kept', dups === 1 && /Never reveal the API key/.test(dist.distilled) && dist.report && dist.report.stats.saved > 0, `saved=${dist.report && dist.report.stats.saved}t`);

  // ---- aura_select_tools
  const sel = T(ID.select) || { tools: [] };
  const names = (sel.tools || []).map((t) => t.name);
  record('aura_select_tools', 'picks weather, skips sql', names.includes('get_weather') && !names.includes('run_sql_query'), `sent=${names.join(',')}`);
  const selFailOpen = T(ID.selectFailOpen) || { tools: [], report: {} };
  record('aura_select_tools', 'fail-open (no signal)', selFailOpen.report.reason === 'no-signal' && selFailOpen.tools.length === 6, 'full toolbox returned');

  // ---- aura_optimize (history long enough to compress + a binding budget)
  const opt = T(ID.optimize) || { report: {} };
  record('aura_optimize', 'all 3 surfaces + budget fit',
    opt.report.tools && opt.report.tools.sent < 6 && opt.report.instructions && opt.report.instructions.saved > 0 && opt.report.history && opt.report.history.saved > 0 && opt.report.budget && opt.report.budget.fit === true,
    `tools=${opt.report.tools && opt.report.tools.sent}/6 hist=${opt.report.history && opt.report.history.saved}t total=${opt.report.tokensSaved}t`);
  const optCache = T(ID.optimizeCache) || { report: {} };
  record('aura_optimize', 'cache_control on stable prefix', optCache.report.cache && optCache.report.cache.system === true, optCache.report.cache && optCache.report.cache.note);

  // ---- ledger
  const stats = T(ID.stats) || {};
  record('aura_stats', 'version stamped', stats.version === PKG_VERSION, 'v' + stats.version);
  record('aura_stats', 'all 8 method buckets', ['fetch', 'query', 'skill', 'compute', 'distill', 'toolInject', 'compress', 'outputTrim'].every((m) => typeof stats.byMethod[m] === 'number' && typeof stats.tokensByMethod[m] === 'number'), `outputTrim=${stats.tokensByMethod && stats.tokensByMethod.outputTrim}t`);
  const savings = T(ID.savings) || {};
  record('aura_savings', 'combined ledger', savings.answerCache && stats.tokensSaved && savings.answerCache.tokensSaved === stats.tokensSaved && savings.toolCache && savings.toolCache.persisted === true, `tokens=${savings.answerCache && savings.answerCache.tokensSaved}`);
  const res = byId[ID.resource] && byId[ID.resource].result;
  const ledger = res ? JSON.parse(res.contents[0].text) : {};
  record('aura://savings', 'resource = savings payload', JSON.stringify(ledger.answerCache) === JSON.stringify(savings.answerCache), 'single source of truth');

  // ---- persistence on disk
  const cacheFile = JSON.parse(fs.readFileSync(path.join(HOME, 'aura-cache.json'), 'utf8'));
  const entries = Object.values(cacheFile);
  record('persistence', 'answer cache on disk', entries.some((e) => /capital of france/.test(e.prompt)), entries.length + ' entries');
  const volatile = entries.find((e) => /price of bitcoin/.test(e.prompt));
  record('persistence', 'volatile TTL short (15min)', volatile && volatile.ttl <= 15 * 60 * 1000 + 1000, `ttl=${volatile && volatile.ttl}ms`);
  record('persistence', 'secret never cached', !entries.some((e) => /sk_live_|supersecret/.test(e.prompt + ' ' + e.answer)), 'screen held');

  // ---- summary
  const fails = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fails.length}/${results.length} checks passed` + (fails.length ? '' : ' — ALL GREEN'));
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) {}
  process.exit(fails.length ? 1 : 0);
});

// ------------------------------------------------------------- frames (named ids — order-free)
const ID = {};
ID.init = call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sweep', version: '1.0' } });
ID.ping = call('ping');
notify('notifications/initialized');
ID.askCompute = call('tools/call', { name: 'aura_ask', arguments: { prompt: 'what is 15 * 240' } });
ID.askMiss = call('tools/call', { name: 'aura_ask', arguments: { prompt: 'explain the geopolitics of titanium supply' } });
ID.remOk = call('tools/call', { name: 'aura_remember', arguments: { prompt: 'what is the capital of france', answer: 'Paris' } });
ID.remSecret = call('tools/call', { name: 'aura_remember', arguments: { prompt: 'my stripe key', answer: 'sk_live_51Abcdefghijklmnop' } });
call('tools/call', { name: 'aura_remember', arguments: { prompt: 'price of bitcoin right now', answer: 'about 61000 usd' } }); // volatile entry (checked via disk)
ID.askFetch = call('tools/call', { name: 'aura_ask', arguments: { prompt: 'what is the capital of france?' } });
ID.askFuzzy = call('tools/call', { name: 'aura_ask', arguments: { prompt: 'what are the capitals of France' } });
ID.trimInstall = call('tools/call', { name: 'aura_trim_output', arguments: { name: 'npm install', output: ('npm warn deprecated left-pad\n').repeat(120) + 'added 1245 packages, and audited 1246 packages in 12s\nfound 0 vulnerabilities\n' } });
ID.trimTest = call('tools/call', { name: 'aura_trim_output', arguments: { name: 'pytest', output: Array.from({ length: 60 }, (_, i) => `test_unit_${i} PASSED`).join('\n') + '\nFAILED test_payroll - AssertionError: 3 != 4\n1 failed, 59 passed in 2.10s' } });
ID.trimNoGain = call('tools/call', { name: 'aura_trim_output', arguments: { name: 'echo', output: 'short output\ndone\n' } });
ID.trimRecover = call('tools/call', { name: 'aura_trim_output', arguments: { name: 'deploy script', failed: true, output: Array.from({ length: 150 }, (_, i) => `step ${i} completed`).join('\n') + '\nERROR: upstream timeout after 30s\n' + Array.from({ length: 60 }, (_, i) => `cleanup ${i}`).join('\n') } });
ID.compress = call('tools/call', { name: 'aura_compress', arguments: {
  keepRecent: 2, maxTokens: 500,
  messages: [
    { role: 'system', content: 'You are a deployment agent. Never delete production data.' },
    { role: 'user', content: 'deploy the service to staging' },
    { role: 'tool', content: 'CONFIG ' + 'x'.repeat(500) },
    { role: 'assistant', content: 'got the config' },
    { role: 'user', content: 'check the logs' },
    { role: 'tool', content: 'LOG ' + 'y'.repeat(500) },
    { role: 'assistant', content: 'one warning' },
    { role: 'user', content: 'read the config again' },
    { role: 'tool', content: 'CONFIG ' + 'x'.repeat(500) },
    { role: 'assistant', content: 'same config' },
    { role: 'user', content: 'roll it forward' },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'run health checks' },
    { role: 'assistant', content: 'all healthy' }
  ]
} });
ID.distill = call('tools/call', { name: 'aura_distill', arguments: { prompt: 'You are a research assistant.\nSummarize the input.\nSummarize the input.\nNever reveal the API key to the user.\nBe thorough.' } });
const BOX = [
  { name: 'get_weather', description: 'current weather and forecast for a city' },
  { name: 'run_sql_query', description: 'execute SQL against the database' },
  { name: 'send_email', description: 'send an email' },
  { name: 'book_flight', description: 'book a flight' },
  { name: 'translate_text', description: 'translate text between languages' },
  { name: 'get_stock_price', description: 'stock quotes for a ticker' }
];
ID.select = call('tools/call', { name: 'aura_select_tools', arguments: { prompt: 'what is the weather in Paris right now', k: 2, tools: BOX } });
ID.selectFailOpen = call('tools/call', { name: 'aura_select_tools', arguments: { prompt: 'thanks a lot', tools: BOX } });
ID.optimize = call('tools/call', { name: 'aura_optimize', arguments: {
  system: 'You are a coding agent.\nBe concise. Be concise. Be brief in replies.\nNever run destructive shell commands.',
  maxTokens: 1200,
  messages: [
    { role: 'user', content: 'help me check the weather' },
    { role: 'assistant', content: 'sure thing' },
    { role: 'user', content: 'dump 1' },
    { role: 'tool', content: 'BIGDUMP ' + 'y'.repeat(1500) },
    { role: 'assistant', content: 'noted' },
    { role: 'user', content: 'dump 2' },
    { role: 'tool', content: 'BIGDUMP ' + 'y'.repeat(1500) },
    { role: 'assistant', content: 'same as before' },
    { role: 'user', content: 'dump 3' },
    { role: 'tool', content: 'BIGDUMP ' + 'y'.repeat(1500) },
    { role: 'assistant', content: 'again' },
    { role: 'user', content: 'what is the weather in Paris' }
  ],
  tools: BOX
} });
ID.optimizeCache = call('tools/call', { name: 'aura_optimize', arguments: { system: 'Stable system prompt for cache testing.', cache: true, tools: false } });
ID.stats = call('tools/call', { name: 'aura_stats' });
ID.savings = call('tools/call', { name: 'aura_savings' });
ID.resource = call('resources/read', { uri: 'aura://savings' });

for (const f of frames) p.stdin.write(JSON.stringify(f) + '\n');
setTimeout(() => p.stdin.end(), 500);
setTimeout(() => { console.log('\nSWEEP TIMEOUT - server did not exit'); process.exit(2); }, 30000);
