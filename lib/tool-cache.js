'use strict';
/**
 * tool-cache - the big token saver for NORMAL agent usage.
 *
 * Agents don't just re-ask questions; they re-RUN tools. Reading the same file,
 * fetching the same price, hitting the same API, scraping the same page - over and
 * over, across a conversation. Every one of those results also gets re-injected into
 * the model's context, so a repeated tool call costs twice: the call itself AND the
 * tokens to feed its result back to the LLM.
 *
 * tool-cache wraps any async tool once. A repeat call with the same arguments returns
 * the remembered result instantly ($0, 0 network) - and because it's identical, the
 * agent doesn't burn fresh tokens regenerating around it.
 *
 * v0.7: PERSISTENT. Entries AND stats now live in <AURA_HOME>/aura-tool-cache.json,
 * so savings compound across processes/sessions (an MCP server used to die with its
 * stats at zero every session). Loads once, writes behind (debounced + exit flush).
 * Multi-process safety: flush does a monotone MAX-merge with what's on disk, so
 * concurrent MCP servers never overwrite each other's savings. Disable with
 * AURA_TOOL_CACHE_PERSIST=0.
 *
 * Zero-dependency. Volatility-aware TTLs so fast-moving data (prices) expires quickly
 * while stable data (a file read, a doc) stays cached longer. Mutating actions are
 * never cached.
 *
 * Usage:
 *   const { wrap, toolStats } = require('./lib/tool-cache');
 *   const getPrice = wrap('price', rawGetPrice, { ttlMs: 45_000 });
 *   await getPrice({ coin: 'btc' });   // miss  -> real fetch, cached
 *   await getPrice({ coin: 'btc' });   // hit   -> instant, free
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { hasSecret } = require('./learn-sessions');

// ------------------------------------------------------------------ persistence
const DATA_DIR = process.env.AURA_HOME || path.join(os.homedir(), '.shaddai-aura');
const PERSIST_FILE = path.join(DATA_DIR, 'aura-tool-cache.json');
const PERSIST_ENABLED = !['0', 'false', 'off'].includes(String(process.env.AURA_TOOL_CACHE_PERSIST || '').toLowerCase());
const FLUSH_DELAY_MS = 250;   // write-behind debounce: bursts of hits = one write
// Disk guards (audit findings): a cached tool RESULT can carry anything the tool
// returned — `cat .env`, a token in a log, a conn string. Secrets never persist
// (memory-only for this process, like a non-serializable value). Oversized values
// don't persist either — 5000 × 200KB would be a ~1GB file.
const MAX_PERSIST_VALUE_CHARS = 100 * 1000;
const shouldPersistEntry = (e) => !e.secret && e.tokens * 4 <= MAX_PERSIST_VALUE_CHARS;

function ensureDir() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {} }
function readPersist() {
  try { return JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8')); } catch (_) { return null; }
}
// Monotone MAX-merge: memory stats vs disk stats, counter by counter. Stats only ever
// grow from a common ancestor, so max() unifies concurrent writers without
// double-counting. (Two fully independent processes CAN undercount their union —
// the safe direction; overcounting would be the wrong failure mode for a ledger.)
function mergeStatsMax(mem, disk) {
  const out = Object.assign({}, mem);
  for (const k of ['hits', 'misses', 'callsAvoided', 'tokensSaved']) {
    if (typeof (disk || {})[k] === 'number') out[k] = Math.max(mem[k] || 0, disk[k]);
  }
  const byTool = Object.assign({}, mem.byTool);
  for (const name of Object.keys((disk || {}).byTool || {})) {
    const d = disk.byTool[name], m = byTool[name] || { hits: 0, misses: 0, tokensSaved: 0 };
    byTool[name] = {
      hits: Math.max(m.hits || 0, d.hits || 0),
      misses: Math.max(m.misses || 0, d.misses || 0),
      tokensSaved: Math.max(m.tokensSaved || 0, d.tokensSaved || 0)
    };
  }
  out.byTool = byTool;
  return out;
}

let _loaded = false;
let _dirty = false;
let _flushTimer = null;

// hydrate from disk ONCE: entries + stats. Entry values that fail to revive are skipped.
function loadOnce() {
  if (_loaded) return;
  _loaded = true;
  if (!PERSIST_ENABLED) return;
  const d = readPersist();
  if (!d || typeof d !== 'object') return;
  if (d.stats && typeof d.stats === 'object') {
    for (const k of ['hits', 'misses', 'callsAvoided', 'tokensSaved']) {
      if (typeof d.stats[k] === 'number') stats[k] = d.stats[k];
    }
    if (d.stats.byTool && typeof d.stats.byTool === 'object') stats.byTool = d.stats.byTool;
  }
  if (d.entries && typeof d.entries === 'object') {
    const now = Date.now();
    for (const k of Object.keys(d.entries)) {
      const e = d.entries[k];
      if (!e || typeof e !== 'object') continue;
      if (typeof e.expires !== 'number' || e.expires < now) continue; // prune expired at load
      try { store.set(k, { value: JSON.parse(e.value), expires: e.expires, tokens: e.tokens || 1 }); } catch (_) {}
    }
  }
}

function flush(sync) {
  if (!PERSIST_ENABLED || !_dirty) return;
  _dirty = false;
  try {
    ensureDir();
    // merge with disk so a concurrent process's savings survive our write
    const disk = readPersist() || {};
    const diskEntries = (disk.entries && typeof disk.entries === 'object') ? disk.entries : {};
    const mergedStats = mergeStatsMax({
      hits: stats.hits, misses: stats.misses, callsAvoided: stats.callsAvoided,
      tokensSaved: stats.tokensSaved, byTool: stats.byTool
    }, disk.stats);
    const entries = {};
    // memory wins on key conflicts; disk-only keys carried over (if still fresh).
    // Secret-bearing and oversized values are deliberately NOT persisted.
    const now = Date.now();
    const seen = new Set();
    for (const [k, e] of store) {
      if (e.expires < now) continue;
      if (!shouldPersistEntry(e)) continue;
      try {
        entries[k] = { value: JSON.stringify(e.value), expires: e.expires, tokens: e.tokens };
        seen.add(k);
      } catch (_) {} // non-serializable value: stays memory-only
    }
    for (const k of Object.keys(diskEntries)) {
      if (seen.has(k)) continue;
      const e = diskEntries[k];
      if (e && typeof e === 'object' && typeof e.expires === 'number' && e.expires >= now) {
        // re-screen legacy entries too: a pre-screen file must not perpetuate secrets
        try { if (typeof e.value === 'string' && hasSecret(e.value)) continue; } catch (_) { continue; }
        entries[k] = e;
      }
    }
    const payload = JSON.stringify({ version: 1, stats: mergedStats, entries });
    if (sync) fs.writeFileSync(PERSIST_FILE, payload);
    else fs.writeFile(PERSIST_FILE, payload, () => {});
  } catch (_) {}
}

function markDirty() {
  _dirty = true;
  if (!PERSIST_ENABLED) return;
  if (_flushTimer) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(() => { _flushTimer = null; flush(false); }, FLUSH_DELAY_MS);
  if (_flushTimer.unref) _flushTimer.unref(); // never hold the process open just to flush
}

// ------------------------------------------------------------------ core
// Volatility presets (ms). Pick by tool name substring, override per-wrap.
const TTL = {
  price: 45 * 1000,          // markets move fast
  quote: 45 * 1000,
  search: 5 * 60 * 1000,     // search results drift slowly
  web: 5 * 60 * 1000,
  news: 5 * 60 * 1000,
  read: 2 * 60 * 60 * 1000,  // a file read is stable for a while
  file: 2 * 60 * 60 * 1000,
  get: 10 * 60 * 1000,
  fetch: 10 * 60 * 1000,
  default: 10 * 60 * 1000
};

// Tools whose whole purpose is to change state must NEVER be cached.
const MUTATING_VERB = /\b(write|edit|create|update|delete|remove|post|put|patch|send|deploy|commit|push|pay|transfer|mint|buy|sell|insert|drop|set)\b/;
// Tool names come as write_file, writeFile, delete-user, sendPayment . so we normalize
// camelCase and separators to spaces BEFORE matching - otherwise `\bwrite\b` misses
// `write_file` (no boundary between a letter and `_`) and a mutating tool gets cached.
function isMutating(name) {
  const normalized = String(name || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')  // camelCase -> "camel Case"
    .replace(/[^a-zA-Z]+/g, ' ')          // _ - . etc -> space
    .toLowerCase();
  return MUTATING_VERB.test(normalized);
}

const MAX_ENTRIES = 5000;

function pickTtl(name, override) {
  if (Number(override) > 0) return Number(override);
  const n = String(name || '').toLowerCase();
  for (const key of Object.keys(TTL)) if (key !== 'default' && n.includes(key)) return TTL[key];
  return TTL.default;
}

// stable key from tool name + ALL arguments (order-independent for plain objects).
// Multi-arg tools spread their args; a single-object-arg tool gets the same key it
// always had modulo the array wrapper.
function stableStringify(v) {
  try {
    return JSON.stringify(v, function (k, val) {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        return Object.keys(val).sort().reduce(function (o, key) { o[key] = val[key]; return o; }, {});
      }
      return val;
    });
  } catch (_) { return null; }
}
function keyFor(name, args) {
  const a = Array.isArray(args) ? args.map(stableStringify).join('\u0001') : stableStringify(args);
  const repr = a === null ? String(args) : a;
  return crypto.createHash('sha256').update(name + '\u241f' + repr).digest('hex');
}

const estTokens = (v) => {
  const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch (_) { return String(v); } })();
  return Math.max(1, Math.ceil((s || '').length / 4));
};

const store = new Map(); // key -> { value, expires, tokens }
const stats = { hits: 0, misses: 0, callsAvoided: 0, tokensSaved: 0, byTool: {} };

function prune() {
  const now = Date.now();
  for (const [k, e] of store) if (e.expires < now) store.delete(k);
  if (store.size > MAX_ENTRIES) {
    // drop oldest-expiring first
    const sorted = [...store.entries()].sort((a, b) => a[1].expires - b[1].expires);
    for (let i = 0; i < sorted.length - MAX_ENTRIES; i++) store.delete(sorted[i][0]);
  }
}

/**
 * wrap(name, fn, opts?) -> cached async fn.
 * opts.ttlMs overrides the volatility preset. opts.cacheNull (default false) caches a
 * null/undefined result too (usually you don't - a soft miss should be retried).
 * A tool whose name looks mutating is passed through UNCACHED, always.
 * Accepts ANY argument shape (the wrapped fn is called with the same arguments
 * the caller used - single object, positional, or none).
 */
function wrap(name, fn, opts = {}) {
  const ttlMs = pickTtl(name, opts.ttlMs);
  const mutating = isMutating(name);
  return async function cachedTool(...args) {
    if (mutating) return fn(...args); // never cache state changes
    prune();
    const key = keyFor(name, args);
    const hit = store.get(key);
    if (hit && hit.expires >= Date.now()) {
      stats.hits++;
      stats.callsAvoided++;
      stats.tokensSaved += hit.tokens;
      stats.byTool[name] = stats.byTool[name] || { hits: 0, misses: 0, tokensSaved: 0 };
      stats.byTool[name].hits++;
      stats.byTool[name].tokensSaved += hit.tokens;
      markDirty();
      return hit.value;
    }
    stats.misses++;
    stats.byTool[name] = stats.byTool[name] || { hits: 0, misses: 0, tokensSaved: 0 };
    stats.byTool[name].misses++;
    markDirty();
    const value = await fn(...args);
    if (value !== undefined && (value !== null || opts.cacheNull)) {
      // screen ONCE at cache time: a secret-bearing result is still served this
      // process, but never written to disk by flush()
      let secret = false;
      try { secret = typeof value === 'string' ? hasSecret(value) : hasSecret(String(value)); } catch (_) { secret = true; }
      store.set(key, { value, expires: Date.now() + ttlMs, tokens: estTokens(value), secret });
      markDirty();
    }
    return value;
  };
}

function toolStats() {
  const total = stats.hits + stats.misses;
  return {
    hits: stats.hits,
    misses: stats.misses,
    hitRate: total ? Math.round((stats.hits / total) * 1000) / 1000 : 0,
    callsAvoided: stats.callsAvoided,
    tokensSaved: stats.tokensSaved,
    entries: store.size,
    byTool: stats.byTool,
    persisted: PERSIST_ENABLED,
    persistFile: PERSIST_ENABLED ? PERSIST_FILE : null
  };
}

function clearToolCache() {
  store.clear(); stats.hits = 0; stats.misses = 0; stats.callsAvoided = 0; stats.tokensSaved = 0; stats.byTool = {};
  if (PERSIST_ENABLED) { try { ensureDir(); fs.writeFileSync(PERSIST_FILE, JSON.stringify({ version: 1, stats: { hits: 0, misses: 0, callsAvoided: 0, tokensSaved: 0, byTool: {} }, entries: {} })); } catch (_) {} }
}

// hydrate from disk AFTER the store/stats declarations, then arm the exit flush
loadOnce();
process.on('exit', () => { try { _flushTimer && clearTimeout(_flushTimer); flush(true); } catch (_) {} });

module.exports = { wrap, toolStats, clearToolCache, pickTtl, keyFor, isMutating, flush };
