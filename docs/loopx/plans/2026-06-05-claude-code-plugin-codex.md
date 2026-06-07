# Claude Code Plugin For Codex Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use loopx:subagent-exec (recommended) or loopx:exec to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Source:** docs/loopx/design/Claude Code Plugin For Codex需求设计文档.md

**Goal:** Build a local Codex plugin named `claude-code` that delegates task and review work from Codex to Claude Code through Claude Agent SDK, with skill-only entrypoints, a shared local broker, and local job management.

**Architecture:** Codex skills are thin entrypoints that call a Node.js companion CLI. The companion owns argument parsing, local job state, rendering, and broker lifecycle; the broker owns one active Claude runtime execution per workspace. Claude execution is wrapped behind a small SDK adapter so normal tests use a fake SDK and real smoke tests remain opt-in.

**Tech Stack:** Node.js ESM `.mjs`, Codex plugin `.codex-plugin/plugin.json`, Codex skills, `@anthropic-ai/claude-agent-sdk`, local JSON state, Unix socket/Windows named pipe, `node:test`, Git CLI.

---

## Scope Check

The design covers one product surface: a local Codex plugin that delegates work to Claude Code. The broker, state, runtime wrapper, skills, and review prompts are not independently useful without each other, so this stays as one implementation plan. Each task below produces runnable or testable software and can be reviewed independently.

Out of scope for every task:

- MCP tools.
- Claude Code slash-command plugin commands inside Codex.
- Marketplace publishing.
- Deep integration with an already running Claude Code interactive TUI session.
- Scanning or taking over Claude sessions not created by this plugin.
- Default dangerous permission bypass.
- Multiple concurrent jobs or a queue.

## File Structure

Create the project at `/Users/zhangyukun/project/temp/claude-code-plugin-codex`.

```text
claude-code-plugin-codex/
  .codex-plugin/
    plugin.json
  LICENSE
  NOTICE
  README.md
  package.json
  scripts/
    cc-companion.mjs
    claude-broker.mjs
    lib/
      args.mjs
      broker-endpoint.mjs
      broker-lifecycle.mjs
      claude.mjs
      fs.mjs
      git.mjs
      job-control.mjs
      process.mjs
      prompts.mjs
      render.mjs
      state.mjs
      tracked-jobs.mjs
      workspace.mjs
  prompts/
    adversarial-review.md
    review-fallback.md
  schemas/
    review-output.schema.json
  skills/
    claude-code-adversarial-review/
      SKILL.md
    claude-code-cancel/
      SKILL.md
    claude-code-result/
      SKILL.md
    claude-code-review/
      SKILL.md
    claude-code-setup/
      SKILL.md
    claude-code-status/
      SKILL.md
    claude-code-task/
      SKILL.md
  tests/
    args.test.mjs
    broker-endpoint.test.mjs
    broker.test.mjs
    claude-runtime.test.mjs
    companion.test.mjs
    fake-claude-sdk.mjs
    git.test.mjs
    helpers.mjs
    render.test.mjs
    skills.test.mjs
    state.test.mjs
```

Responsibilities:

- `cc-companion.mjs`: CLI entrypoint for `setup`, `task`, `review`, `adversarial-review`, `status`, `result`, `cancel`, and `task-worker`.
- `claude-broker.mjs`: local JSONL broker process; serializes runtime execution and handles interrupt requests.
- `args.mjs`: deterministic CLI arg parser for companion subcommands.
- `broker-endpoint.mjs`: workspace-specific Unix socket or Windows pipe path generation.
- `broker-lifecycle.mjs`: broker session file, stale cleanup, spawn, readiness check, JSONL request client.
- `claude.mjs`: SDK import, option building, event normalization, task/review/adversarial execution.
- `fs.mjs`: JSON read/write, mkdir, atomic write, log append helpers.
- `git.mjs`: Git repo detection, default branch, review target, diff collection.
- `job-control.mjs`: active job lookup, status/result/cancel selection, background worker spawn.
- `process.mjs`: command existence and diagnostic process helpers.
- `prompts.mjs`: prompt file loading and prompt builders.
- `render.mjs`: Markdown and JSON rendering for setup/status/result/review/cancel.
- `state.mjs`: state root, workspace hash, job storage, prune.
- `tracked-jobs.mjs`: job lifecycle transitions and log updates.
- `workspace.mjs`: current workspace resolution.

## Shared Contracts

Use these shapes consistently across tasks.

```js
// Job status: "queued" | "running" | "completed" | "failed" | "cancelled"
// Job kind: "task" | "review" | "adversarial-review"
// Job phase examples: "queued", "starting", "reviewing", "editing", "verifying", "finalizing", "done", "failed", "cancelled"
```

```js
const job = {
  id: "task-m0abc123-x7f9",
  kind: "task",
  status: "queued",
  phase: "queued",
  workspaceRoot: "/absolute/workspace",
  createdAt: "2026-06-05T10:00:00.000Z",
  updatedAt: "2026-06-05T10:00:00.000Z",
  request: {
    prompt: "user prompt",
    mode: "task",
    background: false,
    model: null,
    effort: null,
    permission: "workspace-write"
  },
  result: null,
  rendered: null,
  claudeSessionId: null,
  worker: null,
  error: null,
  logFile: "/absolute/state/jobs/task-m0abc123-x7f9.log"
};
```

```js
const claudeRunResult = {
  status: "completed",
  claudeSessionId: "session-id-or-null",
  finalText: "Claude final answer",
  rawMessages: [],
  structured: null,
  parseError: null,
  fallbackUsed: false,
  interrupted: false
};
```

## Task 1: Project Scaffold, Manifest, Skills, and Test Harness

**Files:**

- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/package.json`
- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/.codex-plugin/plugin.json`
- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/LICENSE`
- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/NOTICE`
- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/README.md`
- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/skills/*/SKILL.md`
- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/tests/helpers.mjs`
- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/tests/skills.test.mjs`

- [ ] **Step 1: Create the project directory and initialize Git**

Run:

```bash
mkdir -p /Users/zhangyukun/project/temp/claude-code-plugin-codex
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
git init
```

Expected: `Initialized empty Git repository` or `Reinitialized existing Git repository`.

- [ ] **Step 2: Create the initial `package.json`**

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/package.json`:

```json
{
  "name": "claude-code-plugin-codex",
  "version": "0.1.0",
  "private": true,
  "description": "Codex plugin that delegates tasks and reviews to Claude Code.",
  "type": "module",
  "scripts": {
    "test": "node --test",
    "test:smoke": "node scripts/cc-companion.mjs setup"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^1.0.0"
  },
  "engines": {
    "node": ">=20"
  },
  "license": "Apache-2.0"
}
```

- [ ] **Step 3: Write the failing manifest and skill test**

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/tests/helpers.mjs`:

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function readText(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

export function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

export function assertFile(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  assert.equal(fs.existsSync(absolutePath), true, `${relativePath} should exist`);
  return absolutePath;
}

export function makeTempDir(prefix = "claude-code-plugin-codex-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
```

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/tests/skills.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { assertFile, readJson, readText } from "./helpers.mjs";

const skillNames = [
  "claude-code-setup",
  "claude-code-task",
  "claude-code-review",
  "claude-code-adversarial-review",
  "claude-code-status",
  "claude-code-result",
  "claude-code-cancel"
];

test("plugin manifest declares the claude-code plugin and skills folder", () => {
  const manifest = readJson(".codex-plugin/plugin.json");

  assert.equal(manifest.name, "claude-code");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.description.includes("Claude Code"), true);
  assert.deepEqual(manifest.skills, [{ path: "skills" }]);
});

test("all required skills exist and call the companion script", () => {
  for (const name of skillNames) {
    assertFile(`skills/${name}/SKILL.md`);
    const body = readText(`skills/${name}/SKILL.md`);

    assert.match(body, /^---\nname: /);
    assert.match(body, new RegExp(`name: ${name}`));
    assert.match(body, /scripts\/cc-companion\.mjs/);
    assert.match(body, /Do not use MCP/i);
  }
});
```

- [ ] **Step 4: Run the scaffold test and confirm it fails**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
npm test -- tests/skills.test.mjs
```

Expected: FAIL with `ENOENT` for `.codex-plugin/plugin.json` or missing `SKILL.md`.

- [ ] **Step 5: Create the plugin manifest**

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/.codex-plugin/plugin.json`:

```json
{
  "name": "claude-code",
  "version": "0.1.0",
  "description": "Delegate Codex tasks and reviews to local Claude Code.",
  "skills": [
    {
      "path": "skills"
    }
  ]
}
```

- [ ] **Step 6: Create the seven skill files**

Use this exact command pattern in each skill body, adjusting only the subcommand:

```bash
node "${PLUGIN_ROOT}/scripts/cc-companion.mjs" <subcommand>
```

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/skills/claude-code-setup/SKILL.md`:

```markdown
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

Return the command output directly.
```

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/skills/claude-code-task/SKILL.md`:

```markdown
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
Return the command output directly.
```

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/skills/claude-code-review/SKILL.md`:

```markdown
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
Return the command output directly.
```

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/skills/claude-code-adversarial-review/SKILL.md`:

```markdown
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
```

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/skills/claude-code-status/SKILL.md`:

```markdown
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
Return the command output directly.
```

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/skills/claude-code-result/SKILL.md`:

```markdown
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
Return the command output directly.
```

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/skills/claude-code-cancel/SKILL.md`:

```markdown
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
Return the command output directly.
```

- [ ] **Step 7: Add license, notice, and README skeleton**

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/LICENSE` with Apache-2.0 text.

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/NOTICE`:

```text
Claude Code Plugin For Codex
Copyright 2026

This project is designed to mirror selected local orchestration behavior from
openai/codex-plugin-cc, which is licensed under the Apache License 2.0.
Any reused or adapted source code must preserve the original license notices.
```

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/README.md`:

```markdown
# Claude Code Plugin For Codex

Local Codex plugin that delegates selected tasks and reviews to Claude Code.

## Install

```bash
npm install
```

## Skills

- `claude-code-setup`
- `claude-code-task`
- `claude-code-review`
- `claude-code-adversarial-review`
- `claude-code-status`
- `claude-code-result`
- `claude-code-cancel`

## Constraints

- Skill-only Codex plugin.
- No MCP tools.
- No marketplace release flow.
- No automatic dependency install or Claude login.
```

- [ ] **Step 8: Run scaffold tests**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
npm test -- tests/skills.test.mjs
```

Expected: PASS for both tests.

- [ ] **Step 9: Install dependencies**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
npm install
```

Expected: `package-lock.json` is created and `npm` exits with code 0.

- [ ] **Step 10: Commit scaffold**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
git add .
git commit -m "chore: scaffold claude-code codex plugin"
```

Expected: commit succeeds.

## Task 2: Argument Parsing, Process Diagnostics, Workspace, and File Helpers

**Files:**

- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/lib/args.mjs`
- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/lib/process.mjs`
- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/lib/workspace.mjs`
- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/lib/fs.mjs`
- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/tests/args.test.mjs`

- [ ] **Step 1: Write failing tests for CLI utility behavior**

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/tests/args.test.mjs`:

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseCompanionArgs } from "../scripts/lib/args.mjs";
import { commandExists } from "../scripts/lib/process.mjs";
import { atomicWriteJson, readJsonFile } from "../scripts/lib/fs.mjs";
import { resolveWorkspaceRoot } from "../scripts/lib/workspace.mjs";
import { makeTempDir } from "./helpers.mjs";

test("parseCompanionArgs parses task options and prompt after --", () => {
  const parsed = parseCompanionArgs(["task", "--background", "--model", "sonnet", "--effort", "high", "--", "fix auth"]);

  assert.equal(parsed.command, "task");
  assert.equal(parsed.options.background, true);
  assert.equal(parsed.options.model, "sonnet");
  assert.equal(parsed.options.effort, "high");
  assert.equal(parsed.prompt, "fix auth");
});

test("parseCompanionArgs rejects unknown flags", () => {
  assert.throws(
    () => parseCompanionArgs(["review", "--bad-flag"]),
    /Unknown option: --bad-flag/
  );
});

test("parseCompanionArgs supports status job id prefix", () => {
  const parsed = parseCompanionArgs(["status", "task-abc"]);
  assert.equal(parsed.command, "status");
  assert.equal(parsed.jobRef, "task-abc");
});

test("atomicWriteJson writes readable formatted JSON", () => {
  const dir = makeTempDir();
  const file = path.join(dir, "state.json");

  atomicWriteJson(file, { version: 1, jobs: [] });

  assert.deepEqual(readJsonFile(file), { version: 1, jobs: [] });
  assert.match(fs.readFileSync(file, "utf8"), /\n  "version": 1/);
});

test("readJsonFile returns fallback for absent files", () => {
  const dir = makeTempDir();
  assert.deepEqual(readJsonFile(path.join(dir, "missing.json"), { ok: true }), { ok: true });
});

test("resolveWorkspaceRoot returns a real absolute directory", () => {
  const root = resolveWorkspaceRoot({ cwd: "." });
  assert.equal(path.isAbsolute(root), true);
  assert.equal(fs.statSync(root).isDirectory(), true);
});

test("commandExists returns true for node and false for a generated missing command", () => {
  assert.equal(commandExists("node"), true);
  assert.equal(commandExists("missing-claude-code-plugin-codex-command"), false);
});
```

- [ ] **Step 2: Run tests and confirm missing module failure**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
npm test -- tests/args.test.mjs
```

Expected: FAIL with `Cannot find module` for `scripts/lib/args.mjs`.

- [ ] **Step 3: Implement the utility modules**

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/lib/args.mjs`. Export:

- `parseCompanionArgs(argv)`: parses argv and returns `{ command, options, prompt, jobRef }`.
- `parseBooleanFlag(options, flagName, defaultValue = false)`: returns a strict boolean value from parsed options.

Required parser behavior:

- First token is the command.
- Valid commands: `setup`, `task`, `review`, `adversarial-review`, `status`, `result`, `cancel`, `task-worker`.
- `--` terminates option parsing; the rest joins into `prompt` with spaces.
- Valid shared options: `--cwd <path>`, `--json`, `--model <model>`, `--effort <level>`.
- Valid task options: `--background`, `--write`, `--read-only`, `--resume-last`, `--fresh`, `--dangerously-bypass-permissions`.
- Valid review options: `--base <ref>`, `--scope <auto|working-tree|branch>`.
- Valid status options: `--all`, `--wait`.
- Positional argument for `status`, `result`, `cancel`, and `task-worker` is `jobRef`.
- Throw `Error("Unknown option: <flag>")` for unknown flags.
- Throw `Error("Missing value for <flag>")` when an option value is absent.

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/lib/process.mjs`. Export:

- `commandExists(command)`: uses `spawnSync(command, ["--version"], { stdio: "ignore" })` and a `PATH` lookup fallback.
- `runCommand(command, args, options = {})`: wraps `spawnSync` and returns `{ status, stdout, stderr, error }`.
- `spawnDetached(command, args, options = {})`: spawns a detached process with ignored stdin and optional stdout/stderr files.

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/lib/workspace.mjs`. Export:

- `resolveWorkspaceRoot({ cwd = process.cwd() } = {})`: returns `fs.realpathSync(path.resolve(cwd))`.
- `workspaceDisplayName(workspaceRoot)`: returns `path.basename(workspaceRoot) || "workspace"`.

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/lib/fs.mjs`. Export:

- `ensureDir(dir)`: creates the directory recursively.
- `readJsonFile(file, fallbackValue = null)`: returns fallback for absent files and throws an error including the path for invalid JSON.
- `atomicWriteJson(file, value)`: writes formatted JSON to a temp file in the same directory and renames it.
- `appendLog(file, line)`: creates the parent directory and appends `ISO_TIMESTAMP line\n`.
- `readTextFile(file, fallbackValue = "")`: returns fallback for absent files.

- [ ] **Step 4: Run utility tests**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
npm test -- tests/args.test.mjs
```

Expected: PASS for all tests in `args.test.mjs`.

- [ ] **Step 5: Run current full suite**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
npm test
```

Expected: PASS for `skills.test.mjs` and `args.test.mjs`.

- [ ] **Step 6: Commit utility modules**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
git add scripts/lib tests
git commit -m "feat: add companion utility modules"
```

Expected: commit succeeds.

## Task 3: State Storage, Job Lifecycle, and Rendering

**Files:**

- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/lib/state.mjs`
- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/lib/tracked-jobs.mjs`
- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/lib/render.mjs`
- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/tests/state.test.mjs`
- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/tests/render.test.mjs`

- [ ] **Step 1: Write failing state tests**

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/tests/state.test.mjs`:

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createJob,
  findJob,
  getWorkspaceStateDir,
  loadWorkspaceState,
  saveJob,
  saveWorkspaceState
} from "../scripts/lib/state.mjs";
import { markCompleted, markFailed, markRunning } from "../scripts/lib/tracked-jobs.mjs";
import { makeTempDir } from "./helpers.mjs";

test("getWorkspaceStateDir derives a stable directory from workspace hash", () => {
  const root = makeTempDir("workspace-");
  const stateRoot = makeTempDir("state-");

  const first = getWorkspaceStateDir(root, { stateRoot });
  const second = getWorkspaceStateDir(root, { stateRoot });

  assert.equal(first, second);
  assert.equal(first.startsWith(stateRoot), true);
  assert.match(path.basename(first), /^workspace-[a-z0-9]+-[a-f0-9]{16}$/);
});

test("createJob, saveJob, and findJob persist a job and unique prefix lookup", () => {
  const workspaceRoot = makeTempDir("workspace-");
  const stateRoot = makeTempDir("state-");
  const stateDir = getWorkspaceStateDir(workspaceRoot, { stateRoot });

  const job = createJob({
    kind: "task",
    workspaceRoot,
    request: { prompt: "fix bug", permission: "workspace-write" },
    stateDir
  });
  saveJob(job, { stateDir });

  const state = loadWorkspaceState(stateDir);
  assert.equal(state.jobs.length, 1);
  assert.equal(findJob(job.id.slice(0, 12), { stateDir }).id, job.id);
});

test("saveWorkspaceState prunes to 50 recent jobs", () => {
  const stateDir = makeTempDir("state-");
  const jobs = Array.from({ length: 55 }, (_, index) => ({
    id: `task-${String(index).padStart(2, "0")}`,
    status: "completed",
    updatedAt: new Date(2026, 0, index + 1).toISOString()
  }));

  saveWorkspaceState(stateDir, { version: 1, jobs });
  const state = loadWorkspaceState(stateDir);

  assert.equal(state.jobs.length, 50);
  assert.equal(state.jobs[0].id, "task-54");
  assert.equal(state.jobs.at(-1).id, "task-05");
});

test("tracked job helpers update status, phase, result, and error", () => {
  const now = () => "2026-06-05T10:00:00.000Z";
  const job = { id: "task-1", status: "queued", phase: "queued", updatedAt: now() };

  markRunning(job, { phase: "starting", now });
  assert.equal(job.status, "running");
  assert.equal(job.phase, "starting");

  markCompleted(job, { finalText: "done" }, { rendered: "done", now });
  assert.equal(job.status, "completed");
  assert.equal(job.phase, "done");
  assert.equal(job.result.finalText, "done");

  const failed = { id: "task-2", status: "running", phase: "starting" };
  markFailed(failed, new Error("boom"), { now });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.message, "boom");
});
```

- [ ] **Step 2: Write failing render tests**

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/tests/render.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  renderAdversarialReview,
  renderCancel,
  renderResult,
  renderSetup,
  renderStatus
} from "../scripts/lib/render.mjs";

test("renderSetup shows pass/fail checks and next steps", () => {
  const output = renderSetup({
    checks: [
      { name: "Node.js", ok: true, detail: "v20.0.0" },
      { name: "Claude Code CLI", ok: false, detail: "not found" }
    ],
    nextSteps: ["Install Claude Code CLI or configure SDK binary."]
  });

  assert.match(output, /Claude Code Plugin Setup/);
  assert.match(output, /Node\.js: OK/);
  assert.match(output, /Claude Code CLI: FAIL/);
  assert.match(output, /Install Claude Code CLI/);
});

test("renderStatus shows recent jobs", () => {
  const output = renderStatus({
    workspaceRoot: "/repo",
    jobs: [{ id: "task-1", kind: "task", status: "running", phase: "editing", updatedAt: "2026-06-05T10:00:00.000Z" }]
  });

  assert.match(output, /task-1/);
  assert.match(output, /running/);
  assert.match(output, /editing/);
});

test("renderResult includes final output and manual resume command", () => {
  const output = renderResult({
    id: "task-1",
    status: "completed",
    claudeSessionId: "claude-session-1",
    rendered: "done"
  });

  assert.match(output, /done/);
  assert.match(output, /claude --resume claude-session-1/);
});

test("renderAdversarialReview renders structured findings", () => {
  const output = renderAdversarialReview({
    verdict: "changes requested",
    summary: "Risky change.",
    findings: [{ severity: "high", file: "src/a.js", line: 10, title: "Bug", detail: "Breaks auth." }],
    next_steps: ["Fix auth path."]
  });

  assert.match(output, /changes requested/);
  assert.match(output, /src\/a\.js:10/);
  assert.match(output, /Breaks auth/);
});

test("renderCancel reports cancellation state", () => {
  assert.match(renderCancel({ id: "task-1", cancelled: true, detail: "interrupted" }), /task-1/);
});
```

- [ ] **Step 3: Run tests and confirm missing modules fail**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
npm test -- tests/state.test.mjs tests/render.test.mjs
```

Expected: FAIL with `Cannot find module` for `state.mjs` or `render.mjs`.

- [ ] **Step 4: Implement state and job lifecycle**

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/lib/state.mjs`. Export:

- `MAX_JOBS = 50`.
- `getDefaultStateRoot(env = process.env)`: checks `CODEX_PLUGIN_DATA`, then `CLAUDE_CODE_PLUGIN_CODEX_DATA`, then `path.join(os.tmpdir(), "claude-code-companion")`.
- `getWorkspaceStateDir(workspaceRoot, { stateRoot = getDefaultStateRoot() } = {})`: realpaths the workspace, combines basename and the first 16 hex chars of the sha256 hash.
- `loadWorkspaceState(stateDir)`: returns `{ version: 1, jobs: [] }` when `state.json` is absent.
- `saveWorkspaceState(stateDir, state)`: sorts jobs by `updatedAt` descending, prunes to `MAX_JOBS`, and writes `state.json`.
- `createJob({ kind, workspaceRoot, request, stateDir, now = () => new Date().toISOString() })`: returns the full job shape from Shared Contracts.
- `saveJob(job, { stateDir })`: writes `jobs/<id>.json` and updates the state job index.
- `loadJob(id, { stateDir })`: reads `jobs/<id>.json`.
- `findJob(ref, { stateDir })`: empty ref returns most recent; unique prefix matches; ambiguous prefix throws.
- `listJobs({ stateDir, all = false } = {})`: returns recent jobs from the state index.

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/lib/tracked-jobs.mjs`. Export:

- `markRunning(job, { phase = "starting", now = () => new Date().toISOString() } = {})`: mutates and returns the job with status `running`.
- `updatePhase(job, phase, { now = () => new Date().toISOString() } = {})`: mutates `phase` and `updatedAt`.
- `markCompleted(job, result, { rendered = null, now = () => new Date().toISOString() } = {})`: sets status `completed`, phase `done`, `result`, and `rendered`.
- `markFailed(job, error, { now = () => new Date().toISOString() } = {})`: sets status `failed`, phase `failed`, and `error: { message, stack }`.
- `markCancelled(job, detail = "cancelled", { now = () => new Date().toISOString() } = {})`: sets status `cancelled`, phase `cancelled`, and error detail.

- [ ] **Step 5: Implement renderers**

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/lib/render.mjs`. Export:

- `renderSetup(report)`: returns Markdown with heading, checks, and next steps.
- `renderStatus({ workspaceRoot, jobs })`: returns a Markdown table with id, kind, status, phase, and updated time.
- `renderResult(job)`: returns `job.rendered` or `job.result.finalText`; includes `claude --resume <session-id>` when `claudeSessionId` exists.
- `renderCancel({ id, cancelled, detail })`: returns a short Markdown cancellation report.
- `renderReview({ text, fallbackUsed, target })`: returns raw review text and marks fallback use when `fallbackUsed` is true.
- `renderAdversarialReview(payload)`: returns verdict, summary, findings with `file:line`, and next steps.
- `renderJson(value)`: returns `JSON.stringify(value, null, 2) + "\n"`.

- [ ] **Step 6: Run state/render tests**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
npm test -- tests/state.test.mjs tests/render.test.mjs
```

Expected: PASS for all tests.

- [ ] **Step 7: Run full suite and commit**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
npm test
git add scripts/lib tests
git commit -m "feat: add local job state and rendering"
```

Expected: tests pass and commit succeeds.

## Task 4: Git Review Context and Review Prompts

**Files:**

- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/lib/git.mjs`
- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/lib/prompts.mjs`
- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/prompts/review-fallback.md`
- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/prompts/adversarial-review.md`
- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/schemas/review-output.schema.json`
- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/tests/git.test.mjs`

- [ ] **Step 1: Write failing Git context tests**

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/tests/git.test.mjs`:

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { buildReviewContext, getDefaultBranch, isGitRepository, resolveReviewTarget } from "../scripts/lib/git.mjs";
import { buildAdversarialReviewPrompt, buildFallbackReviewPrompt } from "../scripts/lib/prompts.mjs";
import { makeTempDir } from "./helpers.mjs";

function git(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function makeRepo() {
  const repo = makeTempDir("git-review-");
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test User"]);
  fs.writeFileSync(path.join(repo, "file.txt"), "base\n");
  git(repo, ["add", "file.txt"]);
  git(repo, ["commit", "-m", "base"]);
  return repo;
}

test("isGitRepository detects Git repositories", () => {
  const repo = makeRepo();
  assert.equal(isGitRepository(repo), true);
  assert.equal(isGitRepository(makeTempDir()), false);
});

test("resolveReviewTarget chooses working tree when repo is dirty", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "file.txt"), "changed\n");

  const target = resolveReviewTarget({ workspaceRoot: repo, scope: "auto" });

  assert.equal(target.kind, "working-tree");
  assert.equal(target.baseRef, null);
});

test("resolveReviewTarget honors explicit base ref", () => {
  const repo = makeRepo();
  git(repo, ["checkout", "-b", "feature"]);
  fs.writeFileSync(path.join(repo, "file.txt"), "feature\n");
  git(repo, ["commit", "-am", "feature"]);

  const target = resolveReviewTarget({ workspaceRoot: repo, base: "master" });

  assert.equal(target.kind, "branch");
  assert.equal(target.baseRef, "master");
});

test("buildReviewContext includes diff and changed files", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "file.txt"), "changed\n");
  const target = resolveReviewTarget({ workspaceRoot: repo, scope: "auto" });

  const context = buildReviewContext({ workspaceRoot: repo, target, maxInlineBytes: 10000 });

  assert.deepEqual(context.files, ["file.txt"]);
  assert.match(context.diff, /-base/);
  assert.match(context.diff, /\+changed/);
  assert.equal(context.inline, true);
});

test("prompt builders include mode, target, and read-only constraints", () => {
  const context = { target: { kind: "working-tree", baseRef: null }, files: ["file.txt"], diff: "diff --git", inline: true };

  assert.match(buildFallbackReviewPrompt(context), /read-only/i);
  assert.match(buildFallbackReviewPrompt(context), /diff --git/);
  assert.match(buildAdversarialReviewPrompt(context, { focus: "auth" }), /JSON/);
  assert.match(buildAdversarialReviewPrompt(context, { focus: "auth" }), /auth/);
});

test("getDefaultBranch returns a branch name or null", () => {
  const repo = makeRepo();
  assert.equal(typeof getDefaultBranch(repo), "string");
});
```

- [ ] **Step 2: Run tests and confirm missing module failure**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
npm test -- tests/git.test.mjs
```

Expected: FAIL with `Cannot find module` for `scripts/lib/git.mjs`.

- [ ] **Step 3: Implement Git helpers**

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/lib/git.mjs`. Export:

- `git(workspaceRoot, args, options = {})`: runs Git in `workspaceRoot` and returns stdout.
- `isGitRepository(workspaceRoot)`: checks `git rev-parse --is-inside-work-tree`.
- `getDefaultBranch(workspaceRoot)`: resolves `origin/HEAD`, then `main`, then `master`, then current branch.
- `hasWorkingTreeChanges(workspaceRoot)`: checks `git status --porcelain`.
- `resolveReviewTarget({ workspaceRoot, base = null, scope = "auto" })`: returns `{ kind, baseRef, description }`.
- `getChangedFiles({ workspaceRoot, target })`: returns changed files for working-tree or branch target.
- `getDiff({ workspaceRoot, target })`: returns working-tree diff or `base...HEAD` diff.
- `buildReviewContext({ workspaceRoot, target, maxInlineBytes = 120000 })`: returns files, inline diff or summary, and `inline` boolean.

Required target rules:

- Explicit `base` always returns `{ kind: "branch", baseRef: base }`.
- Explicit `scope: "working-tree"` returns working-tree.
- Explicit `scope: "branch"` uses explicit base or default branch.
- Auto uses working tree when dirty; otherwise branch diff against default branch.
- Throw `Error("Not a Git repository: <path>")` when review runs outside Git.
- Throw `Error("Could not determine a base branch. Pass --base <ref>.")` when branch target lacks base.

- [ ] **Step 4: Create prompt templates and schema**

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/prompts/review-fallback.md`:

```markdown
You are Claude Code running a read-only code review delegated from Codex.

Review the target change for bugs, regressions, missing tests, security issues, and maintainability risks. Do not modify files. Lead with findings. Include file and line references when available. If there are no findings, say that clearly and mention any residual risk.

Target:
{{target}}

Changed files:
{{files}}

Diff:
{{diff}}
```

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/prompts/adversarial-review.md`:

```markdown
You are Claude Code running an adversarial read-only review delegated from Codex.

Challenge the change. Prefer concrete findings over style opinions. Do not modify files.

Return one JSON object with this shape:

{
  "verdict": "approved | changes requested | blocked",
  "summary": "short summary",
  "findings": [
    {
      "severity": "critical | high | medium | low",
      "file": "relative/path",
      "line": 1,
      "title": "short title",
      "detail": "why this matters"
    }
  ],
  "next_steps": ["concrete next step"]
}

Focus:
{{focus}}

Target:
{{target}}

Changed files:
{{files}}

Diff:
{{diff}}
```

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/schemas/review-output.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Claude Code Adversarial Review Output",
  "type": "object",
  "required": ["verdict", "summary", "findings", "next_steps"],
  "properties": {
    "verdict": { "type": "string" },
    "summary": { "type": "string" },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["severity", "file", "line", "title", "detail"],
        "properties": {
          "severity": { "type": "string" },
          "file": { "type": "string" },
          "line": { "type": "number" },
          "title": { "type": "string" },
          "detail": { "type": "string" }
        }
      }
    },
    "next_steps": {
      "type": "array",
      "items": { "type": "string" }
    }
  }
}
```

- [ ] **Step 5: Implement prompt builders**

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/lib/prompts.mjs`. Export:

- `loadPromptTemplate(name)`: reads `prompts/<name>.md` relative to the repository root.
- `renderTemplate(template, values)`: replaces `{{key}}` tokens with string values.
- `buildFallbackReviewPrompt(context)`: renders `review-fallback.md`.
- `buildAdversarialReviewPrompt(context, { focus = "" } = {})`: renders `adversarial-review.md`.
- `buildTaskPrompt(prompt)`: returns `String(prompt || "").trim()`.

- [ ] **Step 6: Run Git/prompt tests**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
npm test -- tests/git.test.mjs
```

Expected: PASS for all tests in `git.test.mjs`.

- [ ] **Step 7: Run full suite and commit**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
npm test
git add scripts/lib prompts schemas tests
git commit -m "feat: add git review context and prompts"
```

Expected: tests pass and commit succeeds.

## Task 5: Claude Agent SDK Runtime Wrapper

**Files:**

- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/lib/claude.mjs`
- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/tests/fake-claude-sdk.mjs`
- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/tests/claude-runtime.test.mjs`

- [ ] **Step 1: Write fake SDK fixture**

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/tests/fake-claude-sdk.mjs`:

```js
export function createFakeClaudeSdk({ messages = [], onQuery = null } = {}) {
  const calls = [];

  return {
    calls,
    query({ prompt, options }) {
      calls.push({ prompt, options });
      if (onQuery) onQuery({ prompt, options });

      return (async function* stream() {
        for (const message of messages) {
          yield message;
        }
      })();
    }
  };
}

export const taskMessages = [
  { type: "system", subtype: "init", session_id: "claude-session-task" },
  { type: "assistant", message: { content: [{ type: "text", text: "I fixed the bug." }] } },
  { type: "result", subtype: "success", result: "I fixed the bug.", session_id: "claude-session-task" }
];

export const reviewMessages = [
  { type: "system", subtype: "init", session_id: "claude-session-review" },
  { type: "result", subtype: "success", result: "No findings.", session_id: "claude-session-review" }
];
```

- [ ] **Step 2: Write failing Claude runtime tests**

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/tests/claude-runtime.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildClaudeOptions,
  extractJsonObject,
  runAdversarialReview,
  runClaudeTask,
  runFallbackReview,
  runNativeReview
} from "../scripts/lib/claude.mjs";
import { createFakeClaudeSdk, reviewMessages, taskMessages } from "./fake-claude-sdk.mjs";

test("buildClaudeOptions maps task permission to allowed editing tools", () => {
  const options = buildClaudeOptions({
    cwd: "/repo",
    model: "sonnet",
    effort: "high",
    permission: "workspace-write"
  });

  assert.equal(options.cwd, "/repo");
  assert.equal(options.model, "sonnet");
  assert.equal(options.permissionMode, "acceptEdits");
  assert.equal(options.allowDangerouslySkipPermissions, false);
  assert.equal(options.allowedTools.includes("Read"), true);
  assert.equal(options.allowedTools.includes("Edit"), true);
});

test("buildClaudeOptions maps review permission to read-only tools", () => {
  const options = buildClaudeOptions({ cwd: "/repo", permission: "read-only" });

  assert.equal(options.allowedTools.includes("Read"), true);
  assert.equal(options.allowedTools.includes("Grep"), true);
  assert.equal(options.allowedTools.includes("Edit"), false);
  assert.equal(options.allowedTools.includes("Write"), false);
});

test("runClaudeTask returns final text and session id", async () => {
  const sdk = createFakeClaudeSdk({ messages: taskMessages });

  const result = await runClaudeTask({
    sdk,
    prompt: "fix bug",
    cwd: "/repo",
    permission: "workspace-write"
  });

  assert.equal(result.status, "completed");
  assert.equal(result.finalText, "I fixed the bug.");
  assert.equal(result.claudeSessionId, "claude-session-task");
  assert.equal(sdk.calls[0].prompt, "fix bug");
});

test("runFallbackReview returns fallback marker and read-only options", async () => {
  const sdk = createFakeClaudeSdk({ messages: reviewMessages });

  const result = await runFallbackReview({
    sdk,
    prompt: "review diff",
    cwd: "/repo"
  });

  assert.equal(result.fallbackUsed, true);
  assert.equal(result.finalText, "No findings.");
  assert.equal(sdk.calls[0].options.allowedTools.includes("Edit"), false);
});

test("runNativeReview uses slash command prompt and marks non-fallback success", async () => {
  const sdk = createFakeClaudeSdk({ messages: reviewMessages });

  const result = await runNativeReview({
    sdk,
    cwd: "/repo",
    context: { target: { description: "working tree" } }
  });

  assert.equal(result.fallbackUsed, false);
  assert.match(sdk.calls[0].prompt, /^\/review/);
});

test("extractJsonObject parses the first JSON object from model text", () => {
  const parsed = extractJsonObject('prefix {"verdict":"approved","summary":"ok","findings":[],"next_steps":[]} suffix');

  assert.equal(parsed.verdict, "approved");
});

test("runAdversarialReview parses structured JSON and records parse errors", async () => {
  const sdk = createFakeClaudeSdk({
    messages: [
      { type: "system", subtype: "init", session_id: "claude-session-adv" },
      { type: "result", subtype: "success", result: '{"verdict":"changes requested","summary":"risk","findings":[],"next_steps":["fix"]}' }
    ]
  });

  const result = await runAdversarialReview({ sdk, prompt: "json review", cwd: "/repo" });

  assert.equal(result.structured.verdict, "changes requested");
  assert.equal(result.parseError, null);
});
```

- [ ] **Step 3: Run tests and confirm missing runtime failure**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
npm test -- tests/claude-runtime.test.mjs
```

Expected: FAIL with `Cannot find module` for `scripts/lib/claude.mjs`.

- [ ] **Step 4: Implement SDK runtime wrapper**

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/lib/claude.mjs`. Export:

- `importClaudeSdk()`: dynamically imports `@anthropic-ai/claude-agent-sdk`.
- `buildClaudeOptions({ cwd, model = null, effort = null, permission = "read-only", resumeSessionId = null, abortController = null, dangerouslyBypassPermissions = false } = {})`: returns SDK options.
- `collectClaudeMessages(queryResult, { onProgress = null } = {})`: async-iterates SDK messages and calls progress callback.
- `normalizeClaudeResult(messages, { fallbackUsed = false, interrupted = false } = {})`: returns the `claudeRunResult` shape from Shared Contracts.
- `runClaudeTask({ sdk, prompt, cwd, model, effort, permission = "workspace-write", resumeSessionId = null, dangerouslyBypassPermissions = false, onProgress = null, abortController = null })`: calls `sdk.query`.
- `runNativeReview({ sdk, cwd, context, model, effort, onProgress = null, abortController = null })`: calls `sdk.query` with a prompt starting with `/review`.
- `runFallbackReview({ sdk, prompt, cwd, model, effort, onProgress = null, abortController = null })`: calls `sdk.query` in read-only mode and marks fallback.
- `runAdversarialReview({ sdk, prompt, cwd, model, effort, onProgress = null, abortController = null })`: calls `sdk.query` in read-only mode and parses structured JSON.
- `extractJsonObject(text)`: parses the first balanced JSON object from model text.

Required option mapping:

- `permission: "read-only"` -> `tools` and `allowedTools` limited to `["Read", "Grep", "Glob", "LS"]`; disallow `Bash`, `Edit`, `MultiEdit`, and `Write` when SDK supports `disallowedTools`.
- `permission: "workspace-write"` -> include read tools and `Edit`, `MultiEdit`, `Write`, `Bash`.
- `dangerouslyBypassPermissions: true` -> `permissionMode: "bypassPermissions"` and `allowDangerouslySkipPermissions: true`.
- Normal workspace-write -> `permissionMode: "acceptEdits"`.
- Read-only -> `permissionMode: "default"`.
- Include `cwd`, `model`, and `effort` only when provided.
- Include `resume`/session option only if SDK supports it; the implementation must isolate the exact field in this wrapper.

Required message normalization:

- Capture `session_id`, `sessionId`, or nested session id fields.
- Prefer `result` message text for final output.
- Fall back to last assistant text.
- Preserve raw messages in `rawMessages`.
- Errors throw or return `{ status: "failed", finalText: "", error }` consistently; CLI layer turns failures into failed jobs.

- [ ] **Step 5: Run Claude runtime tests**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
npm test -- tests/claude-runtime.test.mjs
```

Expected: PASS for all tests in `claude-runtime.test.mjs`.

- [ ] **Step 6: Verify package import diagnostics without calling Claude**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
node -e "import('@anthropic-ai/claude-agent-sdk').then(() => console.log('sdk import ok'))"
```

Expected: `sdk import ok`. If optional native binary is missing, the import should still be diagnosed in `setup`; do not call a real query in this step.

- [ ] **Step 7: Run full suite and commit**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
npm test
git add scripts/lib tests package.json package-lock.json
git commit -m "feat: wrap claude agent sdk runtime"
```

Expected: tests pass and commit succeeds.

## Task 6: Broker Endpoint, Lifecycle, Server, and Busy Semantics

**Files:**

- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/lib/broker-endpoint.mjs`
- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/lib/broker-lifecycle.mjs`
- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/claude-broker.mjs`
- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/tests/broker-endpoint.test.mjs`
- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/tests/broker.test.mjs`

- [ ] **Step 1: Write failing broker endpoint tests**

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/tests/broker-endpoint.test.mjs`:

```js
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { getBrokerEndpoint, getBrokerSessionFile } from "../scripts/lib/broker-endpoint.mjs";
import { makeTempDir } from "./helpers.mjs";

test("getBrokerEndpoint returns a Unix socket path on POSIX", () => {
  const stateDir = makeTempDir("broker-state-");
  const endpoint = getBrokerEndpoint({ stateDir, platform: "darwin" });

  assert.equal(endpoint.startsWith(stateDir), true);
  assert.match(path.basename(endpoint), /^broker-[a-f0-9]+\.sock$/);
});

test("getBrokerEndpoint returns a Windows named pipe path on win32", () => {
  const endpoint = getBrokerEndpoint({ stateDir: "C:\\temp\\state", platform: "win32" });

  assert.match(endpoint, /^\\\\\.\\pipe\\claude-code-plugin-codex-/);
});

test("getBrokerSessionFile is stored in the workspace state directory", () => {
  const stateDir = makeTempDir("broker-state-");
  assert.equal(getBrokerSessionFile(stateDir), path.join(stateDir, "broker.json"));
});
```

- [ ] **Step 2: Write failing broker behavior tests**

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/tests/broker.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  createBrokerState,
  handleBrokerRequest
} from "../scripts/claude-broker.mjs";

test("broker run request returns runtime result", async () => {
  const state = createBrokerState({
    runtime: {
      async run(request) {
        return { status: "completed", finalText: `done ${request.params.kind}`, claudeSessionId: "session-1" };
      },
      async interrupt() {
        return { interrupted: true };
      }
    }
  });

  const response = await handleBrokerRequest(state, {
    id: "1",
    method: "run",
    params: { jobId: "task-1", kind: "task" }
  });

  assert.equal(response.id, "1");
  assert.equal(response.result.finalText, "done task");
});

test("broker rejects second run while active", async () => {
  let release;
  const firstRun = new Promise((resolve) => {
    release = resolve;
  });
  const state = createBrokerState({
    runtime: {
      async run() {
        await firstRun;
        return { status: "completed", finalText: "done" };
      },
      async interrupt() {
        release();
        return { interrupted: true };
      }
    }
  });

  const first = handleBrokerRequest(state, { id: "1", method: "run", params: { jobId: "task-1", kind: "task" } });
  const second = await handleBrokerRequest(state, { id: "2", method: "run", params: { jobId: "task-2", kind: "task" } });

  assert.equal(second.error.code, "BUSY");
  release();
  await first;
});

test("broker interrupt cancels active runtime", async () => {
  let interrupted = false;
  const state = createBrokerState({
    runtime: {
      async run() {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { status: interrupted ? "cancelled" : "completed", finalText: "" };
      },
      async interrupt() {
        interrupted = true;
        return { interrupted: true };
      }
    }
  });

  const running = handleBrokerRequest(state, { id: "1", method: "run", params: { jobId: "task-1", kind: "task" } });
  const interrupt = await handleBrokerRequest(state, { id: "2", method: "interrupt", params: { jobId: "task-1" } });

  assert.equal(interrupt.result.interrupted, true);
  await running;
});
```

- [ ] **Step 3: Run tests and confirm missing broker failure**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
npm test -- tests/broker-endpoint.test.mjs tests/broker.test.mjs
```

Expected: FAIL with `Cannot find module` for broker modules.

- [ ] **Step 4: Implement broker endpoint helpers**

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/lib/broker-endpoint.mjs`. Export:

- `getBrokerSessionFile(stateDir)`: returns `path.join(stateDir, "broker.json")`.
- `getBrokerEndpoint({ stateDir, platform = process.platform } = {})`: returns a POSIX socket path or Windows named pipe.
- `getBrokerLogFile(stateDir)`: returns `path.join(stateDir, "broker.log")`.

POSIX endpoint rule: `path.join(stateDir, "broker-" + sha256(stateDir).slice(0, 12) + ".sock")`.

Windows endpoint rule: `\\\\.\\pipe\\claude-code-plugin-codex-` plus sha256 of `stateDir`.

- [ ] **Step 5: Implement broker server testable core**

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/claude-broker.mjs`. Export:

- `createBrokerState({ runtime })`: returns `{ active: null, runtime }`.
- `handleBrokerRequest(state, request)`: returns JSON-RPC-like `{ id, result }` or `{ id, error }`.
- `startBrokerServer({ endpoint, runtime, logFile })`: starts a `net` server with a JSONL request/response protocol.

Required request behavior:

- `method: "run"`:
  - If `state.active` is non-null, return `{ error: { code: "BUSY", message: "A Claude Code job is already running in this workspace." } }`.
  - Set `state.active = { jobId, startedAt }`.
  - Await `runtime.run(request)`.
  - Clear active in `finally`.
- `method: "interrupt"`:
  - If no active job, return `{ result: { interrupted: false, detail: "No active job." } }`.
  - If `params.jobId` is present and does not match active job id, return `{ error: { code: "NOT_ACTIVE", message: "Job is not active." } }`.
  - Call `runtime.interrupt(params)`.
- `method: "shutdown"`:
  - Return `{ result: { shuttingDown: true } }` and close server in the server wrapper.

- [ ] **Step 6: Implement lifecycle client**

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/lib/broker-lifecycle.mjs`. Export:

- `loadBrokerSession(stateDir)`: reads `broker.json`.
- `saveBrokerSession(stateDir, session)`: writes session JSON atomically.
- `isBrokerReachable(endpoint, timeoutMs = 250)`: connects and closes.
- `requestBroker(endpoint, request, timeoutMs = 30000)`: sends one JSONL request and resolves one response.
- `ensureBroker({ stateDir, workspaceRoot, nodePath = process.execPath } = {})`: reuses a reachable broker or spawns one detached.
- `cleanupStaleBroker(stateDir)`: removes stale `broker.json` and stale POSIX socket when safe.

Use `scripts/claude-broker.mjs --endpoint <endpoint> --workspace <workspaceRoot> --state-dir <stateDir>` as the spawned broker command.

- [ ] **Step 7: Run broker tests**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
npm test -- tests/broker-endpoint.test.mjs tests/broker.test.mjs
```

Expected: PASS for broker endpoint and broker core tests.

- [ ] **Step 8: Run full suite and commit**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
npm test
git add scripts tests
git commit -m "feat: add local claude broker"
```

Expected: tests pass and commit succeeds.

## Task 7: Companion CLI Setup, Foreground Task, and Review Commands

**Files:**

- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/cc-companion.mjs`
- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/tests/companion.test.mjs`
- Modify: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/lib/render.mjs`
- Modify: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/lib/claude.mjs`

- [ ] **Step 1: Write failing companion command tests**

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/tests/companion.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  runCompanion
} from "../scripts/cc-companion.mjs";
import { createFakeClaudeSdk, reviewMessages, taskMessages } from "./fake-claude-sdk.mjs";
import { makeTempDir } from "./helpers.mjs";

test("setup returns readiness report without installing or logging in", async () => {
  const output = await runCompanion(["setup", "--json"], {
    cwd: makeTempDir(),
    env: {},
    diagnostics: {
      nodeVersion: "v20.0.0",
      hasClaudeCli: true,
      sdkImportOk: true,
      claudeReady: true
    }
  });

  const report = JSON.parse(output);
  assert.equal(report.checks.find((check) => check.name === "Node.js").ok, true);
  assert.equal(report.checks.find((check) => check.name === "Claude Code CLI").ok, true);
});

test("task foreground runs Claude and stores completed job", async () => {
  const stateRoot = makeTempDir("state-");
  const sdk = createFakeClaudeSdk({ messages: taskMessages });

  const output = await runCompanion(["task", "--", "fix bug"], {
    cwd: makeTempDir("workspace-"),
    env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: stateRoot },
    sdk
  });

  assert.match(output, /I fixed the bug/);
  assert.equal(sdk.calls[0].options.permissionMode, "acceptEdits");
});

test("review foreground uses native review and read-only permission", async () => {
  const workspace = makeTempDir("workspace-");
  const sdk = createFakeClaudeSdk({ messages: reviewMessages });

  const output = await runCompanion(["review"], {
    cwd: workspace,
    env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: makeTempDir("state-") },
    sdk,
    reviewContext: {
      target: { kind: "working-tree", description: "working tree", baseRef: null },
      files: ["file.txt"],
      diff: "diff --git",
      inline: true
    }
  });

  assert.match(output, /No findings/);
  assert.equal(sdk.calls[0].options.allowedTools.includes("Edit"), false);
});
```

- [ ] **Step 2: Run companion tests and confirm missing companion failure**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
npm test -- tests/companion.test.mjs
```

Expected: FAIL with `Cannot find module` or missing `runCompanion`.

- [ ] **Step 3: Implement companion command dispatcher**

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/cc-companion.mjs`. Export:

- `runCompanion(argv = process.argv.slice(2), deps = {})`: returns the stdout string for the requested command.
- `main(argv = process.argv.slice(2))`: writes stdout, handles stderr, and sets process exit code.

Required dispatcher behavior:

- Parse with `parseCompanionArgs`.
- Resolve workspace root with `resolveWorkspaceRoot`.
- Resolve state dir with `getWorkspaceStateDir`.
- `setup`:
  - Check Node version from `process.version`.
  - Check `claude` CLI with `commandExists("claude")`.
  - Check SDK import with `importClaudeSdk`.
  - Do not run a real SDK query unless a non-test diagnostic hook explicitly does so.
  - Render Markdown or JSON.
- `task` foreground:
  - Require non-empty prompt unless resume mode is active.
  - Create job.
  - Mark running.
  - Call `runClaudeTask`.
  - Store completed or failed job.
  - Return raw final text for completed task.
- `review`:
  - Build or accept injected review context.
  - Call `runNativeReview`.
  - If it throws an unsupported native-review error, build fallback prompt and call `runFallbackReview`.
  - Store raw output and fallback marker.
  - Render review text.
- `adversarial-review`:
  - Build review context and adversarial prompt.
  - Call `runAdversarialReview`.
  - Store raw output, structured output, and parse error.
  - Render structured output when parse succeeds; render raw text and parse error when parsing fails.

- [ ] **Step 4: Add CLI invocation guard**

At the bottom of `cc-companion.mjs`, run `main()` only when the file is executed directly:

```js
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}
```

- [ ] **Step 5: Run companion tests**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
npm test -- tests/companion.test.mjs
```

Expected: PASS for companion setup/task/review tests.

- [ ] **Step 6: Run real setup command**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
node scripts/cc-companion.mjs setup
```

Expected: Markdown headed `Claude Code Plugin Setup`. It may report Claude auth or SDK binary issues; that is acceptable if next steps are explicit and the command exits normally.

- [ ] **Step 7: Run full suite and commit**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
npm test
git add scripts tests
git commit -m "feat: add companion foreground commands"
```

Expected: tests pass and commit succeeds.

## Task 8: Background Jobs, Status, Result, Cancel, and Resume

**Files:**

- Create: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/lib/job-control.mjs`
- Modify: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/cc-companion.mjs`
- Modify: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/lib/state.mjs`
- Modify: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/lib/render.mjs`
- Modify: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/tests/companion.test.mjs`

- [ ] **Step 1: Extend companion tests for background and job queries**

Append to `/Users/zhangyukun/project/temp/claude-code-plugin-codex/tests/companion.test.mjs`:

```js
test("background task creates queued job and status/result can find it", async () => {
  const stateRoot = makeTempDir("state-");
  const workspace = makeTempDir("workspace-");
  const output = await runCompanion(["task", "--background", "--", "long task"], {
    cwd: workspace,
    env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: stateRoot },
    backgroundRunner: {
      spawnWorker(job) {
        return { pid: 12345, command: `worker ${job.id}` };
      }
    }
  });

  assert.match(output, /queued/i);
  const id = output.match(/(task-[a-z0-9-]+)/)[1];

  const status = await runCompanion(["status", id], {
    cwd: workspace,
    env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: stateRoot }
  });

  assert.match(status, new RegExp(id));
  assert.match(status, /queued/);
});

test("result for completed job includes stored final answer and resume command", async () => {
  const stateRoot = makeTempDir("state-");
  const workspace = makeTempDir("workspace-");
  const sdk = createFakeClaudeSdk({ messages: taskMessages });
  await runCompanion(["task", "--", "fix bug"], {
    cwd: workspace,
    env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: stateRoot },
    sdk
  });

  const result = await runCompanion(["result"], {
    cwd: workspace,
    env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: stateRoot }
  });

  assert.match(result, /I fixed the bug/);
  assert.match(result, /claude --resume claude-session-task/);
});

test("cancel marks queued job cancelled without touching external Claude sessions", async () => {
  const stateRoot = makeTempDir("state-");
  const workspace = makeTempDir("workspace-");
  const queued = await runCompanion(["task", "--background", "--", "long task"], {
    cwd: workspace,
    env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: stateRoot },
    backgroundRunner: {
      spawnWorker(job) {
        return { pid: 12345, command: `worker ${job.id}` };
      }
    }
  });
  const id = queued.match(/(task-[a-z0-9-]+)/)[1];

  const cancel = await runCompanion(["cancel", id], {
    cwd: workspace,
    env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: stateRoot },
    brokerClient: {
      async interrupt() {
        return { interrupted: false, detail: "No active job." };
      }
    }
  });

  assert.match(cancel, /cancelled/i);
});
```

- [ ] **Step 2: Run tests and confirm new behavior fails**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
npm test -- tests/companion.test.mjs
```

Expected: FAIL because background/status/result/cancel paths are not wired.

- [ ] **Step 3: Implement job control helpers**

Create `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/lib/job-control.mjs`. Export:

- `chooseRecentRunnableSession(jobs)`: returns the most recent completed task with `claudeSessionId`.
- `renderBackgroundQueued(job)`: returns job id, queued status, and status/result commands.
- `spawnTaskWorker({ job, companionPath, cwd, env })`: spawns detached `node cc-companion.mjs task-worker <job.id>`.
- `cancelJob({ job, stateDir, brokerClient = null })`: moves queued jobs to cancelled; for running jobs asks broker to interrupt and then marks cancelled.
- `assertCanResume({ jobs, activeJob })`: throws if an active job exists; otherwise returns a plugin-created session id.

Required rules:

- Resume only uses completed plugin-created task jobs with `claudeSessionId`.
- If any job has `status: "running"`, resume throws `Error("A Claude Code job is already running. Cancel it or wait before resuming.")`.
- `cancelJob` does not inspect external Claude sessions.
- `spawnTaskWorker` records PID and command on `job.worker`.

- [ ] **Step 4: Wire background and query commands in companion**

Modify `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/cc-companion.mjs`:

- `task --background` creates queued job, saves it, spawns worker, saves worker PID, and returns background report.
- `task-worker <job-id>` loads the queued job, marks running, calls the same foreground runtime path, then marks completed/failed/cancelled.
- `status [jobRef]` renders one job or recent jobs.
- `result [jobRef]` renders a completed/failed/cancelled job; for running/queued it tells the user to run status later.
- `cancel [jobRef]` resolves active or referenced job and calls `cancelJob`.
- `task --resume-last -- <prompt>` finds the most recent plugin-created Claude session id and calls `runClaudeTask` with resume option.

- [ ] **Step 5: Run companion job tests**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
npm test -- tests/companion.test.mjs
```

Expected: PASS for foreground, background, status, result, and cancel tests.

- [ ] **Step 6: Run full suite and commit**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
npm test
git add scripts tests
git commit -m "feat: add background job controls"
```

Expected: tests pass and commit succeeds.

## Task 9: Broker Integration in Companion

**Files:**

- Modify: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/cc-companion.mjs`
- Modify: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/claude-broker.mjs`
- Modify: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/lib/broker-lifecycle.mjs`
- Modify: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/tests/companion.test.mjs`
- Modify: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/tests/broker.test.mjs`

- [ ] **Step 1: Add tests proving companion routes execution through broker by default**

Append to `/Users/zhangyukun/project/temp/claude-code-plugin-codex/tests/companion.test.mjs`:

```js
test("task uses broker client when provided", async () => {
  const calls = [];
  const output = await runCompanion(["task", "--", "fix bug"], {
    cwd: makeTempDir("workspace-"),
    env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: makeTempDir("state-") },
    brokerClient: {
      async run(request) {
        calls.push(request);
        return {
          status: "completed",
          claudeSessionId: "broker-session",
          finalText: "broker result",
          rawMessages: [],
          fallbackUsed: false
        };
      }
    }
  });

  assert.match(output, /broker result/);
  assert.equal(calls[0].kind, "task");
});

test("broker busy is rendered as a clear user-facing error", async () => {
  await assert.rejects(
    () => runCompanion(["task", "--", "fix bug"], {
      cwd: makeTempDir("workspace-"),
      env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: makeTempDir("state-") },
      brokerClient: {
        async run() {
          const error = new Error("A Claude Code job is already running in this workspace.");
          error.code = "BUSY";
          throw error;
        }
      }
    }),
    /already running/
  );
});
```

- [ ] **Step 2: Run tests and confirm broker integration fails**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
npm test -- tests/companion.test.mjs
```

Expected: FAIL because companion still calls runtime directly or does not translate broker busy.

- [ ] **Step 3: Wire companion to broker lifecycle**

Modify `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/cc-companion.mjs`:

- For execution commands, use injected `brokerClient` in tests.
- In normal runtime, call `ensureBroker({ stateDir, workspaceRoot })`, then `requestBroker(endpoint, { method: "run", params })`.
- Fall back to direct runtime only when `deps.disableBroker === true` in tests; production path uses broker.
- Convert broker `BUSY` into `Error("A Claude Code job is already running in this workspace. Run claude-code-status or claude-code-cancel.")`.

- [ ] **Step 4: Wire broker server to real runtime**

Modify `/Users/zhangyukun/project/temp/claude-code-plugin-codex/scripts/claude-broker.mjs`:

- Parse `--endpoint`, `--workspace`, and `--state-dir`.
- Import SDK with `importClaudeSdk`.
- Build runtime object with `run(request)` dispatching to:
  - `runClaudeTask`
  - `runNativeReview`
  - `runFallbackReview`
  - `runAdversarialReview`
- Use an `AbortController` for the active run and call `abortController.abort()` in `interrupt`.
- Append broker events to broker log.

- [ ] **Step 5: Run broker and companion tests**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
npm test -- tests/broker.test.mjs tests/companion.test.mjs
```

Expected: PASS for broker and companion tests.

- [ ] **Step 6: Run real setup and verify broker status line**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
node scripts/cc-companion.mjs setup
```

Expected: setup output includes a broker check. It may say broker is not running or ready; it must not start a real Claude task.

- [ ] **Step 7: Run full suite and commit**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
npm test
git add scripts tests
git commit -m "feat: route companion execution through broker"
```

Expected: tests pass and commit succeeds.

## Task 10: Final Skill Documentation, README, and Local Smoke Checks

**Files:**

- Modify: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/README.md`
- Modify: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/skills/*/SKILL.md`
- Modify: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/NOTICE`
- Modify: `/Users/zhangyukun/project/temp/claude-code-plugin-codex/tests/skills.test.mjs`

- [ ] **Step 1: Strengthen README with exact usage commands**

Update `/Users/zhangyukun/project/temp/claude-code-plugin-codex/README.md` to include:

```markdown
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

`setup` checks availability and readiness. It does not install packages or log in.

## Permissions

- Task defaults to workspace-write.
- Review and adversarial review are read-only.
- Dangerous permission bypass is never used unless explicitly requested.

## State

Job state is stored under `CODEX_PLUGIN_DATA`, `CLAUDE_CODE_PLUGIN_CODEX_DATA`, or `/tmp/claude-code-companion`.
Only sessions created by this plugin are eligible for resume.
```

- [ ] **Step 2: Add exact command examples to each skill**

Ensure every `skills/*/SKILL.md` includes:

- A direct `node "${PLUGIN_ROOT}/scripts/cc-companion.mjs" ...` command.
- The sentence `Do not use MCP.`
- A sentence saying to return companion output directly.
- For task/review skills, the correct permission statement.

- [ ] **Step 3: Extend skill tests for README and constraints**

Append to `/Users/zhangyukun/project/temp/claude-code-plugin-codex/tests/skills.test.mjs`:

```js
test("README documents direct commands, permissions, state, and no MCP", () => {
  const body = readText("README.md");

  assert.match(body, /node scripts\/cc-companion\.mjs setup/);
  assert.match(body, /workspace-write/);
  assert.match(body, /read-only/);
  assert.match(body, /CLAUDE_CODE_PLUGIN_CODEX_DATA/);
  assert.match(body, /No MCP/i);
});
```

- [ ] **Step 4: Run documentation tests**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
npm test -- tests/skills.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Run full test suite**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
npm test
```

Expected: PASS for all test files.

- [ ] **Step 6: Run no-real-Claude smoke checks**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
node scripts/cc-companion.mjs setup --json
node scripts/cc-companion.mjs status
node scripts/cc-companion.mjs result || true
```

Expected:

- `setup --json` prints valid JSON.
- `status` prints a job table or "No Claude Code jobs".
- `result` without jobs prints a clear error and exits non-zero; the `|| true` keeps the smoke script moving.

- [ ] **Step 7: Run optional real Claude smoke test**

Only run this when the user accepts consuming Claude Agent SDK usage:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
node scripts/cc-companion.mjs task --read-only -- "Inspect this repository and reply with one sentence describing it."
```

Expected: Claude returns one sentence, a completed job is stored, and `node scripts/cc-companion.mjs result` shows the same result with a `claude --resume <session-id>` command when the SDK emits a session id.

- [ ] **Step 8: Commit final docs and smoke readiness**

Run:

```bash
cd /Users/zhangyukun/project/temp/claude-code-plugin-codex
git add README.md NOTICE skills tests
git commit -m "docs: document claude-code codex plugin usage"
```

Expected: commit succeeds.

## Final Verification

Run from `/Users/zhangyukun/project/temp/claude-code-plugin-codex`:

```bash
npm test
node scripts/cc-companion.mjs setup
git status --short
```

Expected:

- `npm test` passes.
- `setup` prints readiness and next steps without starting a real task.
- `git status --short` is clean after the final commit.

## Coverage Checklist

- Plugin project path: Task 1.
- Plugin manifest name `claude-code`: Task 1.
- Skill-only entrypoints: Tasks 1 and 10.
- No MCP: Tasks 1 and 10.
- Claude Agent SDK primary runtime: Task 5.
- `claude -p` not used as primary runtime: Tasks 5 and 10.
- Setup checks without auto-install or auto-login: Task 7.
- Foreground task default: Task 7.
- Background task/status/result/cancel: Task 8.
- Shared broker with busy semantics: Tasks 6 and 9.
- Review target selection: Task 4.
- Native review preferred with prompt fallback: Tasks 5 and 7.
- Adversarial structured review: Tasks 4, 5, and 7.
- Local state with max 50 jobs: Task 3.
- Resume only plugin-created sessions: Task 8.
- Windows named pipe path support tests: Task 6.
- License/notice for adapted Apache-2.0 code: Tasks 1 and 10.
