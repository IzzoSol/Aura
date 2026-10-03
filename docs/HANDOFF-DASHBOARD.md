# HANDOFF — Wire AURA v0.7.0 into the SHADDAI Dashboard

You are picking up a well-scoped frontend/backend wiring task. AURA (the token saver) was
just upgraded to **v0.7.0** with new savings surfaces; the dashboard needs to surface them.
This doc is self-contained — read it fully before touching code.

---

## 1. Where everything lives

| What | Path |
|---|---|
| **AURA package (v0.7.0)** | `C:\Users\Brittany\aura-research\aura-main` (repo: IzzoSol/aura) |
| **LIVE site/backend to modify** | `C:\Users\Brittany\Shaddai` — port 3000 (`backend\server-production.js`, PID restart needed) |
| Dashboard page | `C:\Users\Brittany\Shaddai\public\aura.html` (721 lines; identical copies exist in Shaddai-Beta / Shaddai-v1013 / Shaddai-3d — do NOT edit those) |
| Backend engine (dashboard's own AURA) | `C:\Users\Brittany\Shaddai\backend\lib\aura.js` — separate implementation, data in `backend\data\` |
| AURA routes | `C:\Users\Brittany\Shaddai\backend\aura-routes.js` — mounted at `/api/aura` (`server-production.js:2119`) |
| **MCP/CLI AURA ledger (the npm package)** | `C:\Users\Brittany\.shaddai-aura\aura-stats.json` + `aura-cache.json` + **NEW** `aura-tool-cache.json` |
| MCP config (now local!) | `.claude.json` → `mcpServers.aura` = `node C:\Users\Brittany\aura-research\aura-main\mcp.js` (backup: `.claude.json.bak-aura-070`) |

## 2. What's NEW in AURA v0.7.0 (what you're wiring up)

1. **9th MCP tool `aura_trim_output`** — shapes noisy tool/command output (npm install,
   builds, test runs, lint, git diff) before it enters context. Books savings under a NEW
   ledger method: `outputTrim`.
2. **Ledger methods now 8**: `fetch, query, skill, compute, distill, toolInject, compress, outputTrim`.
3. **Persistent tool cache** — `C:\Users\Brittany\.shaddai-aura\aura-tool-cache.json`:
   ```json
   { "version": 1,
     "stats": { "hits": N, "misses": N, "callsAvoided": N, "tokensSaved": N,
                "byTool": { "<tool>": { "hits": N, "misses": N, "tokensSaved": N } } },
     "entries": { "<sha256>": { "value": "<json-string>", "expires": ms, "tokens": N } } }
   ```
4. **Secret screen** on `aura_remember` (refuses API keys/JWTs/PEM with `reason:'secret-detected'`)
   and **volatility TTLs** (price/now/today prompts cached 15 min, not 24h).
5. **`AURA_COST_PER_1K` env** — ledger dollars can match a real model rate.

Exact stats shape from the package (`aura.stats()`):
```json
{ "hits": 46, "misses": 25, "hitRate": 0.648, "tokensSaved": 2361,
  "costSavedUsd": 0.001181,
  "byMethod":        { "fetch":21, "query":2, "skill":3, "compute":20, "distill":6, "toolInject":5, "compress":2, "outputTrim":N },
  "tokensByMethod":  { ...tokens per surface, incl. "outputTrim": N },
  "costByMethod":    { ...dollars per surface, incl. "outputTrim": N },
  "cacheFile": "C:\\Users\\Brittany\\.shaddai-aura\\aura-cache.json" }
```

## 3. Current dashboard wiring (how data flows today)

- `aura.html` polls **`GET /api/aura/stats` every 5s** (`aura.html:662-701`, `tick()`).
- `/api/aura/stats` (`aura-routes.js:56-62`) returns `lib/aura.js stats()` + in-memory
  `toolCache` — **from `backend\data\aura-stats.json` only.** The npm/MCP ledger at
  `~/.shaddai-aura\` is a SEPARATE ledger that NEVER appears on the dashboard.
- Dashboard sections: hero count-up (:340), 8 Live Monitor instruments (:366), API-pull
  cache panel (:383), VERIFY benchmark (:399), TRY AURA console (:413), MCP SETUP (:428),
  HOW IT SAVED — 5 bars SEED/FETCH/COMPUTE/QUERY/RECIPE (:454), RECENT SAVES feed (:462).

## 4. Tasks (ranked; do them in order)

**T1 — Reconcile the two ledgers (biggest win).** Add to `aura-routes.js` a
`GET /api/aura/mcp-savings` that reads `C:\Users\Brittany\.shaddai-aura\aura-stats.json`
and `aura-tool-cache.json` (read-only, tolerant of missing files) and returns
`{ answerCache, toolCache }` in the same shape as the MCP `aura_savings` tool. Merge those
numbers into the hero + HOW IT SAVED totals (label them "MCP/CLI side" so the two sources
are visible, not just silently summed).

**T2 — HOW IT SAVED: bars are counts only, and 3 surfaces are missing.** The backend's
`byMethod` has 8 methods (`lib/aura.js:131`) but the UI bars show only 5 (`aura.html:454-458`).
Render all 8 (+ `outputTrim`), and add a second row under each bar with the TOKENS figure
(`tokensByMethod`), not just call counts.

**T3 — Surface the new outputTrim surface.** After T1/T2 it needs its own instrument or bar.
This is the surface that saves the most per hit on the MCP side right now.

**T4 — Tool-cache panel upgrade.** The API-pull cache panel shows name+hits only. Add
per-tool misses + tokensSaved (available in `topTools[]`, `lib/tool-cache.js:150`), and
show the MCP side's persistent `byTool` from `aura-tool-cache.json`.

**T5 — Sparkline/trend.** `stats()` already returns `improvements.hitRateHistory[]`
(`lib/aura.js:1838-1843`) and the page has NO charts. Add a small inline SVG sparkline of
hit-rate + tokens-saved over time. No chart library — it's a 721-line single-file page,
keep it dependency-free.

**T6 — Stale copy fixes.** `aura.html:432,441` says "v0.4.0 · 5 tools" and the roadmap says
"8 total… `aura://savings` resource" — the server now serves **9 tools** via
`node C:\Users\Brittany\aura-research\aura-main\mcp.js`. Update the copyable command in the
MCP SETUP section to the node-path command and the count to 9 tools + 1 resource.

**T7 (stretch) — Cache viewer.** `/api/aura/skills` and `/api/aura/audit` exist with no UI.
A collapsible "cache inspector" (recent cache entries: prompt snippet + method + ttl) would
make the TRY AURA console far more convincing.

## 5. Constraints (read twice)

- Only modify `C:\Users\Brittany\Shaddai` (the LIVE repo). The other copies are archives.
- Do not restart/kill the production server without asking — edits to `aura.html` are
  static-safe (just refresh), but `aura-routes.js`/`server-production.js` need a restart;
  ASK FIRST.
- Dependency-free vanilla JS only; match the page's existing style (CSS vars in `:root`,
  `.stat-card`, `.src-badge` classes, 5s `tick()` polling pattern).
- Never log/echo secret values; the cache viewer must clip prompt snippets to ~80 chars.
- `aura-stats.json` files are read-ONLY for the dashboard — writes go through AURA's own
  code paths, not the server routes.

## 6. Acceptance criteria

- [ ] Dashboard hero + HOW IT SAVED include BOTH ledgers (backend/data + ~/.shaddai-aura)
- [ ] All 8 method bars render with counts AND tokens (incl. `outputTrim`)
- [ ] Tool-cache panel shows per-tool hits/misses/tokens from the persistent file
- [ ] At least one trend visualization (sparkline) with real history data
- [ ] MCP SETUP section shows the 9 tools + correct install/run command
- [ ] Page still polls cleanly when `~/.shaddai-aura` files are missing (graceful zeros)
- [ ] No external JS/CSS libraries added; page loads standalone

## 7. Quick test recipe

1. `curl http://localhost:3000/api/aura/stats` — current payload.
2. `node C:\Users\Brittany\aura-research\aura-main\mcp.js` (then a JSON-RPC `tools/list`
   frame on stdin) — see 9 tools; `aura_savings` shows the MCP ledger.
3. Compare the two stats files before/after a few `aura_trim_output` calls through the
   MCP server; the dashboard must reflect the delta within one 5s tick after T1.
