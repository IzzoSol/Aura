#!/usr/bin/env node
// ============================================================
// AURA MCP server — zero-dependency.
// Exposes AURA's token-saving over the Model Context Protocol (stdio,
// JSON-RPC 2.0) so Claude Desktop / Claude Code / Cursor / any MCP client
// can answer recurring prompts for FREE (cache / saved skills / deterministic
// compute) BEFORE spending model tokens.
//
// Run:  aura-mcp     (after `npm i -g @shaddai/aura`)
//   or:  node mcp.js
// ============================================================
const aura = require('./aura-core');
const { compress } = require('./lib/context-compress');
const { toolStats } = require('./lib/tool-cache');
const { distill } = require('./lib/prompt-distill');
let PKG = { version: '0.0.0' };
try { PKG = require('./package.json'); } catch (_) {}

// stdout MUST carry only JSON-RPC frames — any stray log corrupts the protocol.
// Redirect console.* to stderr defensively so nothing can poison the stream.
console.log = console.info = console.debug = function () {
  try { process.stderr.write(Array.prototype.join.call(arguments, ' ') + '\n'); } catch (_) {}
};

// Cap tool inputs so a client can't exhaust memory with a giant string.
const MAX_PROMPT = 20000;
const MAX_ANSWER = 200000;
// Caps for aura_compress: bound the number of messages AND the size of each one,
// so a malicious/huge conversation can't blow up memory before we even compress it.
const MAX_MESSAGES = 2000;         // hard cap on how many messages we accept
const MAX_MSG_CONTENT = 200000;    // per-message content clip (chars)
function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) : s; }

const TOOLS = [
  {
    name: 'aura_ask',
    description:
      "Try to answer a prompt for FREE using AURA's local cache, saved skills, or deterministic compute (math, unit/date conversions, percentages, etc.). " +
      'Call this BEFORE generating an answer yourself. If the result has hit=true, use its answer and skip your own reasoning to save tokens. ' +
      'If hit=false, answer the user normally and then call aura_remember to cache your answer for next time.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The user prompt/question to try to answer for free.' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'aura_remember',
    description:
      'Teach AURA an answer so the same or a similar prompt is free next time. ' +
      'Call this after you generate an answer that is stable/reusable (facts, definitions, policies, computed results).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The prompt this answer corresponds to.' },
        answer: { type: 'string', description: 'The answer to cache.' }
      },
      required: ['prompt', 'answer']
    }
  },
  {
    name: 'aura_stats',
    description: 'Report how many tokens and dollars AURA has saved so far, and cache hit counts.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'aura_compress',
    description:
      "Shrink a conversation history BEFORE re-sending it to the model, to save tokens on every turn. " +
      'Deterministically dedups repeated blocks, truncates big old tool outputs, and (if maxTokens is set) drops the oldest ' +
      'non-pinned messages — while NEVER touching system messages, the first user task, or the last few turns. ' +
      'Returns the compressed messages plus stats (tokensBefore/After/saved). Call this on long histories before your next generation.',
    inputSchema: {
      type: 'object',
      properties: {
        messages: {
          type: 'array',
          description: 'The conversation history to compress.',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', description: 'Message role (system/user/assistant/tool).' },
              content: { type: 'string', description: 'Message content.' }
            },
            required: ['role', 'content']
          }
        },
        keepRecent: { type: 'integer', description: 'How many trailing messages to keep fully intact (default 6).' },
        maxTokens: { type: 'integer', description: 'Optional hard token budget; oldest non-pinned messages are dropped to fit.' }
      },
      required: ['messages']
    }
  },
  {
    name: 'aura_savings',
    description:
      'Combined AURA savings report: the answer-cache stats (prompts answered for free) PLUS the tool-cache stats ' +
      '(repeated tool calls avoided and the tokens that saved). One JSON payload for a full picture of what AURA has saved.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'aura_distill',
    description:
      "Trim redundant instructions from a prompt or system prompt to save tokens on EVERY call. " +
      'Deterministically removes exact/near-duplicate rules and leading filler, and FLAGS (never cuts) possibly-dead ' +
      'examples — while NEVER touching load-bearing lines: safety/permission constraints, success/stopping criteria, ' +
      'required output shape, context-dependent tool routing, and behavior-envelope rules (tool budgets, uncertainty ' +
      'policy, stop/escalation). Returns the leaner prompt plus a report (removed/flagged/protected + tokens saved). ' +
      'Call this on a long system prompt before using it.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The prompt / system prompt to distill.' },
        similarity: { type: 'number', description: 'Near-duplicate threshold 0-1 (default 0.82).' },
        trimFiller: { type: 'boolean', description: 'Strip leading hedge/filler prefixes (default true).' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'aura_select_tools',
    description:
      "Selective tool injection: given the current prompt (or recent messages) and your FULL tool list, " +
      "return only the tools this turn needs — so you don't re-send the whole toolbox on every call. " +
      'Deterministic, context-aware, and FAILS OPEN (never drops a tool it cannot rule out). ' +
      'Returns { tools, report:{ total, sent, savedTokens, dropped } }. Works with OpenAI and Anthropic tool shapes.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The current user prompt (or omit and pass messages).' },
        messages: { type: 'array', description: 'Recent messages for context-aware selection (used if prompt is omitted).', items: { type: 'object' } },
        tools: { type: 'array', description: 'Your full tool list (OpenAI or Anthropic shape).', items: { type: 'object' } },
        k: { type: 'integer', description: 'Max tools to send (default ~25% of the toolbox).' },
        alwaysInclude: { type: 'array', description: 'Tool names to always send.', items: { type: 'string' } }
      },
      required: ['tools']
    }
  },
  {
    name: 'aura_optimize',
    description:
      'One-call context optimizer: trims your tools (selective injection), distills your system prompt, and ' +
      'compresses your history — returning a leaner request to send. Optional maxTokens hard-fits a budget; ' +
      'cache:true marks the stable prefix cacheable (cache_control). Returns { request, report } with per-surface savings. ' +
      'Call this to shrink a full model request before sending it.',
    inputSchema: {
      type: 'object',
      properties: {
        system: { type: 'string', description: 'System prompt (string).' },
        messages: { type: 'array', description: 'Conversation history.', items: { type: 'object' } },
        tools: { type: 'array', description: 'Full tool list.', items: { type: 'object' } },
        k: { type: 'integer', description: 'Max tools to send.' },
        maxTokens: { type: 'integer', description: 'Hard token budget for the whole request.' },
        cache: { type: 'boolean', description: 'Mark the stable prefix cacheable (Anthropic cache_control).' }
      }
    }
  }
];

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function ok(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }
function textResult(obj) { return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] }; }

async function callTool(name, args) {
  args = args || {};
  if (name === 'aura_ask') {
    // llm:false — the MCP server NEVER calls a paid model or touches API keys.
    const r = await aura.ask(clip(args.prompt, MAX_PROMPT), { llm: false });
    if (r && r.hit) return textResult({ hit: true, method: r.method, answer: r.answer });
    return textResult({ hit: false, note: 'No free answer — generate it yourself, then call aura_remember to cache it.' });
  }
  if (name === 'aura_remember') {
    aura.recordAnswer(clip(args.prompt, MAX_PROMPT), clip(args.answer, MAX_ANSWER));
    return textResult({ ok: true, remembered: true });
  }
  if (name === 'aura_stats') {
    return textResult(aura.stats());
  }
  if (name === 'aura_compress') {
    // Guard malformed input WITHOUT throwing — return isError instead.
    if (!Array.isArray(args.messages)) {
      return Object.assign(textResult({ error: 'messages must be an array of {role, content}' }), { isError: true });
    }
    // Cap count first, then clip each message's content — bound memory before compressing.
    const raw = args.messages.slice(0, MAX_MESSAGES);
    const safe = raw.map((m) => {
      m = m || {};
      const role = clip(m.role == null ? '' : m.role, 64);
      // content may be a string or blocks; compress() handles both, but we clip the
      // string form defensively. Non-string content is passed through (already bounded by count).
      const content = typeof m.content === 'string' ? clip(m.content, MAX_MSG_CONTENT) : m.content;
      return { role: role || 'user', content };
    });
    const opts = {};
    if (Number.isInteger(args.keepRecent) && args.keepRecent >= 0) opts.keepRecent = args.keepRecent;
    if (Number(args.maxTokens) > 0) opts.maxTokens = Number(args.maxTokens);
    const result = compress(safe, opts);
    return textResult({ messages: result.messages, stats: result.stats });
  }
  if (name === 'aura_distill') {
    const opts = {};
    if (Number(args.similarity) > 0) opts.similarity = Number(args.similarity);
    if (args.trimFiller === false) opts.trimFiller = false;
    const res = distill(clip(args.prompt, MAX_PROMPT), opts);
    try { if (res.report.stats.saved > 0) aura.recordDistill(res.report.stats.saved); } catch (_) {}
    return textResult({ distilled: res.distilled, report: res.report });
  }
  if (name === 'aura_savings') {
    let answerCache = {};
    try { answerCache = aura.stats(); } catch (_) { answerCache = { error: 'answer-cache stats unavailable' }; }
    let toolCache = {};
    try { toolCache = toolStats(); } catch (_) { toolCache = { error: 'tool-cache stats unavailable' }; }
    return textResult({ answerCache, toolCache });
  }
  if (name === 'aura_select_tools') {
    if (!Array.isArray(args.tools)) return Object.assign(textResult({ error: 'tools must be an array' }), { isError: true });
    const tools = args.tools.slice(0, 500);
    const q = Array.isArray(args.messages) ? args.messages.slice(0, MAX_MESSAGES) : clip(args.prompt, MAX_PROMPT);
    const opts = {};
    if (Number.isInteger(args.k) && args.k > 0) opts.k = args.k;
    if (Array.isArray(args.alwaysInclude)) opts.alwaysInclude = args.alwaysInclude.slice(0, 100).map(String);
    const r = aura.selectTools(q, tools, opts);
    return textResult({ tools: r.tools, report: r.report });
  }
  if (name === 'aura_optimize') {
    const request = {};
    if (typeof args.system === 'string') request.system = clip(args.system, MAX_ANSWER);
    if (Array.isArray(args.messages)) request.messages = args.messages.slice(0, MAX_MESSAGES).map((m) => {
      m = m || {};
      const content = typeof m.content === 'string' ? clip(m.content, MAX_MSG_CONTENT) : m.content;
      return { role: clip(m.role == null ? 'user' : m.role, 64) || 'user', content };
    });
    if (Array.isArray(args.tools)) request.tools = args.tools.slice(0, 500);
    const opts = {};
    if (Number.isInteger(args.k) && args.k > 0) opts.tools = { k: args.k };
    if (Number(args.maxTokens) > 0) opts.maxTokens = Number(args.maxTokens);
    if (args.cache === true) opts.cache = true;
    const r = aura.optimize(request, opts);
    return textResult({ request: r.request, report: r.report });
  }
  return Object.assign(textResult('Unknown tool: ' + name), { isError: true });
}

// The one MCP resource: AURA's live savings ledger, so any client can pull "what has AURA
// saved" straight into its own context without a tool round-trip.
const SAVINGS_URI = 'aura://savings';
function savingsPayload() {
  let answerCache, toolCache;
  try { answerCache = aura.stats(); } catch (_) { answerCache = { error: 'answer-cache stats unavailable' }; }
  try { toolCache = toolStats(); } catch (_) { toolCache = { error: 'tool-cache stats unavailable' }; }
  return { answerCache, toolCache };
}

async function handle(msg) {
  const { id, method, params } = msg || {};
  if (method === 'initialize') {
    const proto = params && params.protocolVersion;
    return ok(id, {
      protocolVersion: proto || '2024-11-05',
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: 'aura', version: PKG.version }
    });
  }
  if (method === 'notifications/initialized' || method === 'initialized') return; // notification, no reply
  if (method === 'ping') return ok(id, {});
  if (method === 'resources/list') return ok(id, { resources: [
    { uri: SAVINGS_URI, name: 'AURA savings', description: 'Live per-surface token & cost savings ledger (tools · history · instructions · answers).', mimeType: 'application/json' }
  ] });
  if (method === 'resources/read') {
    const uri = params && params.uri;
    if (uri === SAVINGS_URI) return ok(id, { contents: [{ uri: SAVINGS_URI, mimeType: 'application/json', text: JSON.stringify(savingsPayload()) }] });
    return fail(id, -32602, 'Unknown resource: ' + uri);
  }
  if (method === 'resources/templates/list') return ok(id, { resourceTemplates: [] });
  if (method === 'prompts/list') return ok(id, { prompts: [] });
  if (method === 'tools/list') return ok(id, { tools: TOOLS });
  if (method === 'tools/call') {
    try {
      const res = await callTool(params && params.name, params && params.arguments);
      return ok(id, res);
    } catch (e) {
      return ok(id, Object.assign(textResult('Error: ' + ((e && e.message) || e)), { isError: true }));
    }
  }
  if (id !== undefined && id !== null) fail(id, -32601, 'Method not found: ' + method);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (_) { continue; }
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
