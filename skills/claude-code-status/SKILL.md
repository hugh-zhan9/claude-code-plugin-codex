---
name: claude-code-status
description: Show local Claude Code delegation jobs created by this Codex plugin.
---

# Claude Code Status

Use when the user asks for status of Claude Code jobs started by this plugin.

Do not use MCP. Do not inspect external Claude Code sessions.

Run:

```bash
node "${PLUGIN_ROOT}/scripts/cc-companion.mjs" status
```

For a specific job, add the job id or unique prefix.
Return the companion output directly.
