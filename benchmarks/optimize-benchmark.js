'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   optimize-benchmark.js — the capstone: what AURA saves across a REAL agent
   session when you call aura.optimize() every turn. Tools + system prompt +
   the whole growing history are re-sent on every call; AURA trims all three.
   Run: node benchmarks/optimize-benchmark.js
   ══════════════════════════════════════════════════════════════════════════ */
const os = require('os');
const path = require('path');
process.env.AURA_HOME = path.join(os.tmpdir(), 'aura-optbench-' + Date.now()); // isolate ledger
const aura = require('../aura-core');

const estTokens = (s) => Math.max(1, Math.ceil(String(s == null ? '' : s).length / 4));
const USD_PER_TOKEN = 3 / 1e6; // Claude Sonnet-class input ≈ $3 / 1M tokens

// A realistic 40-tool coding/ops agent.
const td = (name, description, props) => ({ name, description, input_schema: { type: 'object', properties: props || {} } });
const TOOLS = [
  td('read_file', 'Read the contents of a file from disk', { path: { type: 'string' } }),
  td('write_file', 'Create or overwrite a file with new contents', { path: { type: 'string' }, content: { type: 'string' } }),
  td('edit_file', 'Apply a find-and-replace edit to a file', { path: { type: 'string' } }),
  td('delete_file', 'Delete a file', { path: { type: 'string' } }),
  td('list_directory', 'List files in a directory', { path: { type: 'string' } }),
  td('search_code', 'Search the codebase for a pattern', { pattern: { type: 'string' } }),
  td('run_shell', 'Execute a shell command', { command: { type: 'string' } }),
  td('git_status', 'Show git working tree status', {}),
  td('git_commit', 'Create a git commit with a message', { message: { type: 'string' } }),
  td('git_push', 'Push commits to the remote', { remote: { type: 'string' } }),
  td('git_diff', 'Show the diff of uncommitted changes', {}),
  td('open_pull_request', 'Open a GitHub pull request', { title: { type: 'string' } }),
  td('search_web', 'Search the internet for information', { query: { type: 'string' } }),
  td('fetch_url', 'Fetch the contents of a web page', { url: { type: 'string' } }),
  td('get_weather', 'Get the current weather for a city', { city: { type: 'string' } }),
  td('send_email', 'Send an email to a recipient', { to: { type: 'string' } }),
  td('send_slack', 'Post a message to a Slack channel', { channel: { type: 'string' } }),
  td('create_calendar_event', 'Create a calendar event', { title: { type: 'string' } }),
  td('run_sql', 'Run a SQL query against the database', { sql: { type: 'string' } }),
  td('list_tables', 'List database tables', {}),
  td('describe_table', 'Show a table schema', { table: { type: 'string' } }),
  td('upload_s3', 'Upload a file to S3', { bucket: { type: 'string' } }),
  td('download_s3', 'Download a file from S3', { bucket: { type: 'string' } }),
  td('deploy_service', 'Deploy the app to an environment', { environment: { type: 'string' } }),
  td('rollback_deploy', 'Roll back the last deploy', { environment: { type: 'string' } }),
  td('get_logs', 'Fetch recent application logs', { service: { type: 'string' } }),
  td('create_ticket', 'Create a Jira ticket', { title: { type: 'string' } }),
  td('convert_currency', 'Convert money between currencies', { amount: { type: 'number' } }),
  td('book_flight', 'Book a flight', { to: { type: 'string' } }),
  td('translate_text', 'Translate text between languages', { text: { type: 'string' } }),
  td('summarize_text', 'Summarize a long text', { text: { type: 'string' } }),
  td('generate_image', 'Generate an image from a prompt', { prompt: { type: 'string' } }),
  td('transcribe_audio', 'Transcribe audio to text', { url: { type: 'string' } }),
  td('create_chart', 'Create a chart from data', { type: { type: 'string' } }),
  td('read_spreadsheet', 'Read rows from a spreadsheet', { file: { type: 'string' } }),
  td('geocode_address', 'Convert an address to coordinates', { address: { type: 'string' } }),
  td('get_stock_quote', 'Get a stock price', { symbol: { type: 'string' } }),
  td('sign_document', 'Send a document for e-signature', { document: { type: 'string' } }),
  td('schedule_meeting', 'Schedule a meeting with attendees', { attendees: { type: 'array' } }),
  td('list_branches', 'List git branches', {}),
];

// A slightly bloated system prompt (has an exact-duplicate line distill will trim).
const SYSTEM = [
  'You are an autonomous senior engineering agent working in a real repository.',
  'Be concise and clear in your explanations.',
  'Be concise and clear in your explanations.',
  'Always run the tests after making a change.',
  'Never delete or overwrite files without explicit confirmation from the user.',
  'When you are unsure, ask one clarifying question rather than guessing.',
].join('\n');

// Realistic user turns; the agent works a codebase and does ops. Terse follow-ups included
// so context-aware tool selection is exercised.
const USER_TURNS = [
  'read src/server.js and tell me how routing works',
  'search the codebase for where we validate auth tokens',
  'edit the auth middleware to reject expired tokens',
  'run the tests',
  'they pass — commit this with message "reject expired tokens"',
  'now push it',
  'open a pull request titled "Harden auth"',
  'deploy to staging',
  'show me the logs for the api service',
  'looks good, whats the weather in Denver for my flight tomorrow',
];

function bigToolResult(turn) {
  return `[tool result @ turn ${turn}]\n` + Array.from({ length: 40 }, (_, i) => `  ${turn}.${i}: output data line for step ${turn}`).join('\n');
}
function fileReRead(v) {
  const lines = Array.from({ length: 45 }, (_, i) => `  const route${i} = (req, res) => res.send(${i});`);
  for (let e = 0; e <= v; e++) { const k = (e * 4) % 45; lines[k] = `  const route${k} = (req, res) => res.json({ v: ${100 + e} });`; }
  return `// src/server.js  (read #${v + 1})\nexport function server(app) {\n${lines.join('\n')}\n}\n`;
}

function run() {
  const messages = [];
  let baselineTotal = 0, optimizedTotal = 0;

  USER_TURNS.forEach((text, t) => {
    messages.push({ role: 'user', content: text });

    // WITHOUT AURA: the request re-sends the full system + tools + history this turn.
    const baselineReq = { system: SYSTEM, tools: TOOLS, messages };
    baselineTotal += estTokens(JSON.stringify(baselineReq));

    // WITH AURA: one call trims tools, distills the system prompt, compacts history.
    const { request } = aura.optimize(baselineReq, { tools: { k: 5 }, compress: { keepRecent: 6, dedupOver: 150 } });
    optimizedTotal += estTokens(JSON.stringify(request));

    // the agent responds + a tool result comes back (file re-reads on some turns)
    messages.push({ role: 'assistant', content: `Working on: ${text}` });
    if (t < 4) messages.push({ role: 'user', content: fileReRead(t) });        // re-reads the same file
    else messages.push({ role: 'user', content: bigToolResult(t) });           // big tool dumps
  });

  const saved = baselineTotal - optimizedTotal;
  return { turns: USER_TURNS.length, baselineTotal, optimizedTotal, saved, pct: (saved / baselineTotal) * 100, ledger: aura.stats() };
}

if (require.main === module) {
  const r = run();
  const s = r.ledger;
  console.log('\n  AURA · full aura.optimize() over a real agent session');
  console.log('  ' + '─'.repeat(66));
  console.log(`  ${r.turns} turns · 40 tools · growing history · re-sent every call\n`);
  console.log(`  tokens sent, NO AURA    ${r.baselineTotal.toLocaleString().padStart(10)}`);
  console.log(`  tokens sent, WITH AURA  ${r.optimizedTotal.toLocaleString().padStart(10)}`);
  console.log(`  SAVED                   ${r.saved.toLocaleString().padStart(10)}   (${r.pct.toFixed(1)}%)`);
  console.log(`  ~$ saved (this session) ${('$' + (r.saved * USD_PER_TOKEN).toFixed(4)).padStart(10)}  @ $3/M input\n`);
  const tbm = s.tokensByMethod || {};
  const LABEL = { toolInject: 'tool injection', compress: 'history compress', distill: 'distill' };
  console.log('  where it came from (per surface):');
  for (const k of ['toolInject', 'compress', 'distill']) {
    console.log(`    ${LABEL[k].padEnd(18)} ${(tbm[k] || 0).toLocaleString().padStart(9)} tokens`);
  }
  console.log('\n  one call per turn · deterministic · fails open · every cut reported.');
  console.log('  ' + '─'.repeat(66) + '\n');
}

module.exports = { run };
