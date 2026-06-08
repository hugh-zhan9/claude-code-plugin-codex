# Review Feedback Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use loopx:subagent-exec (recommended) or loopx:exec to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Source:** Claude Code review report from the current conversation, verified against the working tree on 2026-06-08.

**Goal:** Fix the verified maintainability and behavior issues from the Claude Code review without expanding scope into already-resolved or false-positive items.

**Architecture:** Keep the companion and broker behavior unchanged while extracting duplicated policy into a small shared helper. Make state pruning tolerant of cleanup failures, make command detection side-effect free, and reduce test helper duplication. Treat existing `package-lock.json`, `README.md`, and tracked schema files as non-goals because local verification showed those review findings are stale or false positives.

**Tech Stack:** Node.js ESM `.mjs`, `node:test`, Git, local JSON state, Codex plugin skill files.

---

## Scope Check

This plan addresses one review-feedback batch for the existing Claude Code Codex plugin. The changes are small, local, and independently testable.

In scope:

- Remove duplicate `taskPermission` implementations from `scripts/cc-companion.mjs` and `scripts/claude-broker.mjs`.
- Make job pruning cleanup in `scripts/lib/state.mjs` best-effort so a failed stale-file delete does not block saving pruned state.
- Expand `.gitignore` for common Node.js, environment, build, coverage, temp, and log artifacts.
- Make `commandExists` in `scripts/lib/process.mjs` avoid executing arbitrary commands with `--version`.
- Reuse `createAsyncMessageStream` from `tests/fake-claude-sdk.mjs` in `tests/companion.test.mjs`.
- Keep `scripts/cc-companion.mjs` under 800 lines after removing the duplicate helper.

Out of scope:

- Creating `package-lock.json`; it already exists and is tracked.
- Creating `README.md`; it already exists.
- Creating or tracking `schemas/review-output.schema.json`; it already exists and is tracked.
- Large refactors of `scripts/cc-companion.mjs` beyond removing the duplicated permission helper.
- Changing Claude runtime behavior, broker protocol, job state schema, or user-facing command output.

## File Structure

Create:

- `scripts/lib/permissions.mjs`: shared permission policy helper used by companion and broker.
- `tests/permissions.test.mjs`: unit tests for the shared permission helper.

Modify:

- `scripts/cc-companion.mjs`: import `taskPermission` from `scripts/lib/permissions.mjs`; remove the local duplicate helper.
- `scripts/claude-broker.mjs`: import `taskPermission` from `scripts/lib/permissions.mjs`; remove the local duplicate helper.
- `scripts/lib/state.mjs`: make pruning file removal best-effort and rename the private helper to communicate that behavior.
- `scripts/lib/process.mjs`: make `commandExists` use `findOnPath`/executable checks only.
- `tests/state.test.mjs`: add a regression test showing failed pruned-file deletion does not block state save.
- `tests/args.test.mjs`: add a regression test showing `commandExists` does not execute commands found on `PATH`.
- `tests/fake-claude-sdk.mjs`: export `createAsyncMessageStream`.
- `tests/companion.test.mjs`: import and reuse `createAsyncMessageStream`; remove the local duplicate generator.
- `.gitignore`: add common local-only Node.js and runtime artifacts.

Existing dirty files to preserve:

- `scripts/lib/claude.mjs`
- `scripts/lib/process.mjs`
- `tests/claude-runtime.test.mjs`
- `.omc/`

Before editing any dirty file, inspect its current diff and preserve user-authored changes. `scripts/lib/process.mjs` is already dirty, so edits there must be made against the current content, not by reverting.

## Task 1: Extract Shared Permission Policy

**Files:**

- Create: `scripts/lib/permissions.mjs`
- Create: `tests/permissions.test.mjs`
- Modify: `scripts/cc-companion.mjs`
- Modify: `scripts/claude-broker.mjs`

- [ ] **Step 1: Write the failing permission helper tests**

Create `tests/permissions.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { taskPermission } from "../scripts/lib/permissions.mjs";

test("taskPermission returns read-only when readOnly is set", () => {
  assert.equal(taskPermission({ readOnly: true }), "read-only");
});

test("taskPermission defaults to workspace-write", () => {
  assert.equal(taskPermission({}), "workspace-write");
  assert.equal(taskPermission({ readOnly: false }), "workspace-write");
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
node --test tests/permissions.test.mjs
```

Expected: FAIL with a module-not-found error for `scripts/lib/permissions.mjs`.

- [ ] **Step 3: Create the shared helper**

Create `scripts/lib/permissions.mjs`:

```js
export function taskPermission(options = {}) {
  if (options.readOnly) {
    return "read-only";
  }

  return "workspace-write";
}
```

- [ ] **Step 4: Run the helper test and verify GREEN**

Run:

```bash
node --test tests/permissions.test.mjs
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Update companion and broker to use the helper**

In `scripts/cc-companion.mjs`, add the import near the other `./lib/*` imports:

```js
import { taskPermission } from "./lib/permissions.mjs";
```

Remove the local function near the bottom of `scripts/cc-companion.mjs`:

```js
function taskPermission(options) {
  if (options.readOnly) {
    return "read-only";
  }

  return "workspace-write";
}
```

In `scripts/claude-broker.mjs`, add the import near the other `./lib/*` imports:

```js
import { taskPermission } from "./lib/permissions.mjs";
```

Remove the local function near the lower half of `scripts/claude-broker.mjs`:

```js
function taskPermission(options) {
  if (options.readOnly) {
    return "read-only";
  }

  return "workspace-write";
}
```

- [ ] **Step 6: Verify duplicate helper removal and line count**

Run:

```bash
rg "function taskPermission|taskPermission" scripts/cc-companion.mjs scripts/claude-broker.mjs scripts/lib/permissions.mjs
wc -l scripts/cc-companion.mjs
```

Expected:

- `function taskPermission` appears only in `scripts/lib/permissions.mjs`.
- `scripts/cc-companion.mjs` is below 800 lines.

- [ ] **Step 7: Run focused runtime tests**

Run:

```bash
node --test tests/permissions.test.mjs tests/broker.test.mjs tests/companion.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit Task 1**

Run:

```bash
git add scripts/lib/permissions.mjs tests/permissions.test.mjs scripts/cc-companion.mjs scripts/claude-broker.mjs
git commit -m "refactor: share task permission policy"
```

Expected: commit succeeds. Do not stage unrelated dirty files.

## Task 2: Make Pruned Job File Cleanup Best-Effort

**Files:**

- Modify: `scripts/lib/state.mjs`
- Modify: `tests/state.test.mjs`

- [ ] **Step 1: Write the failing regression test**

Append this test after `saveWorkspaceState removes pruned job files and logs only` in `tests/state.test.mjs`:

```js
test("saveWorkspaceState still saves pruned state when deleting a pruned file fails", () => {
  const stateDir = makeTempDir("task-state-");
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const originalRmSync = fs.rmSync;
  const failingId = "task-04";
  const jobs = Array.from({ length: 55 }, (_, index) => {
    const id = `task-${String(index).padStart(2, "0")}`;
    const logFile = path.join(jobsDir, `${id}.log`);

    fs.writeFileSync(path.join(jobsDir, `${id}.json`), "{}", "utf8");
    fs.writeFileSync(logFile, "log", "utf8");

    return {
      id,
      kind: "task",
      status: "completed",
      phase: "completed",
      createdAt: "2026-06-06T07:00:00.000Z",
      updatedAt: `2026-06-06T07:${String(index).padStart(2, "0")}:00.000Z`,
      claudeSessionId: null,
      logFile
    };
  });

  fs.rmSync = (filePath, options) => {
    if (filePath === path.join(jobsDir, `${failingId}.json`)) {
      throw new Error("permission denied");
    }

    return originalRmSync(filePath, options);
  };

  try {
    saveWorkspaceState(stateDir, { version: 1, jobs });
  } finally {
    fs.rmSync = originalRmSync;
  }

  const savedJobs = listJobs({ stateDir, all: true });
  assert.equal(savedJobs.length, 50);
  assert.equal(savedJobs[0].id, "task-54");
  assert.equal(savedJobs.at(-1).id, "task-05");
  assert.equal(fs.existsSync(path.join(jobsDir, `${failingId}.json`)), true);
});
```

- [ ] **Step 2: Run the state test and verify RED**

Run:

```bash
node --test tests/state.test.mjs
```

Expected: FAIL in the new test with `Failed to remove pruned job file ... permission denied`.

- [ ] **Step 3: Make pruning cleanup tolerant**

In `scripts/lib/state.mjs`, replace the calls in `deletePrunedJobFiles`:

```js
removeFileIfPresent(prunedJobFilePath(stateDir, job.id, ".json"));
removeFileIfPresent(prunedJobFilePath(stateDir, job.id, ".log"));
```

with:

```js
removePrunedJobFileBestEffort(prunedJobFilePath(stateDir, job.id, ".json"));
removePrunedJobFileBestEffort(prunedJobFilePath(stateDir, job.id, ".log"));
```

Replace the private helper:

```js
function removeFileIfPresent(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch (error) {
    throw new Error(`Failed to remove pruned job file ${filePath}: ${error.message}`, {
      cause: error
    });
  }
}
```

with:

```js
function removePrunedJobFileBestEffort(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Pruning stale job artifacts should not block saving the current index.
  }
}
```

- [ ] **Step 4: Run the state test and verify GREEN**

Run:

```bash
node --test tests/state.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

Run:

```bash
git add scripts/lib/state.mjs tests/state.test.mjs
git commit -m "fix: tolerate pruned job cleanup failures"
```

Expected: commit succeeds. Do not stage unrelated dirty files.

## Task 3: Make Command Detection Side-Effect Free

**Files:**

- Modify: `scripts/lib/process.mjs`
- Modify: `tests/args.test.mjs`

- [ ] **Step 1: Inspect the dirty process diff before editing**

Run:

```bash
git diff -- scripts/lib/process.mjs
```

Expected: shows the existing user-authored change exporting `findOnPath`. Preserve it.

- [ ] **Step 2: Write the failing regression test**

Append this test after `commandExists detects node and rejects a generated missing command` in `tests/args.test.mjs`:

```js
test("commandExists does not execute commands found on PATH", () => {
  if (os.platform() === "win32") {
    return;
  }

  const binDir = makeTempDir("command-path-");
  const markerPath = path.join(binDir, "executed-marker");
  const commandPath = path.join(binDir, "side-effect-command");

  fs.writeFileSync(
    commandPath,
    `#!/bin/sh\nprintf executed > "${markerPath}"\nexit 0\n`,
    { mode: 0o755 }
  );

  assert.equal(commandExists(commandPath), true);
  assert.equal(fs.existsSync(markerPath), false);
});
```

- [ ] **Step 3: Run the args test and verify RED**

Run:

```bash
node --test tests/args.test.mjs
```

Expected: FAIL in the new test because the current `commandExists` executes the generated command with `--version`, creating `executed-marker`.

- [ ] **Step 4: Replace `commandExists` implementation**

In `scripts/lib/process.mjs`, replace:

```js
export function commandExists(command) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });

  if ((result.status === 0 || result.signal !== null) && isExecutable(command)) {
    return true;
  }

  return findOnPath(command) !== null;
}
```

with:

```js
export function commandExists(command) {
  return findOnPath(command) !== null;
}
```

Then remove the unused `spawnSync` import from the first import line. Change:

```js
import { spawn, spawnSync } from "node:child_process";
```

to:

```js
import { spawn } from "node:child_process";
```

Keep the existing exported `findOnPath` function unchanged.

- [ ] **Step 5: Run the args and Claude runtime tests**

Run:

```bash
node --test tests/args.test.mjs tests/claude-runtime.test.mjs
```

Expected: PASS. This also verifies the existing dirty `findOnPath`/Claude executable behavior still works.

- [ ] **Step 6: Commit Task 3**

Run:

```bash
git add scripts/lib/process.mjs tests/args.test.mjs
git commit -m "fix: avoid executing commands during detection"
```

Expected: commit succeeds. Include only the intended process and args test changes, while preserving pre-existing `findOnPath` edits.

## Task 4: Reuse the Fake Claude Async Stream Helper

**Files:**

- Modify: `tests/fake-claude-sdk.mjs`
- Modify: `tests/companion.test.mjs`

- [ ] **Step 1: Export the shared helper**

In `tests/fake-claude-sdk.mjs`, replace:

```js
async function* createAsyncMessageStream(messages) {
```

with:

```js
export async function* createAsyncMessageStream(messages) {
```

- [ ] **Step 2: Reuse the helper from companion tests**

In `tests/companion.test.mjs`, replace the import:

```js
import {
  createFakeClaudeSdk,
  reviewMessages,
  taskMessages
} from "./fake-claude-sdk.mjs";
```

with:

```js
import {
  createAsyncMessageStream,
  createFakeClaudeSdk,
  reviewMessages,
  taskMessages
} from "./fake-claude-sdk.mjs";
```

Remove the local duplicate helper at the bottom of `tests/companion.test.mjs`:

```js
async function* createAsyncMessageStream(messages) {
  for (const message of messages) {
    if (message instanceof Error) {
      throw message;
    }

    yield message;
  }
}
```

- [ ] **Step 3: Verify only one helper definition remains**

Run:

```bash
rg "async function\\* createAsyncMessageStream|createAsyncMessageStream" tests/fake-claude-sdk.mjs tests/companion.test.mjs
```

Expected:

- `export async function* createAsyncMessageStream` appears in `tests/fake-claude-sdk.mjs`.
- `tests/companion.test.mjs` imports and calls the helper but does not define it.

- [ ] **Step 4: Run companion tests**

Run:

```bash
node --test tests/companion.test.mjs tests/fake-claude-sdk.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

Run:

```bash
git add tests/fake-claude-sdk.mjs tests/companion.test.mjs
git commit -m "test: reuse fake claude stream helper"
```

Expected: commit succeeds.

## Task 5: Expand Local Ignore Rules

**Files:**

- Modify: `.gitignore`

- [ ] **Step 1: Update `.gitignore`**

Replace `.gitignore` with:

```gitignore
node_modules/
.DS_Store
.loopx/

# Logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# Environment
.env
.env.*

# Build and coverage output
coverage/
dist/
build/

# Temporary files
tmp/
temp/
```

- [ ] **Step 2: Verify ignore rules**

Run:

```bash
git check-ignore node_modules/example .DS_Store .loopx/state.json debug.log .env coverage/lcov.info dist/index.js tmp/file
```

Expected output includes each provided path.

- [ ] **Step 3: Commit Task 5**

Run:

```bash
git add .gitignore
git commit -m "chore: expand local ignore rules"
```

Expected: commit succeeds.

## Task 6: Final Verification and False-Positive Audit

**Files:**

- Read-only verification across the repository.

- [ ] **Step 1: Verify false-positive review items are still satisfied**

Run:

```bash
git ls-files package-lock.json README.md schemas/review-output.schema.json
```

Expected output:

```text
README.md
package-lock.json
schemas/review-output.schema.json
```

- [ ] **Step 2: Verify companion line count and duplicate helpers**

Run:

```bash
wc -l scripts/cc-companion.mjs
rg "function taskPermission|removeFileIfPresent|async function\\* createAsyncMessageStream|spawnSync\\(command, \\[\"--version\"\\]" scripts tests
```

Expected:

- `scripts/cc-companion.mjs` is below 800 lines.
- `function taskPermission` appears only in `scripts/lib/permissions.mjs`.
- No `removeFileIfPresent` remains in `scripts/lib/state.mjs`.
- `async function* createAsyncMessageStream` appears only in `tests/fake-claude-sdk.mjs`.
- No `spawnSync(command, ["--version"]` remains in `scripts/lib/process.mjs`.

- [ ] **Step 3: Run the full test suite**

Run:

```bash
npm test
```

Expected: PASS for the full `node --test` suite.

- [ ] **Step 4: Review final diff**

Run:

```bash
git status --short
git diff --stat
git diff -- .gitignore scripts/cc-companion.mjs scripts/claude-broker.mjs scripts/lib/permissions.mjs scripts/lib/process.mjs scripts/lib/state.mjs tests/args.test.mjs tests/companion.test.mjs tests/fake-claude-sdk.mjs tests/permissions.test.mjs tests/state.test.mjs
```

Expected:

- Only planned files are changed, except pre-existing unrelated dirty files remain untouched or preserved.
- No changes are made to `package-lock.json`, `README.md`, or `schemas/review-output.schema.json`.

- [ ] **Step 5: Commit final verification notes only if needed**

If Task 6 reveals no additional required code changes, do not create an empty commit.

If Task 6 requires a small correction, make the correction, rerun the focused command plus `npm test`, then commit:

```bash
git add <corrected-files>
git commit -m "chore: finish review feedback fixes"
```

Expected: commit succeeds only when there is an actual correction to commit.

## Self-Review

- Spec coverage: every verified review item maps to a task. Duplicate permission logic is covered by Task 1; prune cleanup semantics by Task 2; `.gitignore` by Task 5; companion line count by Tasks 1 and 6; `commandExists` side effects by Task 3; duplicate test helper by Task 4.
- False positives: `package-lock.json`, `README.md`, and `schemas/review-output.schema.json` are explicitly listed as non-goals and rechecked in Task 6.
- Placeholder scan: no unfinished placeholder markers or unspecified test commands remain.
- Type consistency: all snippets use existing ESM imports and current helper names.
- Design drift: no new product behavior, broker protocol changes, state schema changes, or permission modes are introduced.
