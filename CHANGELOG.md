# Changelog

All notable changes to **shaddai-aura** (AURA). Format follows
[Keep a Changelog](https://keepachangelog.com/); this project uses semver.

## [0.7.2] — 2026-10-02

Quality sweep release — every tool driven with realistic payloads end-to-end over real
stdio JSON-RPC, and what the sweep taught us, shipped.

### Added
- **`npm run verify:mcp`** (`mcp-sweep.js`) — the one-command health check: all 9 tools
  + the savings resource driven over the REAL protocol with realistic payloads, checking
  result QUALITY (right answer, right protection, right savings, ledger consistency,
  on-disk persistence, secret screen), 27 checks, exit 0 only when all pass.
- **Light stemming in the fuzzy path** — `capitals→capital`, `cities→city`,
  `caching/cached→cach` (Marktechpost's measured stemmer rules). Applied ONLY to fuzzy
  similarity tokens, never to `hashKey`, so the exact cache is never invalidated.
  A plural paraphrase ("what are the capitals of France") now hits a cached singular
  ("what is the capital of France"). Mirrored exactly in `lib/search-index.js` so BM25
  candidates and the cosine gate stay in lockstep (pinned by tests).

### Notes from the sweep (behaviors verified as BY DESIGN, not bugs)
- A diluted paraphrase ("capital city of France, the country" → cos 0.707) still misses
  under the 0.82 threshold — conservative by design; the miss note routes the agent to
  answer + `aura_remember`.
- `aura_distill` keeps BOTH copies of a protected rule (e.g. "always cite your sources"
  matches the envelope keyword `cite`) — protection outranks dedup, even duplicated.
- `aura_optimize` reports `fit:false` honestly when the budget is genuinely impossible
  (protected recent window holds a huge tool dump) — it never drops the protected core
  to hit a number.

## [0.7.1] — 2026-10-02

MCP server audit + protocol hardening pass. **198/198 tests green.**

### Fixed (security)
- **P0 ReDoS in the shared secret screen** — the connection-string pattern
  (`[a-z][a-z0-9+.-]*://…`) was catastrophic-quadratic on long uniform strings: a 400KB
  tool result HUNG the process (~80 billion backtracks). Now the scheme prefix is bounded
  (`{0,40}` — real schemes are <15 chars), making every secret pattern linear: 400KB
  screens in ~20ms. Regression test pinned in `core-guards.test.js`. Found by putting
  `hasSecret` on the tool-cache hot path — the new screen would have frozen any MCP
  session that cached a big uniform value.
- **Secret-bearing tool results never persist** — `lib/tool-cache.js` screens each cached
  value at cache time; secret-bearing entries (a `cat .env` result, a token in a log) stay
  memory-only for the process lifetime instead of being written to the plaintext
  `aura-tool-cache.json`. Legacy entries are re-screened on flush.
- **No persist-file bloat** — values over 100KB are memory-only, capping the disk file
  (~1GB theoretical before) at a few MB.
- **Non-string message content is bounded** — `aura_compress`/`aura_optimize` clipped
  string content but block arrays bypassed the clip; oversized non-string content now
  degrades to a placeholder.
- **64MB stdin line guard** — a line with no newline could grow `buf` unboundedly; now
  one Parse error is emitted, the offending line is drained, and the server keeps serving.

### Fixed (protocol)
- **Protocol version negotiation** — `initialize` now echoes the client's version only
  when it's in the known-compatible set (`2024-11-05`, `2025-03-26`, `2025-06-18`);
  anything else falls back to the version the server actually supports instead of
  blindly claiming support for unknown future revisions.
- **JSON-RPC 2.0 compliance** — an unparseable line now gets a `-32700 Parse error`
  response (id: null) instead of silent deletion; non-object/batch requests get
  `-32600 Invalid Request` when an id survives.
- **Full capabilities advertised** — `initialize` now correctly declares `prompts`
  (it always handled `prompts/list`), plus `listChanged: false` flags, and ships an
  `instructions` string so MCP clients display what AURA does.

### Added
- **Version stamping** — `aura_stats`, `aura_savings`, and the `aura://savings` resource
  now carry the server `version`, so a client/dashboard can always tell which build is
  live. `aura_savings` and the resource now share one payload builder (single source of
  truth).
- **MCP integration tests** for the new surfaces: ping, unknown method (-32601),
  `aura_trim_output` end-to-end, secret refusal with reason, parse-error response,
  oversized block-array content, secret/size persistence guards, ReDoS regression.

## [0.7.0] — 2026-10-02

The "best of the token-saver repos" release — four upgrades extracted from a survey of
the best open-source token savers (format-aware output shaping, persistent tool caching,
credential-safe caching, volatility-aware TTLs).

### Added
- **Tool-output shaping (`aura_trim_output`, `lib/output-trim.js`)** — AURA's first
  OUTPUT-side surface. Shape a tool/command result BEFORE it enters context: ANSI strip,
  repeated-line collapse, format-aware keeps for known-noisy families (npm install,
  builds, test runners, lint, git diff/log/remote), an asymmetric budget (success keeps
  the last ~5 lines, failure keeps the last ~50), **critical-line recovery** (error-shaped
  lines from elided sections are re-appended, capped — compression can never silently eat
  the failure reason), and a ratio gate (no gain → original returned). Ledger: method
  `outputTrim`.
- **Persistent tool cache** — `lib/tool-cache.js` entries AND stats now persist to
  `<AURA_HOME>/aura-tool-cache.json`, so tool-call savings compound across sessions
  (previously every MCP server process died with its stats at zero). Write-behind with
  debounce + exit flush; multi-process-safe via monotone max-merge on flush. Kill-switch:
  `AURA_TOOL_CACHE_PERSIST=0`. `wrap()` now accepts any argument shape (multi-arg tools
  are keyed on the full argument list, object-arg order-independent).
- **Credential-safe caching** — `recordAnswer`/`remember` now run the `learn-sessions`
  secret screen (API keys, JWTs, PEM blocks, high-entropy tokens, connection strings) on
  prompt AND answer before persisting; secrets are never written to the plaintext cache.
  MCP `aura_remember` returns `{ ok:false, reason:'secret-detected' }` instead of silently
  refusing, so an agent can redact and retry.
- **Volatility-aware TTLs** — time-sensitive prompts (price / now / latest / today …)
  recorded via `remember`/`--llm` get a 15-minute TTL instead of the flat 24h default, so
  a stale answer can never outlive its freshness. An explicit `ttlMs` always wins.

### Changed
- **Configurable cost rate** — `AURA_COST_PER_1K` env overrides the hardcoded $0.50/M
  ledger rate, so `stats().costSavedUsd` can match the model you actually use.
- MCP surface grows to **9 tools** (`aura_trim_output` joins the 8 from 0.6.2).

## [0.6.2] — 2026-07-19

### Added
- **MCP deepening** — the server now exposes AURA's context optimizer to any MCP client
  (Claude Desktop / Claude Code / Cursor): two new tools — **`aura_select_tools`** (selective
  tool injection) and **`aura_optimize`** (the full one-call optimizer) — bringing it to 8
  tools, plus a read-only **`aura://savings`** resource so clients can pull the live per-surface
  savings ledger straight into their context. `resources` capability now advertised.

## [0.6.1] — 2026-07-19

### Added
- **Native prompt caching** — `aura.optimize(request, { cache: true })` inserts provider
  prompt-cache breakpoints (`cache_control: {type:'ephemeral'}`) on the stable prefix: the
  distilled system prompt (always) and the tool array (only when not trimmed per turn, since a
  changing subset would miss the cache). ~90% off the cached prefix after the first call.
  OpenAI auto-caches prefixes, so it's a reported no-op there. See `report.cache`.

## [0.6.0] — 2026-07-19

AURA graduates from a repeat-answer cache into a **deterministic, zero-dependency
context optimizer for AI agents** — it trims what you re-send on *every* call across
four surfaces: **tools, history, instructions, and answers.**

### Added
- **Selective tool injection** (`aura.selectTools`, `lib/tool-select.js`) — send only
  the tools a turn actually needs instead of the whole toolbox. ~82% of tool-schema
  tokens saved on a 40-tool agent. Context-aware (reads recent turns, so terse
  follow-ups like "yes, do it" still resolve the right tool), **fails open** (never
  drops a tool it can't rule out), works with OpenAI and Anthropic tool shapes.
- **`aura.optimize(request)`** — one call runs tool injection + distill + compress on a
  full request and returns a ready-to-send one. Non-mutating. Handles a string `system`,
  an Anthropic block-array `system` (`cache_control` preserved), or an OpenAI system
  message. Optional **`maxTokens`** hard-fits the whole request to a budget and reports
  an honest `fit` verdict (never drops the protected core to hit a number).
- **Per-surface savings ledger** — `stats()` now returns `tokensByMethod` + `costByMethod`;
  `aura stats` shows where every saved token came from (tool injection / history / distill
  / cache / compute).
- **Bonus COMPUTE ops** (`lib/compute-ops.js`) — base conversion, hashing, URL encode/decode,
  ROT13, char count, text casing/slugify, hex↔rgb. A free fast-path, not the headline.
- Benchmarks: `benchmarks/tool-select-benchmark.js`, `benchmarks/optimize-benchmark.js`
  (capstone: ~60% of total request tokens saved over a real agent session).

### Changed
- **Compress** now dedups **near-identical** re-reads (the "read file → edit → read again"
  drain that exact-hash missed) and **collapses runs of repeated identical lines**
  (log/retry spam) before truncating — smarter and more lossless than blind head/tail cuts.
- **Distill** widened safely: larger leading-hedge dictionary + whole-line politeness
  removal, still never touching safety / output-shape / success / routing / behavior-envelope
  rules.
- Library surface: `aura.distill` and `aura.compress` are now exported directly.

### Notes
- Still **zero runtime dependencies**; Node ≥ 18. 167 tests green.

## [0.5.0]

### Added
- **DISTILL** (`lib/prompt-distill.js`) — AURA's instructions pillar: deterministically
  trims redundant/duplicate rules and leading filler from a bloated system prompt while
  protecting safety, output-shape, success, routing, and behavior-envelope constraints.
  Optional `--llm` semantic pass, accepted only if every protected rule survives.
- `aura distill` CLI command and `aura_distill` MCP tool.

## [0.3.0]

### Security
- Input caps, `console`→stderr so stdout stays pure JSON-RPC, graceful
  resources/prompts/unknown-tool handling, `SECURITY.md`, MCP test coverage. Core audited
  free of `eval` / `Function` / `child_process` / shell; bounded cache; zero dependencies.

[0.6.0]: https://github.com/IzzoSol/Aura
[0.5.0]: https://github.com/IzzoSol/Aura
[0.3.0]: https://github.com/IzzoSol/Aura
