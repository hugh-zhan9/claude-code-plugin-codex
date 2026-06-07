---
name: claude-code-cancel
description: Cancel an active Claude Code job created by this Codex plugin.
---

# Claude Code Cancel

Use when the user asks to cancel a Claude Code job started by this plugin.

Do not use MCP. Cancel only plugin-created jobs.

Run:

```bash
node "${PLUGIN_ROOT}/scripts/cc-companion.mjs" cancel
```

For a specific active job, add the job id or unique prefix.
Return the companion output directly.
