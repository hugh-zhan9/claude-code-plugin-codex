---
name: claude-code-task
description: Delegate a coding, debugging, refactoring, or analysis task from Codex to local Claude Code.
---

# Claude Code Task

Use when the user explicitly wants Claude Code to perform work from Codex.

Do not use MCP. Default to foreground execution unless the user asks for background execution. Default task permission is workspace-write. Do not use dangerous permission bypass unless the user explicitly requests it.

Run:

```bash
node "${PLUGIN_ROOT}/scripts/cc-companion.mjs" task -- <user task text>
```

For background execution, add `--background` before `--`.
For model or effort, pass `--model <model>` or `--effort <level>` before `--`.
Return the companion output directly.
