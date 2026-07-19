'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   tool-select-benchmark.js — the "wow": how much a real agent wastes shipping
   its ENTIRE toolbox on every turn, and how much AURA saves by sending only the
   tools each prompt actually needs.  Run: node benchmarks/tool-select-benchmark.js
   ══════════════════════════════════════════════════════════════════════════ */
const { selectTools } = require('../lib/tool-select');

const estTokens = (s) => Math.max(1, Math.ceil(String(s == null ? '' : s).length / 4));
// Representative model input price ($/1M tokens). Claude Sonnet-class input ≈ $3/M.
const USD_PER_TOKEN = 3 / 1e6;

// A realistic 40-tool agent toolbox (file ops, git, shell, web, data, comms, cloud…).
const t = (name, description, props) => ({ name, description, input_schema: { type: 'object', properties: props || {} } });
const TOOLS = [
  t('read_file', 'Read the contents of a file from disk', { path: { type: 'string', description: 'file path' } }),
  t('write_file', 'Create or overwrite a file with new contents', { path: { type: 'string' }, content: { type: 'string' } }),
  t('edit_file', 'Apply a find-and-replace edit to an existing file', { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } }),
  t('delete_file', 'Delete a file from the filesystem', { path: { type: 'string' } }),
  t('list_directory', 'List files and folders in a directory', { path: { type: 'string' } }),
  t('search_code', 'Search the codebase for a text pattern or regular expression', { pattern: { type: 'string' } }),
  t('run_shell', 'Execute a shell command and return stdout and stderr', { command: { type: 'string' } }),
  t('git_status', 'Show the working tree status of the git repository', {}),
  t('git_commit', 'Create a git commit with a message', { message: { type: 'string' } }),
  t('git_push', 'Push local commits to the remote repository', { remote: { type: 'string' } }),
  t('git_diff', 'Show the diff of uncommitted changes', {}),
  t('open_pull_request', 'Open a GitHub pull request from the current branch', { title: { type: 'string' } }),
  t('search_web', 'Search the internet for web pages and current information', { query: { type: 'string' } }),
  t('fetch_url', 'Fetch and return the contents of a web page by URL', { url: { type: 'string' } }),
  t('get_weather', 'Get the current weather and forecast for a city', { city: { type: 'string' } }),
  t('send_email', 'Send an email message to a recipient', { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }),
  t('send_slack', 'Post a message to a Slack channel', { channel: { type: 'string' }, text: { type: 'string' } }),
  t('create_calendar_event', 'Create an event on the calendar', { title: { type: 'string' }, start: { type: 'string' } }),
  t('run_sql', 'Run a SQL query against the database', { sql: { type: 'string' } }),
  t('list_tables', 'List the tables available in the database', {}),
  t('describe_table', 'Show the schema of a database table', { table: { type: 'string' } }),
  t('upload_s3', 'Upload a file to an S3 bucket', { bucket: { type: 'string' }, key: { type: 'string' } }),
  t('download_s3', 'Download an object from an S3 bucket', { bucket: { type: 'string' }, key: { type: 'string' } }),
  t('deploy_service', 'Deploy the application to a hosting environment', { environment: { type: 'string' } }),
  t('rollback_deploy', 'Roll back the last deployment', { environment: { type: 'string' } }),
  t('get_logs', 'Fetch recent application logs from a service', { service: { type: 'string' } }),
  t('create_ticket', 'Create a Jira issue or support ticket', { title: { type: 'string' }, priority: { type: 'string' } }),
  t('convert_currency', 'Convert an amount from one currency to another', { amount: { type: 'number' }, from: { type: 'string' }, to: { type: 'string' } }),
  t('book_flight', 'Book a flight ticket between two airports', { from: { type: 'string' }, to: { type: 'string' } }),
  t('translate_text', 'Translate text from one language to another', { text: { type: 'string' }, target: { type: 'string' } }),
  t('summarize_text', 'Summarize a long piece of text into key points', { text: { type: 'string' } }),
  t('generate_image', 'Generate an image from a text prompt', { prompt: { type: 'string' } }),
  t('transcribe_audio', 'Transcribe spoken audio into text', { url: { type: 'string' } }),
  t('create_chart', 'Create a chart or graph from a dataset', { type: { type: 'string' }, data: { type: 'array' } }),
  t('read_spreadsheet', 'Read rows from a spreadsheet', { file: { type: 'string' } }),
  t('scrape_prices', 'Scrape product prices from a retail website', { url: { type: 'string' } }),
  t('geocode_address', 'Convert a street address into latitude and longitude', { address: { type: 'string' } }),
  t('get_stock_quote', 'Get the current stock price for a ticker symbol', { symbol: { type: 'string' } }),
  t('sign_document', 'Send a document out for e-signature', { document: { type: 'string' }, signer: { type: 'string' } }),
  t('schedule_meeting', 'Find a time and schedule a meeting with attendees', { attendees: { type: 'array' } }),
];

// Realistic single-turn user prompts an agent would receive.
const PROMPTS = [
  'read the config file at src/config.json and show me the database settings',
  'commit my changes with the message "fix login bug" and push to origin',
  "what's the weather in Tokyo this weekend?",
  'search the codebase for where we validate the API key',
  'send an email to the team about the launch on Friday',
  'run the SQL query to count users created this month',
  'deploy the app to staging and then show me the logs',
  'translate this paragraph into Spanish for the docs',
  'open a pull request titled "Add tool injection"',
  'convert 250 euros to US dollars',
  'hey, thanks — that all looks good!',            // no tool needed → fail-open shows honesty
];

const full = estTokens(JSON.stringify(TOOLS));
console.log(`\n  AURA · selective tool injection benchmark`);
console.log(`  Toolbox: ${TOOLS.length} tools · full schema = ${full} tokens re-sent on EVERY call\n`);
console.log('  ' + 'prompt'.padEnd(52) + 'sent'.padStart(6) + 'tok'.padStart(8) + 'saved'.padStart(8) + '  reason');
console.log('  ' + '-'.repeat(84));

let totalBefore = 0, totalAfter = 0;
for (const p of PROMPTS) {
  const r = selectTools(p, TOOLS);              // default k (~25%, min 6), fail-open safety on
  const after = estTokens(JSON.stringify(r.tools));
  totalBefore += full; totalAfter += after;
  const label = (p.length > 50 ? p.slice(0, 49) + '…' : p).padEnd(52);
  console.log('  ' + label + String(r.report.sent).padStart(6) + String(after).padStart(8) +
    String(full - after).padStart(8) + '  ' + r.report.reason);
}

const saved = totalBefore - totalAfter;
const pct = Math.round((saved / totalBefore) * 1000) / 10;
console.log('  ' + '-'.repeat(84));
console.log(`\n  Across ${PROMPTS.length} calls:`);
console.log(`    tool tokens before : ${totalBefore.toLocaleString()}`);
console.log(`    tool tokens after  : ${totalAfter.toLocaleString()}`);
console.log(`    saved              : ${saved.toLocaleString()} tokens  (${pct}%)`);
console.log(`\n  Projected to 100,000 agent calls at $3/M input:`);
const per = saved / PROMPTS.length;
console.log(`    ~${Math.round(per).toLocaleString()} tokens saved/call → ${Math.round(per * 100000).toLocaleString()} tokens → $${(per * 100000 * USD_PER_TOKEN).toFixed(2)} saved`);
console.log(`\n  Deterministic · zero-dependency · fails open (never drops a tool it can't rule out).\n`);
