import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { runCompanion } from "../scripts/cc-companion.mjs";
import { loadJob, loadWorkspaceState, saveJob } from "../scripts/lib/state.mjs";
import {
  createAsyncMessageStream,
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

test("setup checks real Claude auth readiness when diagnostics are not injected", async () => {
  const output = await runCompanion(["setup", "--json"], {
    cwd: makeTempDir(),
    env: {},
    commandExists(command) {
      return command === "claude";
    },
    importClaudeSdk: async () => ({}),
    checkClaudeReady: async () => false,
    checkBroker: async () => false,
    diagnostics: {
      nodeVersion: "v20.0.0"
    }
  });

  const report = JSON.parse(output);
  const auth = report.checks.find((check) => check.name === "Claude Code auth");

  assert.equal(auth.ok, false);
  assert.equal(auth.detail, "not ready");
  assert.deepEqual(report.nextSteps, ["Run `claude login`, then retry setup."]);
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

test("background task rejects when another job is queued", async () => {
  const stateRoot = makeTempDir("state-");
  const workspace = makeTempDir("workspace-");
  const deps = {
    cwd: workspace,
    env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: stateRoot },
    backgroundRunner: {
      spawnWorker(job) {
        return { pid: 12345, command: `worker ${job.id}` };
      }
    }
  };

  await runCompanion(["task", "--background", "--", "first task"], deps);

  await assert.rejects(
    () => runCompanion(["task", "--background", "--", "second task"], deps),
    /already running/
  );
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

test("cancel does not mark running job cancelled when broker interrupt reports no active job", async () => {
  const stateRoot = makeTempDir("state-");
  const workspace = makeTempDir("workspace-");
  let release;
  const running = runCompanion(["task", "--", "long task"], {
    cwd: workspace,
    env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: stateRoot },
    brokerClient: {
      async run() {
        await new Promise((resolve) => {
          release = resolve;
        });
        return {
          status: "completed",
          claudeSessionId: "running-session",
          finalText: "finished anyway",
          rawMessages: []
        };
      }
    }
  });

  await waitForStoredJobStatus(stateRoot, "running");

  await assert.rejects(
    () =>
      runCompanion(["cancel"], {
        cwd: workspace,
        env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: stateRoot },
        brokerClient: {
          async interrupt() {
            return { interrupted: false, detail: "No active job." };
          }
        }
      }),
    /No active job/
  );

  const stateDir = onlyWorkspaceStateDir(stateRoot);
  const [summary] = loadWorkspaceState(stateDir).jobs;
  assert.equal(loadJob(summary.id, { stateDir }).status, "running");

  release();
  await running;
});

test("cancel terminates tracked worker when broker interrupt does not stop running job", async () => {
  const stateRoot = makeTempDir("state-");
  const workspace = makeTempDir("workspace-");
  let release;
  const running = runCompanion(["task", "--", "long task"], {
    cwd: workspace,
    env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: stateRoot },
    brokerClient: {
      async run() {
        await new Promise((resolve) => {
          release = resolve;
        });
        return {
          status: "completed",
          claudeSessionId: "running-session",
          finalText: "finished anyway",
          rawMessages: []
        };
      }
    }
  });
  const job = await waitForStoredJobStatus(stateRoot, "running");
  const worker = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
    detached: true,
    stdio: "ignore"
  });
  worker.unref();

  try {
    const stateDir = onlyWorkspaceStateDir(stateRoot);
    const withWorker = loadJob(job.id, { stateDir });
    withWorker.worker = { pid: worker.pid, command: "test worker" };
    saveJob(withWorker, { stateDir });

    const cancel = await runCompanion(["cancel", job.id], {
      cwd: workspace,
      env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: stateRoot },
      brokerClient: {
        async interrupt() {
          return { interrupted: false, detail: "No active job." };
        }
      }
    });

    assert.match(cancel, /worker terminated/);
    assert.equal(loadJob(job.id, { stateDir }).status, "cancelled");
  } finally {
    try {
      process.kill(worker.pid, "SIGKILL");
    } catch {
      // The cancellation path may already have terminated it.
    }
    release();
    await running.catch(() => {});
  }
});

test("task worker preserves externally cancelled jobs as terminal", async () => {
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
  await runCompanion(["cancel", id], {
    cwd: workspace,
    env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: stateRoot }
  });

  const workerOutput = await runCompanion(["task-worker", id], {
    cwd: workspace,
    env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: stateRoot },
    disableBroker: true,
    sdk: createFakeClaudeSdk({ messages: taskMessages })
  });

  assert.match(workerOutput, /already cancelled/);
  const stateDir = onlyWorkspaceStateDir(stateRoot);
  assert.equal(loadJob(id, { stateDir }).status, "cancelled");
});

test("status --wait waits for a running job to finish", async () => {
  const stateRoot = makeTempDir("state-");
  const workspace = makeTempDir("workspace-");
  let release;
  const running = runCompanion(["task", "--", "long task"], {
    cwd: workspace,
    env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: stateRoot },
    brokerClient: {
      async run() {
        await new Promise((resolve) => {
          release = resolve;
        });
        return {
          status: "completed",
          claudeSessionId: "wait-session",
          finalText: "waited result",
          rawMessages: []
        };
      }
    }
  });

  const job = await waitForStoredJobStatus(stateRoot, "running");
  const statusPromise = runCompanion(["status", "--wait", job.id], {
    cwd: workspace,
    env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: stateRoot },
    statusWait: { intervalMs: 5, timeoutMs: 1000 }
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  await running;

  const status = await statusPromise;
  assert.match(status, /completed/);
});

test("review foreground uses a scoped prompt and read-only permission", async () => {
  const workspace = makeTempDir("workspace-");
  const stateRoot = makeTempDir("state-");
  const sdk = createFakeClaudeSdk({ messages: reviewMessages });

  const output = await runCompanion(["review"], {
    cwd: workspace,
    env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: stateRoot },
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
  assert.doesNotMatch(sdk.calls[0].prompt, /^\/review\b/);
  assert.match(sdk.calls[0].prompt, new RegExp(escapeRegExp(workspace)));
  assert.match(sdk.calls[0].prompt, /Only review files under the repository root/i);
  assert.match(sdk.calls[0].prompt, /file\.txt/);
  assert.match(sdk.calls[0].prompt, /diff --git/);
  assert.deepEqual(sdk.calls[0].options.allowedTools, []);
  assert.deepEqual(sdk.calls[0].options.tools, []);
  assert.ok(sdk.calls[0].options.disallowedTools.includes("Read"));
  assert.ok(sdk.calls[0].options.disallowedTools.includes("Bash"));
  assert.ok(sdk.calls[0].options.disallowedTools.includes("Edit"));
  assert.deepEqual(sdk.calls[0].options.settingSources, ["user"]);
  assert.deepEqual(sdk.calls[0].options.plugins, []);
  assert.deepEqual(sdk.calls[0].options.skills, []);
  assert.equal(sdk.calls[0].options.maxTurns, 1);

  const stateDir = onlyWorkspaceStateDir(stateRoot);
  const [summary] = loadWorkspaceState(stateDir).jobs;
  const job = loadJob(summary.id, { stateDir });
  assert.equal(job.request.prompt, sdk.calls[0].prompt);
});

test("review broker requests use the scoped prompt", async () => {
  const calls = [];

  const output = await runCompanion(["review"], {
    cwd: makeTempDir("workspace-"),
    env: { CLAUDE_CODE_PLUGIN_CODEX_DATA: makeTempDir("state-") },
    brokerClient: {
      async run(request) {
        calls.push(request);
        return {
          status: "completed",
          claudeSessionId: "broker-review-session",
          finalText: "broker review done",
          rawMessages: []
        };
      }
    },
    reviewContext: {
      target: { kind: "working-tree", description: "working tree", baseRef: null },
      files: ["file.txt"],
      diff: "diff --git",
      inline: true
    }
  });

  assert.match(output, /broker review done/);
  assert.equal(calls[0].kind, "review");
  assert.doesNotMatch(calls[0].prompt, /^\/review\b/);
  assert.match(calls[0].prompt, /Only review files under the repository root/i);
  assert.equal(calls[0].readTools, false);
  assert.equal(calls[0].isolated, true);
  assert.equal(calls[0].maxTurns, 1);
  assert.equal("fallbackPrompt" in calls[0], false);
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

async function waitForStoredJobStatus(stateRoot, status, { timeoutMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const entries = fs.existsSync(stateRoot)
      ? fs.readdirSync(stateRoot).filter((entry) => entry.startsWith("workspace-"))
      : [];

    if (entries.length > 0) {
      const stateDir = path.join(stateRoot, entries[0]);
      for (const summary of loadWorkspaceState(stateDir).jobs) {
        const job = loadJob(summary.id, { stateDir });
        if (job.status === status) {
          return job;
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error(`Timed out waiting for job status: ${status}`);
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createThrowingSdk(message) {
  return {
    calls: [],
    query() {
      throw new Error(message);
    }
  };
}
