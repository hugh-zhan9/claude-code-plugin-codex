import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createBrokerState,
  createBrokerRuntime,
  handleBrokerRequest,
  startBrokerServer
} from "../scripts/claude-broker.mjs";
import { getBrokerEndpoint } from "../scripts/lib/broker-endpoint.mjs";
import {
  cleanupStaleBroker,
  ensureBroker,
  loadBrokerSession,
  requestBroker
} from "../scripts/lib/broker-lifecycle.mjs";
import { ensureDir } from "../scripts/lib/fs.mjs";
import { createFakeClaudeSdk, taskMessages } from "./fake-claude-sdk.mjs";
import { makeTempDir } from "./helpers.mjs";

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

test("broker runtime dispatches task requests to Claude SDK", async () => {
  const sdk = createFakeClaudeSdk({ messages: taskMessages });
  const runtime = createBrokerRuntime({
    sdk,
    workspaceRoot: "/repo"
  });

  const result = await runtime.run({
    params: {
      kind: "task",
      prompt: "fix auth",
      options: { model: "sonnet", effort: "high" },
      resumeSessionId: "previous-session"
    }
  });

  assert.equal(result.finalText, "Task completed.");
  assert.equal(sdk.calls[0].prompt, "fix auth");
  assert.equal(sdk.calls[0].options.cwd, "/repo");
  assert.equal(sdk.calls[0].options.model, "sonnet");
  assert.equal(sdk.calls[0].options.effort, "high");
  assert.equal(sdk.calls[0].options.resume, "previous-session");
  assert.equal(sdk.calls[0].options.permissionMode, "acceptEdits");
});

test("broker interrupt aborts the active run controller", async () => {
  let activeController = null;
  const state = createBrokerState({
    runtime: {
      async run(_request, { abortController }) {
        activeController = abortController;
        await waitFor(() => abortController.signal.aborted);
        return { status: "interrupted", interrupted: true, finalText: "" };
      },
      async interrupt() {
        return { interrupted: true, detail: "interrupted" };
      }
    }
  });

  const running = handleBrokerRequest(state, {
    id: "1",
    method: "run",
    params: { jobId: "task-1", kind: "task" }
  });
  await waitFor(() => activeController !== null);

  const interrupt = await handleBrokerRequest(state, {
    id: "2",
    method: "interrupt",
    params: { jobId: "task-1" }
  });

  assert.equal(activeController.signal.aborted, true);
  assert.equal(interrupt.result.interrupted, true);
  const runResponse = await running;
  assert.equal(runResponse.result.interrupted, true);
});

test("broker server handles JSONL requests on long default-style endpoint", async () => {
  const stateDir = path.join(makeTempDir("broker-long-state-"), "x".repeat(120));
  const endpoint = getBrokerEndpoint({ stateDir, platform: "darwin" });
  const runtime = {
    async run(request) {
      return { status: "completed", finalText: `server ${request.params.kind}` };
    },
    async interrupt() {
      return { interrupted: true };
    }
  };
  const { server } = await startBrokerServer({ endpoint, runtime });

  try {
    const response = await requestBroker(
      endpoint,
      { id: "server-1", method: "run", params: { jobId: "task-1", kind: "task" } },
      1000
    );

    assert.equal(response.id, "server-1");
    assert.equal(response.result.finalText, "server task");

    const shutdown = await requestBroker(
      endpoint,
      { id: "shutdown-1", method: "shutdown", params: {} },
      1000
    );
    assert.equal(shutdown.result.shuttingDown, true);
  } finally {
    await closeServer(server);
    fs.rmSync(endpoint, { force: true });
  }
});

test("ensureBroker rejects when spawned broker never becomes reachable", async () => {
  const stateDir = makeTempDir("broker-unreachable-");

  await assert.rejects(
    () =>
      ensureBroker({
        stateDir,
        nodePath: path.join(stateDir, "missing-node"),
        readyTimeoutMs: 50
      }),
    /Broker did not become reachable/
  );
  assert.equal(loadBrokerSession(stateDir), null);
});

test("cleanupStaleBroker does not remove regular files with socket-like names", async () => {
  const stateDir = makeTempDir("broker-regular-file-");
  const endpoint = getBrokerEndpoint({ stateDir, platform: "darwin" });
  ensureDir(path.dirname(endpoint));
  fs.writeFileSync(endpoint, "not a socket", "utf8");

  await cleanupStaleBroker(stateDir);

  assert.equal(fs.existsSync(endpoint), true);
});

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }

    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function waitFor(predicate, { timeoutMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error("Timed out waiting for condition.");
}
