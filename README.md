# AURA — the dependency-free token saver (CLI · MCP · library)

Cut your LLM bill by answering recurring prompts for **free** — from a local cache,
saved skills, or deterministic compute — before you ever call a model. Use it in
your terminal, drop it into code, or wire it into Claude / Cursor / Claude Code via
its built-in **MCP server**. Zero dependencies, MIT licensed.


AURA answers your prompts the **cheapest way first** so you call (and pay for) an AI model far less:

1. **Cache (exact)** — you asked this before → instant, free.
2. **Cache (fuzzy)** — you asked something *similar* → free. (Filler words like "what's the…" are ignored, so close rephrasings still hit.)
3. **Compute** — solved locally, free: math, unit conversions, dates, base64, word-count, upper/lowercase, **percent of**, **% off (with savings)**, **tip**, **percent change**, **days between dates**.
4. **LLM fallback (optional)** — only if you add `--llm` *and* you have a model key set. AURA auto-picks the **cheapest capable model** (light / balanced / heavy) for the question, then caches the answer so next time it's free.

> **Inspired by [AINL (AI Native Lang)](https://github.com/sbhooley/ainativelang).** AINL's core idea is to *keep the model off the hot path*: figure something out once, then run it deterministically forever with no per-run inference. AURA applies that same principle — cache + local "templates" mean recurring questions cost nothing.

It uses only built-in Node — **no installs, no dependencies**. Cache lives in `~/.shaddai-aura` (your home folder), so it works from any terminal.

---

## Use it (no install)

Open a terminal in this folder and run:

```
node cli.js ask "what is 15 * 240"
node cli.js ask "convert 10 km to miles"
node cli.js stats
```

## Use it from anywhere (type `aura` instead of `node cli.js`)

Run this **once**, inside this folder:

```
npm install -g .
```

Now from **any** terminal:

```
aura ask "what is 12% of 80"
aura learn "our refund policy" "30 days, no questions asked"
aura ask "our refund policy"          # → free, from cache
aura stats
```

(To undo the global install: `npm uninstall -g shaddai-aura`.)

---

## Commands

| Command | What it does |
|---|---|
| `aura ask "<prompt>"` | Answer it for free if possible (cache or compute). |
| `aura ask "<prompt>" --llm` | If there's no free answer, call your AI model, then cache it. |
| `aura ask "<prompt>" --llm --model <id>` | Same, but pick the model. |
| `aura learn "<prompt>" "<answer>"` | Teach AURA an answer so it's free next time. |
| `aura stats` | Show tokens & dollars saved. |
| `aura clear` | Wipe the cache. |
| `aura where` | Show where the cache file lives. |

## Saved skills (define once → free forever)

A **skill** is a tiny "compiled program": a pattern → a deterministic action, stored in `~/.shaddai-aura/skills.json`. Once saved, any matching prompt is answered for free with **no AI call** — AURA's take on AINL's "author once, run forever."

```
# substring/keyword match → fixed answer
aura skill add "support" --match "support email" --do "cloudzncrownz@gmail.com"
aura ask "hey whats the support email"     # → cloudzncrownz@gmail.com   (free · via skill)

# regex match with $1, $2 capture-group substitution (--regex, or wrap the pattern in /.../)
aura skill add "greet" --match "/^hi (\w+)/i" --do "Hello, $1!" --regex
aura ask "hi Brittany"                      # → Hello, Brittany!

aura skill list                             # show all saved skills
aura skill remove "greet"                   # delete one
```

**Matching:** a plain pattern matches if every word in it appears in the prompt (case-insensitive). Wrap it in `/.../` (or pass `--regex`) to use a regular expression; capture groups fill `$1`, `$2`, … in the answer.

**Where skills sit in the flow:** `route()` checks **exact cache → fuzzy cache → skills → local compute**. A real cached answer wins (it's the most authoritative), but your explicit skill beats generic compute.

**Adapters (live data, still free, no key):** a skill action can be `{ type:'adapter', adapter:'price', args:{ coin:'btc' } }` to fetch deterministic data instead of calling an LLM. The built-in `price` adapter uses CoinLore (no API key). Adapters do network I/O, so they run through the async `ask()` (not the sync `route()`) and **degrade gracefully** — if you're offline they just return a normal miss, never an error. Define one in JS:

```js
const aura = require('./aura-core');
aura.addSkill({ name: 'btc', match: 'btc price', action: { type: 'adapter', adapter: 'price', args: { coin: 'btc' } } });
await aura.ask('btc price');   // { method:'skill', answer:'Bitcoin (BTC): $65785.37', ... }
```

## Connecting your AI model (for `--llm`)

Set **one** of these before running (whichever service you have a key for):

```
# Windows PowerShell
$env:OPENROUTER_API_KEY = "sk-..."     # or OPENAI_API_KEY, or ANTHROPIC_API_KEY

# macOS/Linux
export OPENROUTER_API_KEY="sk-..."
```

Then `aura ask "summarize this..." --llm` works. Without a key, `--llm` simply tells you no model is connected — it never makes anything up.

---

## Use it in Claude / Cursor / Claude Code (MCP)

AURA ships an **MCP server** so any Model Context Protocol client can save tokens
automatically. It exposes three tools:

| Tool | What it does |
|---|---|
| `aura_ask` | Try to answer a prompt for **free** (cache / saved skill / compute). The model calls this *first*; on a hit it skips its own reasoning. |
| `aura_remember` | Cache an answer the model just generated, so it's free next time. |
| `aura_stats` | Show tokens & dollars saved. |

The server is **zero-dependency** — it speaks MCP's JSON-RPC over stdio directly.

### Claude Desktop
Add to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "aura": { "command": "npx", "args": ["-y", "-p", "shaddai-aura", "aura-mcp"] }
  }
}
```

### Claude Code
```
claude mcp add aura -- npx -y -p shaddai-aura aura-mcp
```

### Cursor
Add to `.cursor/mcp.json`:
```json
{ "mcpServers": { "aura": { "command": "npx", "args": ["-y", "-p", "shaddai-aura", "aura-mcp"] } } }
```

### Running from a local clone (before the npm package is published)
Point the client's `command` at your checkout instead:
```json
{ "mcpServers": { "aura": { "command": "node", "args": ["/absolute/path/to/aura/mcp.js"] } } }
```

> **How it saves tokens:** tell your assistant (system prompt / project rules) to
> *call `aura_ask` before answering, use the answer if `hit` is true, and call
> `aura_remember` after generating a stable answer.* Recurring questions, facts,
> and anything computable then cost **nothing**.

---

## Use it as a library (for the dashboard / other code)

```js
const aura = require('shaddai-aura');     // or require('./aura-core')
const r = aura.route('what is 2+2');        // { hit:true, method:'compute', answer:'4', ... }
const full = await aura.ask('...', { llm: true });
aura.recordAnswer('q', 'a');                // cache an answer
aura.stats();                               // savings summary

// saved-skills registry
aura.addSkill({ name:'support', match:'support email', action:{ type:'answer', text:'...' } });
aura.listSkills();
aura.matchSkill('whats the support email'); // { name, action, text, ... } or null
aura.removeSkill('support');
```

This is the same engine as the SHADDAI dashboard's `backend/lib/aura.js`.

### Share one cache between the terminal tool and the dashboard

Both the CLI and the dashboard read `AURA_HOME` if it's set. Point them at the same folder and their savings **compound** — an answer learned in the terminal is free in the app, and vice-versa:

```
# Windows PowerShell (set once for your user)
setx AURA_HOME "$env:USERPROFILE\.shaddai-aura"
```

If `AURA_HOME` is unset, the CLI uses `~/.shaddai-aura` and the dashboard uses its own `backend/data` folder (separate caches).
