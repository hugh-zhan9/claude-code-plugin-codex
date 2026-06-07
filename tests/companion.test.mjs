import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { runCompanion } from "../scripts/cc-companion.mjs";
import { loadJob, loadWorkspaceState } from "../scripts/lib/state.mjs";
import {
  createFakeClaudeSdk,
  reviewMessages,
  taskMessages
} from "./fake-claude-sdk.mjs";
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
  assert.equal(
    report.checks.find((check) => check.name === "Claude Code CLI").ok,
    true
  );
});

test("setup resolves and validates cwd like other commands", async () => {
  await assert.rejects(
    () =>
      runCompanion(["setup", "--cwd", path.join(makeTempDir(), "missing")], {
        env: {},
        diagnostics: {
          nodeVersion: "v20.0.0",
          hasClaudeCli: true,
          sdkImportOk: true
        }
      }),
    /ENOENT/
  );
});

test("companion CLI guard runs from a path with spaces", () => {
  const parent = makeTempDir("companion path ");
  const linkPath = path.join(parent, "plugin link");
  fs.symlinkSync(path.resolve("."), linkPath, "dir");

  const result = spawnSync(
    process.execPath,
    [path.join(linkPath, "scripts", "cc-companion.mjs"), "setup", "--json"],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"checks"/);
});

test("task foreground runs Claude and stores completed job", async () => {
  const stateRoot = makeTempDir("state-");
  const workspace = makeTempDir("workspace-");
  const sdk = createFakeClaudeSdk({ messages: taskMessages });

  const output = await runCompanion(["task", "--", "fix bug"], {
    cwd: workspace,
    env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: stateRoot },
    disableBroker: true,
    sdk
  });

  assert.match(output, /Task completed\./);
  assert.equal(sdk.calls[0].options.permissionMode, "acceptEdits");

  const stateDir = onlyWorkspaceStateDir(stateRoot);
  const [summary] = loadWorkspaceState(stateDir).jobs;
  const job = loadJob(summary.id, { stateDir });
  assert.equal(job.status, "completed");
  assert.equal(job.claudeSessionId, "task-session");
  assert.equal(job.result.finalText, "Task completed.");
});

test("task resume-last requires a completed task session", async () => {
  await assert.rejects(
    () =>
      runCompanion(["task", "--resume-last"], {
        cwd: makeTempDir("workspace-"),
        env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: makeTempDir("state-") },
        sdk: createFakeClaudeSdk({ messages: taskMessages })
      }),
    /No completed task job with a Claude session to resume/
  );
});

test("task rejects fresh and resume-last together", async () => {
  await assert.rejects(
    () =>
      runCompanion(["task", "--fresh", "--resume-last", "--", "start over"], {
        cwd: makeTempDir("workspace-"),
        env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: makeTempDir("state-") },
        sdk: createFakeClaudeSdk({ messages: taskMessages })
      }),
    /Cannot combine --fresh and --resume-last/
  );
});

test("task rejects conflicting permission flags", async () => {
  await assert.rejects(
    () =>
      runCompanion(["task", "--write", "--read-only", "--", "fix bug"], {
        cwd: makeTempDir("workspace-"),
        env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: makeTempDir("state-") },
        sdk: createFakeClaudeSdk({ messages: taskMessages })
      }),
    /Cannot combine --write and --read-only/
  );
});

test("task resume-last ignores newer review sessions", async () => {
  const stateRoot = makeTempDir("state-");
  const workspace = makeTempDir("workspace-");
  const taskSdk = createFakeClaudeSdk({ messages: taskMessages });

  await runCompanion(["task", "--", "initial task"], {
    cwd: workspace,
    env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: stateRoot },
    disableBroker: true,
    sdk: taskSdk
  });

  await runCompanion(["review"], {
    cwd: workspace,
    env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: stateRoot },
    disableBroker: true,
    sdk: createFakeClaudeSdk({ messages: reviewMessages }),
    reviewContext: {
      target: { kind: "working-tree", description: "working tree", baseRef: null },
      files: ["file.txt"],
      diff: "diff --git",
      inline: true
    }
  });

  const resumeSdk = createFakeClaudeSdk({ messages: taskMessages });
  await runCompanion(["task", "--resume-last", "--", "continue task"], {
    cwd: workspace,
    env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: stateRoot },
    disableBroker: true,
    sdk: resumeSdk
  });

  assert.equal(resumeSdk.calls[0].options.resume, "task-session");
});

test("task uses broker client when provided", async () => {
  const calls = [];
  const output = await runCompanion(["task", "--", "fix bug"], {
    cwd: makeTempDir("workspace-"),
    env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: makeTempDir("state-") },
    sdk: createThrowingSdk("direct SDK should not run"),
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
  assert.equal(calls[0].prompt, "fix bug");
});

test("broker busy is rendered as a clear user-facing error", async () => {
  await assert.rejects(
    () =>
      runCompanion(["task", "--", "fix bug"], {
        cwd: makeTempDir("workspace-"),
        env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: makeTempDir("state-") },
        sdk: createFakeClaudeSdk({ messages: taskMessages }),
        brokerClient: {
          async run() {
            const error = new Error(
              "A Claude Code job is already running in this workspace."
            );
            error.code = "BUSY";
            throw error;
          }
        }
      }),
    /claude-code-status or claude-code-cancel/
  );
});

test("broker interrupted task stores a cancelled job", async () => {
  const stateRoot = makeTempDir("state-");
  const workspace = makeTempDir("workspace-");

  await assert.rejects(
    () =>
      runCompanion(["task", "--", "fix bug"], {
        cwd: workspace,
        env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: stateRoot },
        brokerClient: {
          async run() {
            return {
              status: "interrupted",
              interrupted: true,
              finalText: "",
              rawMessages: []
            };
          }
        }
      }),
    /cancelled/
  );

  const stateDir = onlyWorkspaceStateDir(stateRoot);
  const [summary] = loadWorkspaceState(stateDir).jobs;
  const job = loadJob(summary.id, { stateDir });
  assert.equal(job.status, "cancelled");
});

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
    disableBroker: true,
    sdk
  });

  const result = await runCompanion(["result"], {
    cwd: workspace,
    env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: stateRoot }
  });

  assert.match(result, /Task completed\./);
  assert.match(result, /claude --resume task-session/);
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

test("review foreground uses native review and read-only permission", async () => {
  const workspace = makeTempDir("workspace-");
  const sdk = createFakeClaudeSdk({ messages: reviewMessages });

  const output = await runCompanion(["review"], {
    cwd: workspace,
    env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: makeTempDir("state-") },
    disableBroker: true,
    sdk,
    reviewContext: {
      target: { kind: "working-tree", description: "working tree", baseRef: null },
      files: ["file.txt"],
      diff: "diff --git",
      inline: true
    }
  });

  assert.match(output, /No issues found\./);
  assert.equal(sdk.calls[0].options.allowedTools.includes("Edit"), false);
});

test("review falls back to prompt review when native review is unsupported", async () => {
  const sdk = createSwitchingSdk([
    [new Error("/review is not supported")],
    reviewMessages
  ]);

  const output = await runCompanion(["review"], {
    cwd: makeTempDir("workspace-"),
    env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: makeTempDir("state-") },
    disableBroker: true,
    sdk,
    reviewContext: {
      target: { kind: "working-tree", description: "working tree", baseRef: null },
      files: ["file.txt"],
      diff: "diff --git",
      inline: true
    }
  });

  assert.match(output, /Fallback: used prompt-based review/);
  assert.match(sdk.calls[1].prompt, /read-only code review/);
  assert.equal(sdk.calls[1].options.allowedTools.includes("Edit"), false);
});

test("adversarial-review renders structured output and passes focus", async () => {
  const sdk = createFakeClaudeSdk({
    messages: [
      {
        type: "result",
        session_id: "adversarial-session",
        result:
          '{"verdict":"approved","summary":"No blockers.","findings":[],"next_steps":["Ship it"]}'
      }
    ]
  });

  const output = await runCompanion(
    ["adversarial-review", "--", "check auth regressions"],
    {
      cwd: makeTempDir("workspace-"),
      env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: makeTempDir("state-") },
      disableBroker: true,
      sdk,
      reviewContext: {
        target: { kind: "working-tree", description: "working tree", baseRef: null },
        files: ["file.txt"],
        diff: "diff --git",
        inline: true
      }
    }
  );

  assert.match(output, /Verdict: approved/);
  assert.match(output, /No blockers\./);
  assert.match(sdk.calls[0].prompt, /Focus:\ncheck auth regressions/);
});

test("adversarial-review renders raw text and parse error when JSON is invalid", async () => {
  const sdk = createFakeClaudeSdk({
    messages: [
      {
        type: "result",
        session_id: "adversarial-session",
        result: "plain review text"
      }
    ]
  });

  const output = await runCompanion(["adversarial-review"], {
    cwd: makeTempDir("workspace-"),
    env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: makeTempDir("state-") },
    disableBroker: true,
    sdk,
    reviewContext: {
      target: { kind: "working-tree", description: "working tree", baseRef: null },
      files: ["file.txt"],
      diff: "diff --git",
      inline: true
    }
  });

  assert.match(output, /Structured output could not be parsed/);
  assert.match(output, /Parse error: No JSON object found/);
  assert.match(output, /plain review text/);
});

function onlyWorkspaceStateDir(stateRoot) {
  const entries = fs
    .readdirSync(stateRoot)
    .filter((entry) => entry.startsWith("workspace-"));

  assert.equal(entries.length, 1);
  return path.join(stateRoot, entries[0]);
}

function createSwitchingSdk(messageSets) {
  const calls = [];

  return {
    calls,
    query(params) {
      calls.push(params);
      return createAsyncMessageStream(messageSets[calls.length - 1] ?? []);
    }
  };
}

function createThrowingSdk(message) {
  return {
    calls: [],
    query() {
      throw new Error(message);
    }
  };
}

async function* createAsyncMessageStream(messages) {
  for (const message of messages) {
    if (message instanceof Error) {
      throw message;
    }

    yield message;
  }
}
