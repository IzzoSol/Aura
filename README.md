<div align="center">

# 💾 AURA

### The dependency-free LLM token-saver

*Part of the [⚡ SHADDAI](https://github.com/IzzoIzzoIzzo/Shaddai) family*

Answer recurring prompts for **free** — cache, compute, seed, and skill fast-paths that
never touch the model. Ships as a **CLI**, an **MCP server** (Claude / Cursor / Claude Code),
and a **library**. Zero dependencies. Pure JSON-RPC. Security-hardened.

<br>

[![npm](https://img.shields.io/npm/v/shaddai-aura?style=for-the-badge&color=00ff88&label=shaddai-aura)](https://www.npmjs.com/package/shaddai-aura)
[![License](https://img.shields.io/badge/license-MIT-00b4d8?style=for-the-badge)](LICENSE)
[![Deps](https://img.shields.io/badge/dependencies-0-9b5de5?style=for-the-badge)](package.json)
[![MCP](https://img.shields.io/badge/MCP-ready-f77f00?style=for-the-badge)](#mcp-server)

[**𝕏 @shaddaiAI**](https://x.com/shaddaiAI) · [**Built by @IzzoSol**](https://x.com/IzzoSol)

</div>

---

## ✦ Why

Every LLM app pays, again and again, for the same recurring questions. AURA intercepts them
*before* the API call — serving deterministic answers from cache, computation, seeded facts,
and parameter-less skill recipes. What can be answered for free, is.

## ✦ Install

```bash
# one-shot MCP server (Claude Desktop / Cursor / Claude Code)
npx -y -p shaddai-aura aura-mcp

# or the CLI
npm i -g shaddai-aura
aura ask "recurring question"
aura learn ...
aura stats
```

## ✦ MCP server

Point any MCP client at `aura-mcp`. stdout stays pure JSON-RPC (logs go to stderr), inputs are
capped, and unknown tools / resources / prompts degrade gracefully. See `SECURITY.md`.

```json
{ "mcpServers": { "aura": { "command": "npx", "args": ["-y", "-p", "shaddai-aura", "aura-mcp"] } } }
```

## ✦ How it saves

| Path | What it does |
|------|--------------|
| **CACHE** | bounded TTL cache of prior answers |
| **COMPUTE** | deterministic math/logic answered locally |
| **SEED / QUERY** | seeded facts + structured lookups |
| **RECIPE** | parameter-less skill recipes run without the model |

Core audited safe: no `eval` / `Function` / `child_process` / shell, bounded cache, zero deps.

---

## ✦ The SHADDAI Family

| Repo | What |
|------|------|
| **[Shaddai](https://github.com/IzzoIzzoIzzo/Shaddai)** | The sovereign AI agent empire — 7 agents, 200+ real tools |
| **[aura](https://github.com/IzzoIzzoIzzo/aura)** | *(this)* dependency-free token-saver · CLI + MCP + library |
| **[Shaddai-Clipper-Feature-](https://github.com/IzzoIzzoIzzo/Shaddai-Clipper-Feature-)** | Long video → captioned vertical shorts |

<div align="center">
<br>

**Built by [@IzzoSol](https://x.com/IzzoSol) · Follow [@shaddaiAI](https://x.com/shaddaiAI)** · MIT

</div>
