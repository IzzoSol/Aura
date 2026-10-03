# AURA HANDOFF — 2026-10-02 (v0.7.0 shipped)

Pick up here. Everything below is the verified state of the world + what's next.

---

## 1. What shipped in v0.7.0 (this commit)

Extracted from a survey of 4 token-saver repos (ppgranger/token-saver, jnbno1163/LG-token-saver,
Marktechpost/Token-Saver, lokikill123/codex-token-skills — all cloned under
`C:\Users\Brittany\aura-research\`):

1. **`aura_trim_output`** (`lib/output-trim.js`, 9th MCP tool) — output-side surface:
   ANSI strip, repeated-line collapse, format-aware family keeps (npm install, builds,
   test runners, lint, git diff/log/remote), asymmetric budgets (success ~5 tail lines,
   failure ~50), **critical-line recovery** (error-shaped lines from elided sections are
   re-appended, capped at 20 — compression never eats the failure reason), ratio gate
   (no gain → original returned untouched). Ledger method: `outputTrim`.
2. **Persistent tool cache** (`lib/tool-cache.js`) — entries + stats survive restarts in
   `<AURA_HOME>/aura-tool-cache.json`. Write-behind (250ms debounce + exit flush),
   multi-process monotone max-merge on flush, kill-switch `AURA_TOOL_CACHE_PERSIST=0`,
   multi-arg `wrap()` support, object-arg order-independent keys.
3. **Credential-safe caching** — `recordAnswer`/`remember` run the `hasSecret` screen
   (from learn-sessions) on prompt AND answer; secrets never touch the plaintext cache.
   MCP `aura_remember` returns `{ ok:false, reason:'secret-detected' }`.
4. **Volatility TTLs** — price/now/today prompts → 15 min TTL (explicit ttlMs wins).
5. **`AURA_COST_PER_1K` env** — configurable ledger $ rate (default 0.0005).

Tests: **194/194 green** (`npm test`). Live MCP verified: handshake, 9 tools,
`aura://savings` resource, trim saves real tokens, secret refusal works.

## 2. MCP — verified working, one step left for the USER

- **Config rewire done:** `.claude.json` → `mcpServers.aura` now runs
  `node C:\Users\Brittany\aura-research\aura-main\mcp.js` (was `npx shaddai-aura` = stale
  0.6.0). Backup: `.claude.json.bak-aura-070`. opencode reads the same file (verified).
- **DO NEXT (user action):** restart Claude Code / opencode sessions — the 3 running
  `aura-mcp` processes are still the OLD 0.6.0. After restart, `tools/list` must show 9
  tools (incl. `aura_select_tools`, `aura_optimize`, `aura_trim_output`).
- Verify in-session: call `aura_savings` — toolCache should now show `persisted: true`
  and the numbers should ACCUMULATE across sessions instead of resetting.
- npm still serves 0.6.0 — **`npm publish` from this repo** when ready (run `npm test`
  first). Until then, anyone using `npx -y -p shaddai-aura aura-mcp` gets the old build;
  the local node-path config is the live one.

## 3. Known remaining work (Tier 2 — steal list not yet implemented)

Ranked, from the research reports in `aura-research\` (see especially the ppgranger audit):

1. **Skill `policy` gate** — schema defines `maxCostUSD`/`requiresConfirm`/`allowedAdapters`
   but nothing enforces it (pure docs today).
2. **`compute`/`chain` skill actions validate but never execute** (`matchSkill` only
   resolves answer/template/adapter).
3. **Session read ledger** ("reference instead of reload" — LG R4): intercept duplicate
   file reads within a session, emit a pointer instead of re-injecting content.
4. **Event-driven compaction trigger** (LG R7): a single tool result >500 lines/50KB should
   trigger immediate compression of older turns.
5. **Delta cross-run diffing** (ppgranger's crown jewel): repeated test-run diagnostics —
   render NEW/CHANGED fully, UNCHANGED as one-liners, details retrievable on demand.
6. **Prefix-cache engineering** (codex-skills): frozen-content-first layout rule; latency-based
   cache telemetry (<500ms hit / >1s miss) on LLM calls.
7. **Precision retrieval surface** (Marktechpost): hybrid BM25+vector slice extraction for
   large static docs so bulk content never enters context at all.
8. **Skill trigger metadata** — `trigger_phrases` paraphrase lists + `activation: always|on-request`
   + `default_prompt` per skill.
9. **File locking** on cache/stats JSON (concurrent writers = last-write-wins today).
10. **Incremental BM25 index** — rebuilt per route() call (fine at 5k entries, flagged for scale).

## 4. Dashboard wiring

Full spec lives in **`docs/HANDOFF-DASHBOARD.md`** (same content also at
`C:\Users\Brittany\aura-research\HANDOFF-AURA-DASHBOARD.md` for convenience). Summary:
the LIVE dashboard is `C:\Users\Brittany\Shaddai\public\aura.html` (port 3000), its
`/api/aura/stats` reads only `backend\data\` — the npm/MCP ledger at `~/.shaddai-aura\`
(incl. the NEW `aura-tool-cache.json` and `outputTrim` buckets) never appears. 7 ranked
tasks T1–T7 with acceptance criteria are in that doc. That session should be run in
Claude/Opus against the main Shaddai repo.

## 5. Repo map (where everything lives)

| Thing | Path |
|---|---|
| AURA repo (this repo, the live dev copy) | `C:\Users\Brittany\aura-research\aura-main` |
| Research clones (4 repos + reports context) | `C:\Users\Brittany\aura-research\` |
| Live dashboard + backend to modify | `C:\Users\Brittany\Shaddai` (port 3000) |
| AURA data dir (MCP/CLI ledger) | `C:\Users\Brittany\.shaddai-aura\` |
| MCP client config | `.claude.json` (both Claude Code and opencode read it) |
| Old copies (do NOT edit) | Shaddai-Beta, Shaddai-v1013, Shaddai-3d |
| Old in-repo Python AURA (deprecated) | `C:\Users\Brittany\Shaddai\aura\` (Flask, port 8010, not running) |
