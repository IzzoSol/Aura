'use strict';
/**
 * context-compress — shrink a conversation before it's re-sent to the model.
 *
 * Every turn of an agent chat re-sends the ENTIRE history. As it grows — especially
 * the big tool outputs (file reads, command dumps, search results) — each turn costs
 * more, forever. This trims the history deterministically while keeping the
 * conversation coherent, so the savings compound on every single call.
 *
 * What it protects (NEVER altered):
 *   - system messages (the instructions)
 *   - the first user message (the task)
 *   - the last `keepRecent` messages (the live working context)
 *
 * What it compresses (older, unpinned messages only):
 *   - DEDUP  — an identical OR near-identical large block that appears again later is replaced
 *              by a marker (the latest full copy is kept, so nothing current is lost). Near-dedup
 *              catches the "read file → edit → read file again" re-read drain that exact-hash misses.
 *   - TRUNCATE — a big old tool output is reduced to head + tail with an elision marker
 *   - DROP   — only if a hard `maxTokens` budget is set and still exceeded, the oldest
 *              non-pinned messages are collapsed into a single "[N older messages elided]"
 *
 * Zero-dependency, deterministic (no LLM, no randomness), and transparent — every cut
 * leaves a visible marker. Token counts use the same ~1-token/4-char estimate as the
 * rest of AURA. It's lossy by nature; the guarantees are that it never touches the
 * instructions, the task, or the recent turns, and always tells you what it elided.
 */

const crypto = require('crypto');

const estTokens = (s) => Math.max(1, Math.ceil(String(s == null ? '' : s).length / 4));

// Flatten a message's content to a string for measuring/compressing. Handles a plain
// string or an array of blocks (text kept, non-text summarized as [type]).
function contentString(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b.text === 'string') ? b.text : (b && b.type ? `[${b.type}]` : '')).join('\n');
  }
  if (content == null) return '';
  try { return JSON.stringify(content); } catch (_) { return String(content); }
}

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Line-set signature for NEAR-duplicate detection: the set of distinct non-blank,
// whitespace-normalized lines. A file re-read that changed a line or two shares almost
// all of its lines with the newer copy, so their signatures overlap heavily.
function lineSig(text) {
  const set = new Set();
  for (const raw of String(text).split(/\r?\n/)) {
    const t = raw.trim().replace(/\s+/g, ' ');
    if (t) set.add(t);
  }
  return set;
}
// Jaccard over two line-sets: |A ∩ B| / |A ∪ B|.
function jaccardSig(a, b) {
  if (!a.size && !b.size) return 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let inter = 0; for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// Collapse runs of ≥minRun identical consecutive lines into one copy + a count marker
// (log spam, retries, progress noise). Lossless in meaning — you keep the line and the count.
// Runs of blank lines are collapsed to a single blank. Applied BEFORE truncation so a mostly-
// repeated block can survive whole instead of being blindly head/tail cut.
function collapseRepeatLines(text, minRun) {
  const lines = String(text).split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const run = j - i;
    if (run >= minRun && lines[i].trim()) { out.push(lines[i]); out.push(`…[AURA: line above repeated ${run}× ]…`); }
    else if (run >= minRun && !lines[i].trim()) { out.push(''); }
    else { for (let k = i; k < j; k++) out.push(lines[k]); }
    i = j;
  }
  return out.join('\n');
}

function truncateMiddle(text, headChars, tailChars) {
  const elided = text.length - headChars - tailChars;
  return text.slice(0, headChars) + `\n…[AURA elided ${elided} chars]…\n` + text.slice(text.length - tailChars);
}

/**
 * compress(messages, opts) -> { messages, stats }
 *   messages : [{ role, content }]
 *   opts.keepRecent   (6)     messages at the end kept fully intact
 *   opts.truncateOver (1000)  chars above which an old tool output is truncated
 *   opts.headChars    (400)   kept from the start of a truncated block
 *   opts.tailChars    (200)   kept from the end of a truncated block
 *   opts.dedupOver    (200)   min chars for a repeated block to be de-duplicated
 *   opts.maxTokens    (off)   hard budget; if set, oldest non-pinned msgs are dropped to fit
 *   opts.collapseRepeats (true) collapse runs of ≥collapseMin identical lines before truncating
 *   opts.collapseMin  (3)     min run length to collapse
 */
function compress(messages, opts = {}) {
  const msgs = Array.isArray(messages) ? messages.map((m) => ({ ...m })) : [];
  const n = msgs.length;
  const keepRecent = Number.isInteger(opts.keepRecent) ? opts.keepRecent : 6;
  const truncateOver = Number(opts.truncateOver) > 0 ? Number(opts.truncateOver) : 1000;
  const collapseRepeats = opts.collapseRepeats !== false;
  const collapseMin = Number.isInteger(opts.collapseMin) && opts.collapseMin >= 2 ? opts.collapseMin : 3;
  const headChars = Number(opts.headChars) > 0 ? Number(opts.headChars) : 400;
  const tailChars = Number(opts.tailChars) > 0 ? Number(opts.tailChars) : 200;
  const dedupOver = Number(opts.dedupOver) > 0 ? Number(opts.dedupOver) : 200;

  const tokensBefore = msgs.reduce((s, m) => s + estTokens(contentString(m.content)), 0);

  // --- pin the untouchables: system, the first user (task), and the last keepRecent ---
  const pinned = new Set();
  msgs.forEach((m, i) => { if (m.role === 'system') pinned.add(i); });
  const firstUser = msgs.findIndex((m) => m.role === 'user');
  if (firstUser >= 0) pinned.add(firstUser);
  for (let i = Math.max(0, n - keepRecent); i < n; i++) pinned.add(i);

  // --- dedup index: last position + occurrence count for each large block ---
  const lastIndexByHash = new Map();
  const countByHash = new Map();
  msgs.forEach((m, i) => {
    const c = contentString(m.content);
    if (c.length >= dedupOver) {
      const h = hash(c);
      lastIndexByHash.set(h, i);
      countByHash.set(h, (countByHash.get(h) || 0) + 1);
    }
  });
  // "keepers" = the surviving full copy of a block that repeats. They are exempt from
  // truncation so at least one full copy of any repeated block always survives.
  const keepers = new Set();
  for (const [h, idx] of lastIndexByHash) if ((countByHash.get(h) || 0) > 1) keepers.add(idx);

  // --- near-dedup: an older large block that is ≥nearDedupSim similar (by line-set) to a
  //     LATER large block is a stale re-read — elide the older copy, keep the newer full one.
  //     Exact copies are handled above; this catches "read file → edit → read file again".
  const nearDedup = opts.nearDedup !== false;
  const nearSim = Number(opts.nearDedupSim) > 0 ? Number(opts.nearDedupSim) : 0.9;
  const NEAR_MIN_LINES = 5; // too few lines → Jaccard is unstable, so don't risk it
  const nearElide = new Map(); // earlier index -> { j: surviving later index, s: similarity }
  if (nearDedup) {
    const bigs = [];
    msgs.forEach((m, i) => {
      const c = contentString(m.content);
      if (c.length >= dedupOver) { const sig = lineSig(c); if (sig.size >= NEAR_MIN_LINES) bigs.push({ i, h: hash(c), sig, len: c.length }); }
    });
    for (const a of bigs) {
      if (pinned.has(a.i)) continue;
      const exactLater = lastIndexByHash.get(a.h);
      if (exactLater !== undefined && exactLater > a.i) continue; // exact path already elides it
      let best = null;
      for (const b of bigs) {
        if (b.i <= a.i || b.h === a.h) continue;
        const s = jaccardSig(a.sig, b.sig);
        if (s >= nearSim && (!best || s > best.s || (s === best.s && b.i > best.j))) best = { j: b.i, s };
      }
      if (best) { nearElide.set(a.i, best); keepers.add(best.j); } // survivor exempt from truncation
    }
  }

  let elided = 0;
  msgs.forEach((m, i) => {
    if (pinned.has(i)) return;
    const c = contentString(m.content);
    // dedup: an identical large block reappears later -> elide this earlier copy
    if (c.length >= dedupOver) {
      const last = lastIndexByHash.get(hash(c));
      if (last !== undefined && last > i) {
        m.content = `[AURA: identical to a later message, elided (~${estTokens(c)} tokens)]`;
        elided++;
        return;
      }
      // near-identical to a later copy (stale re-read) -> elide the older one
      const near = nearElide.get(i);
      if (near) {
        m.content = `[AURA: ~${Math.round(near.s * 100)}% identical to a later message, elided (~${estTokens(c)} tokens)]`;
        elided++;
        return;
      }
    }
    // big old block: first collapse repeated-line runs (log spam etc.); if that alone brings
    // it under the truncation threshold, keep it whole — otherwise head/tail truncate the
    // collapsed text (never the surviving dedup copy).
    if (c.length > truncateOver && !keepers.has(i)) {
      const cc = collapseRepeats ? collapseRepeatLines(c, collapseMin) : c;
      if (cc.length <= truncateOver) { if (cc !== c) { m.content = cc; elided++; } }
      else { m.content = truncateMiddle(cc, headChars, tailChars); elided++; }
    }
  });

  // --- optional hard budget: drop oldest non-pinned messages until under maxTokens ---
  let dropped = 0;
  if (Number(opts.maxTokens) > 0) {
    let current = msgs.reduce((s, m) => s + estTokens(contentString(m.content)), 0);
    for (let i = 0; i < n && current > opts.maxTokens; i++) {
      if (pinned.has(i) || msgs[i]._drop) continue;
      current -= estTokens(contentString(msgs[i].content));
      msgs[i]._drop = true;
      dropped++;
    }
  }

  // --- rebuild, collapsing runs of dropped messages into one marker ---
  const out = [];
  let run = 0;
  const flush = () => { if (run > 0) { out.push({ role: 'system', content: `[AURA: ${run} older message(s) elided to save context]` }); run = 0; } };
  for (const m of msgs) {
    if (m._drop) { run++; continue; }
    flush();
    delete m._drop;
    out.push(m);
  }
  flush();

  const tokensAfter = out.reduce((s, m) => s + estTokens(contentString(m.content)), 0);
  const saved = tokensBefore - tokensAfter;
  return {
    messages: out,
    stats: {
      tokensBefore, tokensAfter, saved,
      savedPct: tokensBefore ? Math.round((saved / tokensBefore) * 1000) / 10 : 0,
      elided, dropped
    }
  };
}

module.exports = { compress, estTokens, contentString };
