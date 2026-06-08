---
name: claude-code-review
description: Ask local Claude Code to review the current Git working tree or a branch/base diff from Codex.
---

# Claude Code Review

Use when the user explicitly asks Codex to delegate code review to Claude Code.

Do not use MCP. Keep review read-only. The companion sends Claude Code a scoped review prompt with the current repository root, changed files, and diff; it does not invoke Claude Code's native `/review` slash command. When the diff is inline, the companion disables read tools for the delegated review.

Run:

```bash
node "${PLUGIN_ROOT}/scripts/cc-companion.mjs" review
```

For a base ref, add `--base <ref>`.
For model or effort, pass `--model <model>` or `--effort <level>`.
Return the companion output directly.
