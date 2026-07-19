'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   compute-ops.js — extended deterministic COMPUTE ops for AURA.

   Each op recognizes a recurring prompt SHAPE and answers any instance for
   free, forever, with no LLM call — the "compile once → run free" idea, widened
   to the questions developers and designers actually ask a model all day:
   base conversion, hashing, url/rot13 encoding, char counts, text casing, and
   hex↔rgb color math.

   Contract: computeExtra(prompt) → string answer, or null to pass through.
   Zero dependencies (node:crypto + Buffer only). Payload casing is preserved
   for ops where it matters (hash input, url, rot13, text-case).
   ══════════════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');

// Strip conversational filler so "convert 255 to hex" / "what's the sha256 of x"
// hit the same shapes as their bare forms. Only leading filler is removed.
function strip(raw) {
  return String(raw || '')
    .replace(/^\s*(?:can you |please |hey,? )?/i, '')
    .replace(/^\s*(?:what(?:'s| is)|calculate|compute|give me|convert)\s+/i, '')
    .replace(/^\s*the\s+/i, '')
    .trim();
}

// ── number-base conversion ───────────────────────────────────────────────────
const BASE_ALIAS = { hex: 16, hexadecimal: 16, bin: 2, binary: 2, oct: 8, octal: 8, dec: 10, decimal: 10, base10: 10 };
const BASE_PREFIX = { 16: '0x', 2: '0b', 8: '0o', 10: '' };
function parseIntAny(tok) {
  const t = String(tok).trim().toLowerCase();
  let m;
  if ((m = /^0x([0-9a-f]+)$/.exec(t))) return parseInt(m[1], 16);
  if ((m = /^0b([01]+)$/.exec(t))) return parseInt(m[1], 2);
  if ((m = /^0o([0-7]+)$/.exec(t))) return parseInt(m[1], 8);
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  return null;
}
function numberBase(raw) {
  const s = strip(raw);
  // "hex of 255" | "binary of 10"
  let m = /^(hex(?:adecimal)?|bin(?:ary)?|oct(?:al)?|dec(?:imal)?|base10)\s+of\s+(\S+)\s*\??$/i.exec(s);
  let target, src;
  if (m) { target = BASE_ALIAS[m[1].toLowerCase()]; src = m[2]; }
  else {
    // "255 to hex" | "0xff in decimal" | "10 as binary"
    m = /^(\S+)\s+(?:to|in|into|as)\s+(hex(?:adecimal)?|bin(?:ary)?|oct(?:al)?|dec(?:imal)?|base10)\s*\??$/i.exec(s);
    if (!m) return null;
    src = m[1]; target = BASE_ALIAS[m[2].toLowerCase()];
  }
  const n = parseIntAny(src);
  if (n === null || target === undefined) return null;
  const body = (n < 0 ? '-' : '') + Math.abs(n).toString(target);
  return BASE_PREFIX[target] + body;
}

// ── character count ──────────────────────────────────────────────────────────
function charCount(raw) {
  const s = strip(raw);
  let m = /^(?:character|char|letter)\s+count(?:\s+of)?\s*:?\s*(.+)/i.exec(s);
  if (!m) m = /^how many (?:characters|chars|letters)(?:\s+are)?(?:\s+in)?\s*:?\s*(.+)/i.exec(s);
  if (!m) return null;
  const txt = m[1].replace(/^["']|["']$/g, '');
  if (!txt) return null;
  return String(Array.from(txt).length);
}

// ── url encode / decode ──────────────────────────────────────────────────────
function urlCode(raw) {
  const s = strip(raw);
  let m = /^url[\s-]?encode\s+(.+)/i.exec(s);
  if (m) { try { return encodeURIComponent(m[1].trim()); } catch (_) { return null; } }
  m = /^url[\s-]?decode\s+(.+)/i.exec(s);
  if (m) { try { return decodeURIComponent(m[1].trim()); } catch (_) { return null; } }
  return null;
}

// ── hashing ──────────────────────────────────────────────────────────────────
function hashOp(raw) {
  const s = strip(raw);
  const m = /^(md5|sha1|sha256|sha512)\s+(?:of\s+|hash\s+(?:of\s+)?)?(.+)/i.exec(s);
  if (!m) return null;
  const algo = m[1].toLowerCase();
  const payload = m[2].trim().replace(/^["']|["']$/g, '');
  if (!payload) return null;
  try { return crypto.createHash(algo).update(payload, 'utf8').digest('hex'); } catch (_) { return null; }
}

// ── rot13 ────────────────────────────────────────────────────────────────────
function rot13(raw) {
  const s = strip(raw);
  const m = /^rot13\s*:?\s*(.+)/i.exec(s);
  if (!m) return null;
  return m[1].trim().replace(/[a-z]/gi, (c) => {
    const base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

// ── text case / slug ─────────────────────────────────────────────────────────
function textCase(raw) {
  const s = strip(raw);
  const m = /^(title\s?case|capitali[sz]e|slugify|slug)\s*:?\s*(.+)/i.exec(s);
  if (!m) return null;
  const op = m[1].toLowerCase().replace(/\s/g, '');
  const txt = m[2].trim().replace(/^["']|["']$/g, '');
  if (!txt) return null;
  if (op === 'titlecase') return txt.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\B\w/g, (c) => c.toLowerCase());
  if (op === 'capitalize') return txt.charAt(0).toUpperCase() + txt.slice(1);
  // slugify / slug
  return txt.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

// ── hex ↔ rgb ────────────────────────────────────────────────────────────────
function hexColor(raw) {
  const s = strip(raw).toLowerCase();
  // hex → rgb : "#ff8800 to rgb" | "hex #f80 to rgb"
  let m = /(?:hex\s+)?#?([0-9a-f]{3}|[0-9a-f]{6})\s+(?:to|in|into|as)\s+rgb/i.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return `rgb(${r}, ${g}, ${b})`;
  }
  // rgb → hex : "rgb(255,136,0) to hex" | "rgb 255 136 0 to hex"
  m = /rgb\s*\(?\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*\)?\s+(?:to|in|into|as)\s+hex/i.exec(s);
  if (m) {
    const nums = [m[1], m[2], m[3]].map(Number);
    if (nums.some((n) => n < 0 || n > 255)) return null;
    return '#' + nums.map((n) => n.toString(16).padStart(2, '0')).join('');
  }
  return null;
}

// Ordered so the most specific shapes win. Each returns string|null.
const OPS = [numberBase, charCount, urlCode, hashOp, rot13, textCase, hexColor];

function computeExtra(prompt) {
  const raw = String(prompt || '').trim();
  if (!raw) return null;
  for (const op of OPS) {
    try { const r = op(raw); if (r !== null && r !== undefined && r !== '') return r; } catch (_) {}
  }
  return null;
}

module.exports = { computeExtra, numberBase, charCount, urlCode, hashOp, rot13, textCase, hexColor };
