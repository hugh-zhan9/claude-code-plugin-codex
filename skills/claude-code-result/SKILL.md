---
name: claude-code-result
description: Show the stored result of a Claude Code job created by this Codex plugin.
---

# Claude Code Result

Use when the user asks for the result of a Claude Code job started by this plugin.

Do not use MCP. Do not inspect external Claude Code sessions.

Run:

```bash
node "${PLUGIN_ROOT}/scripts/cc-companion.mjs" result
```

For a specific job, add the job id or unique prefix.
Return the companion output directly.
