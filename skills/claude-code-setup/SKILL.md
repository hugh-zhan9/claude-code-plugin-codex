---
name: claude-code-setup
description: Check whether the local Claude Code delegation plugin is installed, configured, authenticated, and ready.
---

# Claude Code Setup

Use when the user asks to check Claude Code plugin readiness from Codex.

Do not use MCP. Do not auto-install dependencies. Do not auto-login.

Run:

```bash
node "${PLUGIN_ROOT}/scripts/cc-companion.mjs" setup
```

Return the companion output directly.
