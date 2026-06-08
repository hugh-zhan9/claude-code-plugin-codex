# Claude Code Plugin For Codex

Local Codex plugin that delegates selected tasks and reviews to Claude Code.

## Install

Requires Node.js 20 or newer, the `codex` CLI, and the `claude` CLI on `PATH`.

Install from npm:

```bash
npm install -g @ai-content-space/claude-code-codex
claude-code-codex install
```

`claude-code-codex install` creates a local Codex marketplace at
`~/.codex/local-marketplaces/claude-code-codex`, points that marketplace at the
installed npm package, runs `codex plugin marketplace add`, runs
`codex plugin add claude-code@claude-code-codex`, and then runs the plugin setup
check.

For local development in this repository:

```bash
npm install
npm test
node scripts/cli.mjs install --skip-setup
```

## Usage

From Codex, explicitly ask for one of these skills:

- `claude-code-setup`: check readiness.
- `claude-code-task`: delegate a task to Claude Code.
- `claude-code-review`: ask Claude Code to review the current Git change.
- `claude-code-adversarial-review`: ask Claude Code for a stricter structured review.
- `claude-code-status`: list plugin-created jobs.
- `claude-code-result`: show a stored job result.
- `claude-code-cancel`: cancel an active plugin-created job.

Direct companion commands:

```bash
claude-code-codex setup
node scripts/cc-companion.mjs setup
node scripts/cc-companion.mjs task -- "Fix the failing auth test"
node scripts/cc-companion.mjs task --background -- "Run a long investigation"
node scripts/cc-companion.mjs review --base main
node scripts/cc-companion.mjs adversarial-review -- "Focus on auth and data loss"
node scripts/cc-companion.mjs status
node scripts/cc-companion.mjs result <job-id>
node scripts/cc-companion.mjs cancel <job-id>
```

## Runtime Notes

The plugin uses Claude Agent SDK as the primary runtime. The SDK currently installs with:

```bash
npm install @anthropic-ai/claude-agent-sdk
```

`setup` checks availability and readiness. It does not install packages or log in. No MCP tools are used.
The npm install command installs package dependencies, including Claude Agent SDK.

## Permissions

- Task defaults to workspace-write.
- Review and adversarial review are read-only.
- Dangerous permission bypass is never used unless explicitly requested.

## State

Job state is stored under `CODEX_PLUGIN_DATA`, `CLAUDE_CODE_PLUGIN_CODEX_DATA`, or `/tmp/claude-code-companion`.
Only sessions created by this plugin are eligible for resume.
The workspace index keeps the 50 most recent jobs. Pruned job files and logs are removed best-effort; failed cleanup does not block saving the current index.

## Constraints

- Skill-only Codex plugin.
- No MCP tools.
- No automatic dependency install or Claude login.
