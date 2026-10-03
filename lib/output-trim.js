'use strict';
/**
 * output-trim — shape a tool/command output BEFORE it enters the model's context.
 *
 * Agents burn most of their window not on prose but on TOOL RESULTS: 40k-token npm
 * installs, 1000-line test runs, diff floods, retry-log spam. AURA's other surfaces
 * optimize what you SEND (tools / instructions / history); this one shrinks what tools
 * GIVE BACK — deterministically, no LLM, never throwing.
 *
 * Pipeline (stolen from the best of the token-saver repos):
 *   1. ANSI-escape strip + blank-line collapse + consecutive-identical-line collapse
 *   2. FAMILY filter — known-noisy command families get format-aware keeps:
 *      install/build -> tail, test runners -> result lines only, lint -> errors+summary
 *   3. ASYMMETRIC budget (generic fallback) — success keeps the last ~5 lines,
 *      failure keeps the last ~50 (errors live at the tail)
 *   4. CRITICAL-LINE RECOVERY — after trimming, any error-shaped line that existed in
 *      the original but vanished from the result is re-appended (capped) under a
 *      marker. Compression can never silently eat the one line that mattered.
 *   5. RATIO GATE — if all that didn't actually shrink the text, return the original.
 *
 * Zero-dependency, pure, never mutates the input, never throws.
 */

// ------------------------------------------------------------------ helpers
const CHARS_PER_TOK = 4;
const estTokens = (s) => Math.max(1, Math.ceil(String(s || '').length / CHARS_PER_TOK));

function stripAnsi(s) {
  return String(s || '')
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')   // CSI sequences (colors, cursor moves)
    .replace(/\x1b\][^\x07]*\x07/g, '');      // OSC sequences (window titles)
}

// Error-shaped lines — the ones a compressor must NEVER silently drop.
// Two tiers so case-folding noise doesn't flood the recovery cap:
//   tier 1 (case-insensitive): explicit failure vocabulary
//   tier 2 (case-sensitive): errno/signal-style tokens — `EACCES`, `SIGSEGV` —
//     deliberately NOT /i, or "Extracting"/"Entry" match `E[A-Z]{3,}` and push real
//     errors out of the recovery cap.
const CRIT_CI = /\b(error|failed|failure|fatal|panic|panicked|exception|traceback|assertion|denied|refused|timeout|timed out|killed)\b|^fail(ed)?\b|^err(or)?\b|\[(?:error|fatal|critical)\]|\b[a-z]+error\b|\b[a-z]+exception\b/i;
const CRIT_CS = /\bE[A-Z]{3,}\b|\bSIG[A-Z]{3,}\b/;
// Zero/negated error mentions ("0 errors", "no failures", "errors: 0") are SUCCESS
// summaries — treating them as critical would misinfer failure and flood recovery.
const CRIT_NEGATE = /\b(?:no|zero|0)\s+(?:errors?|failures?|fails?|problems?)\b|errors?\s*[:=]\s*0\b|\b0\s+(?:errors?|failures?|problems?)\b/i;

function isCriticalLine(line) {
  const t = String(line || '').trim();
  if (!t) return false;
  if (CRIT_NEGATE.test(t)) return false;
  return CRIT_CI.test(t) || CRIT_CS.test(t);
}

// Does a trimmed result still "contain" an original line? Processors legitimately
// re-indent/prefix/merge, so containment is SUBSTRING-based, not equality.
function lineMissing(originalLines, resultLines, line) {
  const needle = line.trim();
  if (!needle) return false;
  for (const r of resultLines) if (r.includes(needle)) return false;
  // second pass: whitespace-normalized containment for re-wrapped lines
  const flat = needle.replace(/\s+/g, ' ');
  for (const r of resultLines) if (r.replace(/\s+/g, ' ').includes(flat)) return false;
  return true;
}

// ------------------------------------------------------------------ family table
// Known-noisy command families. `match` runs against the normalized command/tool
// name; `keep` picks the strategy. Everything else falls through to the generic
// asymmetric tail budget.
const MAX_FAMILY_KEEP = 80;   // hard cap on lines a family filter may keep

const FAMILIES = [
  {
    name: 'package-install',
    match: /\b(npm|pnpm|yarn|bun)\s+(install|i|add)\b/,
    keep: 'tail', lines: 20,
    note: 'install logs: peer-dep noise; only the tail matters (added N packages, vulnerabilities)'
  },
  {
    name: 'build',
    match: /\b(cargo\s+build|make|webpack|vite\s+build|next\s+build|tsc)\b/,
    keep: 'tail', lines: 20,
    note: 'build logs: success is the last lines, failures are the tail'
  },
  {
    name: 'test-runner',
    match: /\b(pytest|jest|vitest|mocha|go\s+test|rspec|dotnet\s+test)\b/,
    keep: 'test-results',
    note: 'test runs: keep pass/fail/error result lines + summaries, drop the per-test noise'
  },
  {
    name: 'lint',
    match: /\b(eslint|ruff|flake8|pylint|mypy|clippy)\b/,
    keep: 'errors',
    note: 'lint: keep error/warning lines + the summary count'
  },
  {
    name: 'git-diff',
    match: /\bgit\s+diff\b/,
    keep: 'diff',
    note: 'unified diff: keep file/hunk headers and +/- changes; collapse context runs'
  },
  {
    name: 'git-log',
    match: /\bgit\s+log\b/,
    keep: 'tail', lines: 12,
    note: 'log: newest commits live at the head; cap to a tail slice of short entries'
  },
  {
    name: 'git-progress',
    match: /\bgit\s+(push|pull|fetch|clone)\b/,
    keep: 'progress',
    note: 'remote git: progress meter is pure noise; keep status + diagnostics'
  }
];

function matchFamily(name) {
  const n = String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!n) return null;
  for (const f of FAMILIES) if (f.match.test(n)) return f;
  return null;
}

// ------------------------------------------------------------------ keep strategies
// collapse runs of >=3 identical consecutive lines to one + count marker
function collapseIdentical(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[i]) j++;
    const run = j - i + 1;
    out.push(lines[i]);
    if (run >= 3) out.push(`... [AURA: line above repeated ${run - 1} more time(s)] ...`);
    i = j + 1;
  }
  return out;
}

function collapseBlank(lines) {
  const out = [];
  let blanked = false;
  for (const l of lines) {
    if (l.trim() === '') {
      if (!blanked) out.push('');
      blanked = true;
    } else { out.push(l); blanked = false; }
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  while (out.length && out[0].trim() === '') out.shift();
  return out;
}

function keepTail(lines, n) {
  if (lines.length <= n) return lines.slice();
  return [`... [AURA: ${lines.length - n} earlier line(s) elided] ...`].concat(lines.slice(-n));
}

// test-runner keep: passing tests collapse to a COUNT (ppgranger's move — "passing
// tests are not information"), failures and summaries stay verbatim.
function keepTestResults(lines) {
  const PASS_LINE = /(?:^|\s)(?:PASSED|✓|✔|ok)(?:\s|$)/i;
  // summary = a COUNT + result word at a real boundary — the (^|\s) prefix stops digits
  // INSIDE identifiers ("test_pass_0 PASSED") from looking like the "0 passed" summary
  const SUMMARY_LINE = /(?:^|\s)\d+\s+(?:tests?|specs?|passed|failed|failures?|errors?|warnings?)\b|\bpassed\b.*\bfailed\b|(?:^|\s)\d+%|===+|---+|\[\d+\/\d+\]/i;
  const kept = [];
  let passed = 0;
  for (const l of lines) {
    if (!l.trim()) continue;
    if (isCriticalLine(l)) { kept.push(l); continue; }            // FAILED/ERROR blocks verbatim
    if (SUMMARY_LINE.test(l)) { kept.push(l); continue; }         // totals + warnings summary
    if (PASS_LINE.test(l)) { passed++; continue; }                // a pass is a count, not a line
    if (kept.length >= MAX_FAMILY_KEEP) break;
  }
  const cleaned = collapseBlank(kept);
  if (passed) cleaned.unshift(`[AURA: ${passed} passing test line(s) collapsed]`);
  if (!cleaned.length) return keepTail(lines, 20);
  const dropped = lines.filter((l) => l.trim() && !cleaned.includes(l)).length;
  if (dropped > 0) cleaned.push(`... [AURA: ${dropped} non-result line(s) elided] ...`);
  return cleaned;
}

// lint keep: error/warning lines + the trailing summary count
function keepErrors(lines) {
  const kept = [];
  let summaryKept = false;
  for (const l of lines) {
    if (isCriticalLine(l)) kept.push(l);
    if (/\bwarning|\b⚠|✖|\d+ problems?(?: \(?:\d+ errors?)?\)?|\d+ errors? found/i.test(l)) {
      if (!kept.includes(l)) kept.push(l);
      if (/\d+/.test(l)) summaryKept = true;
    }
    if (kept.length >= MAX_FAMILY_KEEP) break;
  }
  if (!kept.length) return keepTail(lines, 20);
  return kept;
}

// unified-diff keep: headers + changes; collapse runs of context lines
function keepDiff(lines) {
  const out = [];
  let ctxRun = 0;
  for (const l of lines) {
    const isHdr = /^diff --git|^@@|^(new file|deleted file|rename|similarity|copy|index|Binary files|old mode|new mode)/.test(l);
    const isChange = /^[+-]/.test(l) && !/^(---|\+\+\+)/.test(l);
    const isStat = /^\s*\S+\s*\|\s*\d+/; // --stat rows
    if (isHdr || isChange || isStat) {
      if (ctxRun > 3) out.push(`... [AURA: ${ctxRun - 2} unchanged context line(s) elided] ...`);
      ctxRun = 0;
      out.push(l);
    } else {
      ctxRun++;
    }
    if (out.length >= MAX_FAMILY_KEEP) { out.push(`... [AURA: diff truncated] ...`); break; }
  }
  return out.length ? out : keepTail(lines, 20);
}

// git remote progress: drop % meters and "Receiving/Counting/Compressing objects" bars
function keepNonProgress(lines) {
  const NOISE = /\d+%|(receiving|counting|compressing|resolving)\s+(objects|deltas)|^remote:\s*(counting|compressing)/i;
  const kept = lines.filter((l) => !NOISE.test(l));
  return kept.length ? kept : keepTail(lines, 20);
}

// ------------------------------------------------------------------ main
const DEFAULT_SUCCESS_TAIL = 5;
const DEFAULT_FAIL_TAIL = 50;
const RECOVER_CAP = 20;

/**
 * trimOutput({ name, output, failed, maxLines }) -> { output, report }
 *   name     — the tool/command name (drives family matching). Optional.
 *   output   — the raw tool output (string). Required.
 *   failed   — boolean; explicit success/failure verdict. If omitted, inferred:
 *              failure is assumed when error-shaped lines appear in the tail.
 *   maxLines — override the retention budget for the generic tail strategy.
 *
 * report: { linesBefore, linesAfter, tokensBefore, tokensAfter, tokensSaved,
 *           recovered, family, reason }
 *   reason: 'family' | 'asymmetric-tail' | 'no-gain' | 'too-small'
 */
function trimOutput(opts = {}) {
  try {
    const name = String(opts.name || '');
    const raw = String(opts.output == null ? '' : opts.output);
    if (!raw.trim()) return { output: raw, report: { reason: 'empty', tokensSaved: 0 } };

    const text = stripAnsi(raw);
    const linesBefore = text.split('\n');
    const tokensBefore = estTokens(text);

    // too small to be worth shaping — never touch it (source files, short answers)
    if (tokensBefore <= 40) return { output: raw, report: { reason: 'too-small', tokensBefore, tokensAfter: tokensBefore, tokensSaved: 0 } };

    // success/failure verdict: explicit flag wins; else infer from the tail
    let failed = opts.failed === true;
    if (opts.failed !== true && opts.failed !== false) {
      const tailLines = linesBefore.slice(-5);
      failed = tailLines.some((l) => isCriticalLine(l));
    }

    const family = matchFamily(name);
    let kept;
    let reason = 'asymmetric-tail';
    if (family) {
      reason = 'family:' + family.name;
      switch (family.keep) {
        case 'tail': kept = keepTail(linesBefore, Number(opts.maxLines) > 0 ? Number(opts.maxLines) : family.lines); break;
        case 'test-results': kept = keepTestResults(linesBefore); break;
        case 'errors': kept = keepErrors(linesBefore); break;
        case 'diff': kept = keepDiff(linesBefore); break;
        case 'progress': kept = keepNonProgress(linesBefore); break;
        default: kept = keepTail(linesBefore, family.lines || 20);
      }
    } else {
      const budget = Number(opts.maxLines) > 0 ? Number(opts.maxLines) : (failed ? DEFAULT_FAIL_TAIL : DEFAULT_SUCCESS_TAIL);
      kept = keepTail(linesBefore, budget);
    }

    // generic cleanups on whatever survived
    kept = collapseBlank(collapseIdentical(kept));

    // CRITICAL-LINE RECOVERY — any error-shaped original line that no longer appears
    // in the result is re-appended (capped). Containment is substring-based because
    // keeps may reformat lines.
    const recovered = [];
    if (failed || family) {
      for (const l of linesBefore) {
        if (recovered.length >= RECOVER_CAP) break;
        if (!isCriticalLine(l)) continue;
        if (lineMissing(linesBefore, kept, l)) recovered.push(l.trim());
      }
    }
    let resultLines = kept.slice();
    if (recovered.length) {
      resultLines.push(`... [AURA: ${recovered.length} error line(s) recovered from elided section] ...`);
      resultLines = resultLines.concat(recovered);
    }

    const resultText = resultLines.join('\n');
    const tokensAfter = estTokens(resultText);

    // RATIO GATE — if shaping didn't actually shrink it, hand back the original.
    if (tokensAfter >= tokensBefore) {
      return { output: raw, report: { reason: 'no-gain', linesBefore: linesBefore.length, linesAfter: linesBefore.length, tokensBefore, tokensAfter: tokensBefore, tokensSaved: 0, recovered: 0, family: family ? family.name : null } };
    }

    return {
      output: resultText,
      report: {
        reason, family: family ? family.name : null,
        linesBefore: linesBefore.length, linesAfter: resultLines.length,
        tokensBefore, tokensAfter,
        tokensSaved: tokensBefore - tokensAfter,
        recovered: recovered.length
      }
    };
  } catch (_) {
    return { output: String(opts.output == null ? '' : opts.output), report: { reason: 'error-guard', tokensSaved: 0 } };
  }
}

module.exports = { trimOutput, matchFamily, isCriticalLine, stripAnsi, FAMILIES };
