'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   tool-select.js — SELECTIVE TOOL INJECTION.

   The overlooked token drain: every agent turn re-sends the FULL tool schema —
   40 tools × ~150 tokens of JSON = ~6,000 tokens on EVERY call, even "hi". Most
   turns need 2–3 tools. This picks the relevant few for the current prompt and
   drops the rest, deterministically, with no LLM and no dependencies (it reuses
   AURA's BM25 index over each tool's name + description + parameter docs).

   The guarantee that makes it safe to trust: it FAILS OPEN. If the prompt shares
   no vocabulary with any tool, or the toolbox is tiny, or nothing scores, it
   sends EVERYTHING rather than risk starving the model of a tool it needed. You
   opt into aggressiveness via `k`; you never silently lose a tool. Every decision
   is reported (sent/total, savedTokens, per-tool scores, reason, dropped names).

   selectTools(prompt, tools, opts) -> { tools: subset, report }
     opts.k            (auto)  max tools to send (default ~25% of the toolbox, min 6)
     opts.alwaysInclude ([])   tool names ALWAYS sent (criticals that don't verbalize)
     opts.minPool      (4)     at/under this many tools, send all (nothing to gain)
     opts.floor        (0)     minimum BM25 score to be eligible
   ══════════════════════════════════════════════════════════════════════════ */
const searchIndex = require('./search-index');

const estTokens = (s) => Math.max(1, Math.ceil(String(s == null ? '' : s).length / 4));

// Accept both tool shapes: OpenAI `{type:'function',function:{name,description,parameters}}`
// and Anthropic/plain `{name,description,input_schema|parameters}`.
function normalizeTool(t) {
  if (!t || typeof t !== 'object') return null;
  const f = (t.function && typeof t.function === 'object') ? t.function : t;
  const name = f.name;
  if (typeof name !== 'string' || !name) return null;
  return { name, description: typeof f.description === 'string' ? f.description : '',
    params: f.input_schema || f.parameters || {} };
}

// Split get_weatherV2 / getWeather / get.weather into word tokens the index can rank.
function splitName(name) {
  return String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ');
}

// Pull parameter names + their descriptions so a prompt can match on argument vocabulary.
function paramWords(schema) {
  const props = schema && schema.properties;
  if (!props || typeof props !== 'object') return '';
  const out = [];
  for (const k of Object.keys(props)) {
    out.push(k);
    const d = props[k] && props[k].description;
    if (typeof d === 'string') out.push(d);
  }
  return out.join(' ');
}

// The searchable "document" for a tool = name words + description + parameter docs.
function docText(nrm) {
  return [splitName(nrm.name), nrm.description, paramWords(nrm.params)].join(' ');
}

// Flatten a message's content (string or block-array) to plain text.
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b && typeof b.text === 'string') ? b.text : '').join(' ');
  return '';
}

// Build the selection query from a MESSAGE ARRAY, not just the last line: the latest user
// turn is the primary intent (repeated so it dominates ranking), plus a small window of
// recent user/assistant turns for context — so a terse "yes, do it" still selects the tool
// the conversation is about. Large blocks (tool dumps / file reads) are excluded and each
// snippet is length-capped so a giant paste can't skew the ranking.
function buildQuery(messages, opts) {
  const window = Number.isInteger(opts.contextWindow) ? opts.contextWindow : 4;
  const msgs = Array.isArray(messages) ? messages : [];
  let latest = '';
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i] && msgs[i].role === 'user') { latest = contentToText(msgs[i].content); break; }
  }
  const recent = msgs.slice(-window)
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => contentToText(m.content))
    .filter((t) => t && t.length <= 800)   // skip big tool dumps — they'd skew the query
    .map((t) => t.slice(0, 400));
  return [latest, latest, ...recent].join('\n').trim();
}

function selectTools(promptOrMessages, tools, opts = {}) {
  opts = opts || {};
  const list = Array.isArray(tools) ? tools : [];
  const total = list.length;
  const allOut = (reason) => ({ tools: list, report: { total, sent: total, savedTokens: 0, reason, scores: [], dropped: [] } });

  // Accept a plain prompt string OR a message array (context-aware). Arrays build a weighted
  // query from the latest user turn + recent context; strings are used as-is (backward compatible).
  const p = (Array.isArray(promptOrMessages)
    ? buildQuery(promptOrMessages, opts)
    : String(promptOrMessages == null ? '' : promptOrMessages)).trim();
  const minPool = Number.isInteger(opts.minPool) ? opts.minPool : 4;
  if (total <= minPool) return allOut('pool-too-small');
  if (!p) return allOut('no-prompt');

  const norms = list.map(normalizeTool);
  const entries = [];
  norms.forEach((nrm) => { if (nrm) entries.push({ key: nrm.name, prompt: docText(nrm) }); });
  if (!entries.length) return allOut('no-named-tools');

  const idx = searchIndex.buildIndex(entries);
  const ranked = searchIndex.search(idx, p, { limit: total });
  if (!ranked.length) return allOut('no-signal');

  const floor = Number(opts.floor) > 0 ? Number(opts.floor) : 0;
  const k = (Number.isInteger(opts.k) && opts.k > 0)
    ? opts.k
    : Math.min(total, Math.max(6, Math.ceil(total * 0.25)));
  const always = new Set((Array.isArray(opts.alwaysInclude) ? opts.alwaysInclude : []).map(String));

  const chosen = new Set();
  for (const r of ranked) { if (chosen.size >= k) break; if (r.score > floor) chosen.add(r.key); }
  for (const nrm of norms) { if (nrm && always.has(nrm.name)) chosen.add(nrm.name); }
  if (!chosen.size) chosen.add(ranked[0].key);          // never send zero tools
  if (chosen.size >= total) return allOut('no-benefit');

  const outTools = list.filter((t, i) => norms[i] && chosen.has(norms[i].name));
  const savedTokens = Math.max(0, estTokens(JSON.stringify(list)) - estTokens(JSON.stringify(outTools)));
  const dropped = norms.filter((nrm) => nrm && !chosen.has(nrm.name)).map((nrm) => nrm.name);
  return { tools: outTools, report: { total, sent: outTools.length, savedTokens, reason: 'selected', k, scores: ranked, dropped } };
}

module.exports = { selectTools, normalizeTool, docText };
