'use strict';
/**
 * prompt-distill — AURA's 3rd pillar. Trim redundant instructions from a prompt /
 * system prompt (OpenAI's GPT-5.6 guidance: leaner prompts score higher AND cost less —
 * ~10-15% better evals, 41-66% fewer tokens), while NEVER removing the load-bearing parts.
 *
 * A system prompt is paid for on EVERY call, forever. Cut it once and the savings compound.
 *
 * TRIM (only provable redundancy, on the free path): exact-duplicate rules, near-duplicate
 * rules (same rule reworded), and leading filler. FLAG (never cut): possibly-dead examples
 * and stylistic instructions the model already follows.
 *
 * KEEP — protected, never removed: safety/permission/business constraints, success/stopping
 * criteria, required output shape/validation, context-dependent tool routing, AND
 * behavior-envelope process rules (tool budgets, uncertainty policy, stop/escalation/
 * fallback) which LOOK like process but bound behavior. Protection is by section STRUCTURE
 * and keyword. Deterministic + zero-dependency on the free path; an optional --llm pass does
 * the semantic rewrite, accepted only if every protected unit survives.
 */

const crypto = require('crypto');

const estTokens = (s) => Math.max(1, Math.ceil(String(s == null ? '' : s).length / 4));

const STOP = new Set(('a an the of to in on for and or but with as at by is are be been do does you your yours it its this that these those we our us i me my mine they them their he she his her not no if when then than into over under only most more less can could should would may might will shall'
).split(' '));

function normalize(s) {
  return String(s == null ? '' : s).toLowerCase()
    .replace(/[`*_#>~]/g, ' ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function salient(s) { return normalize(s).split(' ').filter((w) => w && !STOP.has(w) && w.length > 1); }
function idOf(s) { return crypto.createHash('sha1').update(salient(s).slice(0, 12).join(' ')).digest('hex').slice(0, 12); }

// token-SET Jaccard: lenient enough to catch a reworded rule, strict enough that two
// genuinely different rules score low.
function jaccard(a, b) {
  const A = new Set(salient(a)), B = new Set(salient(b));
  if (!A.size && !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
function overlap(a, b) { const B = new Set(b); let n = 0; for (const x of new Set(a)) if (B.has(x)) n++; return n; }
function firstLine(s) { return String(s).split('\n').find((l) => l.trim()) || String(s); }

// --- KEEP signals (protect the load-bearing parts) ---
const KEEP = {
  safety:  /\b(never|must not|must never|do not|don't|shall not|require[sd]?|approval|authoriz|permission|pii|secret|credential|complian(?:t|ce)|confirm|forbid|prohibit|not allowed)\b/i,
  output:  /\b(return|output|respond with|format|json|yaml|xml|schema|must match|the shape|fields?|columns?|validate)\b/i,
  success: /\b(success criteria|done when|stop when|complete when|until (?:you|the|it|all)|acceptance|definition of done)\b/i,
  routing: /\b(?:if|when)\b[^.?!]*\b(?:use|call|route|prefer|choose|select)\b|\botherwise\b/i,
  envelope:/\b(no more than|at most|up to \d|budget|token limit|if (?:you are )?(?:unsure|uncertain|not sure)|ask (?:one|a|for) clarif|clarifying question|mark (?:it )?uncertain|state[^.?!]*unknown|do not continue|then act|escalate|defer to|hand off|do(?:n't| not) fabricate|do(?:n't| not) (?:make up|invent)|if no source|say so|cite)\b/i,
};
const KEEP_HEADING = /\b(constraint|safety|rule|guard ?rail|permission|success|criteria|acceptance|output|schema|validation|format|stop|do not|must|policy|security|require)/i;
const STYLISTIC = [
  /^\s*(?:[-*+]|\d+[.)])?\s*be concise\b/i, /\buse proper grammar\b/i, /^\s*(?:[-*+]|\d+[.)])?\s*be helpful\b/i,
  /\buse markdown\b/i, /^\s*(?:[-*+]|\d+[.)])?\s*be (?:polite|professional|friendly)\b/i,
  /\bthink step by step\b/i, /\btake your time\b/i,
];

function keepCategory(text) {
  for (const k of ['safety', 'output', 'success', 'routing', 'envelope']) if (KEEP[k].test(text)) return k;
  return null;
}

// Whole-line politeness: a unit whose EVERY salient word is a courtesy word ("Thank you.",
// "Cheers.", "Much appreciated.") carries zero behavioral content. Requiring ALL words to be
// polite (and the unit to be short) means a real rule that merely uses a polite word — "Thank
// the user by name" — is never touched.
const POLITE = new Set(['thank', 'thanks', 'thankyou', 'appreciate', 'appreciated', 'cheers', 'welcome', 'pleasure', 'regards', 'kindly', 'gratitude', 'much', 'best']);
function isPolite(text) { const s = salient(text); return s.length > 0 && s.length <= 6 && s.every((w) => POLITE.has(w)); }

// --- segmentation ---
const FENCE = /^\s*```/;
const HEADING = /^\s*#{1,6}\s+\S/;
const XMLTAG = /^\s*<\/?[a-z][\w-]*\s*>\s*$/i;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+\S/;

function isHeadingLine(line) { return HEADING.test(line) || XMLTAG.test(line); }
function headingTitle(line) { return line.replace(/^[\s#]+/, '').replace(/^<\/?/, '').replace(/>\s*$/, '').trim(); }

// Split a plain prose line into sentences so intra-line duplicate rules are caught. The
// lookahead requires whitespace/end after the terminator, so decimals ("2.5") don't split.
function splitSentences(line) {
  const parts = line.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g);
  const out = (parts || [line]).map((s) => s.trim()).filter(Boolean);
  return out.length ? out : [line.trim()];
}

function segment(prompt) {
  const lines = String(prompt == null ? '' : prompt).split(/\r?\n/);
  const units = [];
  let section = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (FENCE.test(line)) {
      const buf = [line]; i++;
      while (i < lines.length && !FENCE.test(lines[i])) { buf.push(lines[i]); i++; }
      if (i < lines.length) { buf.push(lines[i]); i++; }
      units.push({ kind: 'code', text: buf.join('\n'), section });
      continue;
    }
    if (line.trim() === '') { units.push({ kind: 'blank', text: '', section }); i++; continue; }
    if (isHeadingLine(line)) { section = headingTitle(line); units.push({ kind: 'heading', text: line, section }); i++; continue; }
    if (BULLET.test(line)) { units.push({ kind: 'bullet', text: line, section }); i++; continue; }
    // plain prose: split into per-sentence units so repeated rules on one line are caught
    splitSentences(line).forEach((sent) => units.push({ kind: 'text', text: sent, section }));
    i++;
  }
  return units;
}

/**
 * distill(prompt, opts) -> { distilled, report }
 *   opts.similarity (0.82)  near-duplicate token-set Jaccard threshold
 *   opts.trimFiller (true)  strip leading hedge/filler prefixes
 */
function distill(prompt, opts = {}) {
  const similarity = Number(opts.similarity) > 0 ? Number(opts.similarity) : 0.82;
  const trimFiller = opts.trimFiller !== false;
  const src = String(prompt == null ? '' : prompt);
  const tokensBefore = estTokens(src);
  const units = segment(src);

  const removed = [], flagged = [], protectedUnits = [];

  // --- 1. mark protection ---
  units.forEach((u) => {
    if (u.kind === 'blank') return;
    u.protectedBy = null;
    if (u.kind === 'heading') { u.protectedBy = 'heading'; return; }
    if (u.section && KEEP_HEADING.test(u.section)) u.protectedBy = 'section:' + u.section;
    if (!u.protectedBy) { const cat = keepCategory(u.text); if (cat) u.protectedBy = cat; }
    if (u.protectedBy && u.kind !== 'code') protectedUnits.push({ text: u.text.trim(), category: u.protectedBy });
  });

  // --- 2. exact + near-duplicate removal among UNPROTECTED content (keep first/longest) ---
  const contentUnits = units.filter((u) => (u.kind === 'text' || u.kind === 'bullet') && !u.protectedBy);
  const kept = [];
  contentUnits.forEach((u) => {
    const norm = normalize(u.text);
    if (!norm) return;
    const exact = kept.find((k) => k.norm === norm);
    if (exact) { u.remove = true; removed.push({ text: u.text.trim(), reason: 'exact-duplicate' }); return; }
    const near = kept.find((k) => salient(k.text).length >= 2 && jaccard(k.text, u.text) >= similarity);
    if (near) {
      const sim = jaccard(near.text, u.text).toFixed(2);
      if (u.text.trim().length > near.text.trim().length) {
        near.unit.remove = true;
        removed.push({ text: near.text.trim(), reason: 'near-duplicate:' + sim });
        near.text = u.text; near.norm = norm; near.unit = u;
      } else {
        u.remove = true;
        removed.push({ text: u.text.trim(), reason: 'near-duplicate:' + sim });
      }
      return;
    }
    kept.push({ norm, text: u.text, unit: u });
  });

  // --- 2b. whole-line politeness removal (unprotected units with no behavioral content) ---
  units.forEach((u) => {
    if (u.remove || u.protectedBy) return;
    if ((u.kind === 'text' || u.kind === 'bullet') && isPolite(u.text)) {
      u.remove = true;
      removed.push({ text: u.text.trim(), reason: 'politeness' });
    }
  });

  // --- 3. leading-filler trim (keeps the rule, drops the hedge) ---
  if (trimFiller) {
    const FILLER = /^(\s*(?:[-*+]|\d+[.)])\s+)?(?:please note that|it is important to (?:note|remember) that|it'?s important to|it is worth noting that|as (?:mentioned|noted) (?:above|earlier|before),?|remember to|make sure(?: that you| to)?|be sure to|note that|keep in mind that|bear in mind that|i(?:'d| would)? (?:want|like|need)(?: you)? to|i want you to|your (?:task|job|goal) is to|you (?:should|must|need to|are (?:expected|required) to)|kindly|please)\s+/i;
    units.forEach((u) => {
      if (u.remove || u.protectedBy) return;
      if (u.kind !== 'text' && u.kind !== 'bullet') return;
      if (FILLER.test(u.text)) {
        const before = u.text;
        u.text = u.text.replace(FILLER, (m, bullet) => bullet || '')
          .replace(/^(\s*(?:[-*+]|\d+[.)])\s+)?([a-z])/, (m, b, c) => (b || '') + c.toUpperCase());
        if (u.text !== before) removed.push({ text: before.trim(), reason: 'filler-trimmed' });
      }
    });
  }

  // --- 4. flag (never cut) ---
  units.forEach((u) => {
    if (u.remove) return;
    if (u.kind === 'code') {
      const kw = salient(u.text);
      if (kw.length) {
        const hasRule = units.some((o) => o !== u && !o.remove && o.kind !== 'code' && o.kind !== 'blank' && overlap(kw, salient(o.text)) >= 3);
        if (hasRule) flagged.push({ text: firstLine(u.text), reason: 'example duplicates an explicit rule', category: 'possible-dead-example' });
      }
      return;
    }
    if ((u.kind === 'text' || u.kind === 'bullet') && !u.protectedBy && STYLISTIC.some((re) => re.test(u.text))) {
      flagged.push({ text: u.text.trim(), reason: 'model performs this reliably without instruction', category: 'model-likely-reliable' });
    }
  });

  // --- 5. reconstruct (invariant: headings/order preserved, only whole units dropped) ---
  const outLines = [];
  units.forEach((u) => { if (u.remove) return; outLines.push(u.kind === 'blank' ? '' : u.text); });
  let distilled = outLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  distilled = distilled ? distilled + '\n' : src;

  const tokensAfter = estTokens(distilled);
  const saved = Math.max(0, tokensBefore - tokensAfter);
  const unitsIn = units.filter((u) => u.kind === 'text' || u.kind === 'bullet').length;
  const unitsOut = units.filter((u) => !u.remove && (u.kind === 'text' || u.kind === 'bullet')).length;

  return {
    distilled,
    report: {
      removed, flagged, protected: protectedUnits,
      stats: {
        tokensBefore, tokensAfter, saved,
        savedPct: tokensBefore ? Math.round((saved / tokensBefore) * 1000) / 10 : 0,
        unitsIn, unitsOut,
      },
    },
  };
}

/**
 * applyLLM(pass1, callModel, opts) -> { distilled, report }  (async)
 * Pass 2 — advisory. callModel(prompt) => string. The rewrite is ACCEPTED only if every
 * protected unit from pass 1 survives (by identity, not exact words); otherwise pass-1 output
 * is returned with a rejection note. The model can never silently drop a safety/output rule.
 */
async function applyLLM(pass1, callModel, opts = {}) {
  const rubric =
    'Trim: repeated statements of the same rule; repeated style/process instructions that do not change behavior; ' +
    'examples that do not change behavior; process instructions for behavior the model already performs reliably; ' +
    'tool descriptions unrelated to the task. Keep: the user-visible outcome; success criteria and stopping conditions; ' +
    'safety, business, evidence, and permission constraints; tool-routing rules when the route depends on context; ' +
    'required output shape and validation. Return ONLY the leaner prompt text — no commentary, no code fences.';
  const flags = (pass1.report.flagged || []).map((f) => `- (${f.category}) ${f.text}`).join('\n') || '(none)';
  const meta =
    `You are a prompt distiller. Apply this rubric to the prompt.\n\nRUBRIC:\n${rubric}\n\n` +
    `FLAGGED CANDIDATES (resolve; cut only if they truly do not change behavior):\n${flags}\n\n` +
    `PROMPT:\n"""\n${pass1.distilled}\n"""`;

  let out;
  try { out = await callModel(meta); }
  catch (e) { return { distilled: pass1.distilled, report: Object.assign({}, pass1.report, { llm: { accepted: false, error: String((e && e.message) || e) } }) }; }
  out = String(out == null ? '' : out).trim().replace(/^```[\w]*\n?|\n?```$/g, '').trim();
  if (!out) return { distilled: pass1.distilled, report: Object.assign({}, pass1.report, { llm: { accepted: false, error: 'empty output' } }) };

  const outUnits = segment(out).filter((u) => u.kind === 'text' || u.kind === 'bullet' || u.kind === 'heading');
  const dropped = [];
  (pass1.report.protected || []).forEach((p) => {
    const key = normalize(p.text).slice(0, 40);
    const survived = outUnits.some((o) => normalize(o.text).includes(key) || jaccard(o.text, p.text) >= 0.6);
    if (!survived) dropped.push({ id: idOf(p.text), text: p.text, category: p.category });
  });
  if (dropped.length) {
    return { distilled: pass1.distilled, report: Object.assign({}, pass1.report, { llm: { accepted: false, reason: 'protected units dropped', dropped } }) };
  }

  const tokensAfter = estTokens(out);
  const before = pass1.report.stats.tokensBefore;
  return {
    distilled: out,
    report: Object.assign({}, pass1.report, {
      llm: { accepted: true },
      stats: Object.assign({}, pass1.report.stats, {
        tokensAfter, saved: Math.max(0, before - tokensAfter),
        savedPct: before ? Math.round(((before - tokensAfter) / before) * 1000) / 10 : 0,
      }),
    }),
  };
}

module.exports = { distill, applyLLM, estTokens, segment, normalize, jaccard };
