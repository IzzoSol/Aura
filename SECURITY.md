# Security

AURA is designed to be safe to run on your machine and to expose to your AI client.

## Design guarantees
- **No code execution.** AURA never uses `eval`, `new Function`, `child_process`, or a shell. Math is parsed with a tokenizer + arithmetic evaluator (`parseFloat` + `+ - * / ^`), not by evaluating strings.
- **Zero dependencies.** Only Node built-ins (`fs`, `path`, `os`, `crypto`). Minimal supply-chain surface — nothing else is pulled into your process.
- **No secret handling in the MCP server.** The MCP tools run with the LLM path **off** (`aura_ask` never calls a paid model and never reads API keys). Optional `--llm` in the CLI reads a key only from your environment and is never logged.
- **Local, user-owned data.** The cache lives in `~/.shaddai-aura` (or `AURA_HOME`). Nothing is sent anywhere except the specific, deterministic adapter you explicitly configure (e.g. a price lookup).

## MCP-specific hardening
- **stdout is protocol-only.** `console.*` is redirected to stderr so nothing can corrupt the JSON-RPC stream.
- **Input caps.** Tool inputs are length-capped (prompt ≤ 20k chars, answer ≤ 200k) so a client can't exhaust memory.
- **Bounded cache.** At most 5000 entries with TTL + oldest-eviction — `aura_remember` can't fill your disk.
- **Never throws across the boundary.** Malformed messages are ignored; tool errors return a normal error result, not a crash.

## Reporting a vulnerability
Please open a private security advisory on the GitHub repo, or email the maintainer. Do not file public issues for security reports.
