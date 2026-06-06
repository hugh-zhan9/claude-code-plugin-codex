---
name: claude-code-adversarial-review
description: Ask local Claude Code for a stricter adversarial review of the current Git change.
---

# Claude Code Adversarial Review

Use when the user wants a skeptical or adversarial Claude Code review from Codex.

Do not use MCP. Keep review read-only. The companion asks Claude Code for structured findings and renders them.

Run:

```bash
node "${PLUGIN_ROOT}/scripts/cc-companion.mjs" adversarial-review -- <optional review focus>
```

For a base ref, add `--base <ref>` before `--`.
Return the command output directly.
