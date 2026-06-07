---
name: claude-code-review
description: Ask local Claude Code to review the current Git working tree or a branch/base diff from Codex.
---

# Claude Code Review

Use when the user explicitly asks Codex to delegate code review to Claude Code.

Do not use MCP. Keep review read-only. Prefer native Claude Code review through the runtime when available; otherwise the companion uses a prompt-based fallback and marks the fallback.

Run:

```bash
node "${PLUGIN_ROOT}/scripts/cc-companion.mjs" review
```

For a base ref, add `--base <ref>`.
For model or effort, pass `--model <model>` or `--effort <level>`.
Return the companion output directly.
