#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { appendLog, ensureDir } from "./lib/fs.mjs";
import { getBrokerLogFile } from "./lib/broker-endpoint.mjs";
import { taskPermission } from "./lib/permissions.mjs";
import {
  importClaudeSdk,
  runAdversarialReview,
  runClaudeTask,
  runPromptReview
} from "./lib/claude.mjs";

const BUSY_MESSAGE = "A Claude Code job is already running in this workspace.";

export function createBrokerState({ runtime }) {
  if (!runtime) {
    throw new Error("runtime is required");
  }

  return { active: null, runtime };
}

export function createBrokerRuntime({ sdk = null, workspaceRoot = process.cwd() } = {}) {
  let activeAbortController = null;

  return {
    async run(request, { abortController = null } = {}) {
      const params = request?.params ?? {};
      activeAbortController = abortController;

      try {
        return await runBrokerExecution({
          sdk,
          workspaceRoot,
          params,
          abortController
        });
      } finally {
        activeAbortController = null;
      }
    },
    async interrupt() {
      activeAbortController?.abort();
      return { interrupted: true, detail: "interrupted" };
    }
  };
}

export async function handleBrokerRequest(state, request) {
  const id = request?.id ?? null;

  try {
    if (request?.method === "run") {
      return await handleRunRequest(state, request, id);
    }

    if (request?.method === "interrupt") {
      return await handleInterruptRequest(state, request, id);
    }

    if (request?.method === "shutdown") {
      return { id, result: { shuttingDown: true } };
    }

    return {
      id,
      error: { code: "METHOD_NOT_FOUND", message: "Unknown broker method." }
    };
  } catch (error) {
    return {
      id,
      error: {
        code: "BROKER_ERROR",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

export async function startBrokerServer({ endpoint, runtime, logFile } = {}) {
  if (!endpoint) {
    throw new Error("endpoint is required");
  }

  const state = createBrokerState({ runtime });
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk;

      while (buffer.includes("\n")) {
        const newlineIndex = buffer.indexOf("\n");
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        void handleBrokerLine({ line, socket, state, server, logFile });
      }
    });
  });

  server.on("error", (error) => {
    logBrokerEvent(logFile, `server error: ${error.message}`);
  });

  if (process.platform !== "win32" && endpoint.endsWith(".sock")) {
    await removeSocketIfStale(endpoint);
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      logBrokerEvent(logFile, `listening ${endpoint}`);
      resolve();
    });
  });

  return { server, state, endpoint };
}

async function handleRunRequest(state, request, id) {
  if (state.active !== null) {
    return {
      id,
      error: { code: "BUSY", message: BUSY_MESSAGE }
    };
  }

  const abortController = new AbortController();
  const jobId = request?.params?.jobId ?? null;
  state.active = { jobId, startedAt: new Date().toISOString(), abortController };

  try {
    const result = await state.runtime.run(request, { abortController });
    return { id, result };
  } finally {
    state.active = null;
  }
}

async function handleInterruptRequest(state, request, id) {
  const params = request?.params ?? {};

  if (state.active === null) {
    return { id, result: { interrupted: false, detail: "No active job." } };
  }

  if (params.jobId && params.jobId !== state.active.jobId) {
    return {
      id,
      error: { code: "NOT_ACTIVE", message: "Job is not active." }
    };
  }

  state.active.abortController?.abort();
  const result = await state.runtime.interrupt(params, {
    abortController: state.active.abortController
  });
  return { id, result };
}

async function runBrokerExecution({
  sdk,
  workspaceRoot,
  params,
  abortController
}) {
  const claudeSdk = sdk ?? (await importClaudeSdk());
  const options = params.options ?? {};

  if (params.kind === "task") {
    return runClaudeTask({
      sdk: claudeSdk,
      prompt: params.prompt ?? "",
      cwd: workspaceRoot,
      model: options.model,
      effort: options.effort,
      permission: taskPermission(options),
      resumeSessionId: params.resumeSessionId ?? null,
      dangerouslyBypassPermissions: options.dangerouslyBypassPermissions,
      abortController,
      readTools: params.readTools ?? true,
      isolated: params.isolated ?? false,
      maxTurns: params.maxTurns ?? null
    });
  }

  if (params.kind === "review") {
    return runBrokerReview({
      sdk: claudeSdk,
      workspaceRoot,
      params,
      abortController
    });
  }

  if (params.kind === "adversarial-review") {
    return runAdversarialReview({
      sdk: claudeSdk,
      prompt: params.prompt,
      cwd: workspaceRoot,
      model: options.model,
      effort: options.effort,
      abortController,
      readTools: params.readTools ?? true,
      isolated: params.isolated ?? true,
      maxTurns: params.maxTurns ?? null
    });
  }

  throw new Error(`Unsupported broker run kind: ${params.kind}`);
}

async function runBrokerReview({ sdk, workspaceRoot, params, abortController }) {
  const options = params.options ?? {};

  return runPromptReview({
    sdk,
    // fallbackPrompt is accepted for compatibility with already queued requests.
    prompt: params.prompt ?? params.fallbackPrompt ?? "",
    cwd: workspaceRoot,
    model: options.model,
    effort: options.effort,
    abortController,
    readTools: params.readTools ?? true,
    isolated: params.isolated ?? true,
    maxTurns: params.maxTurns ?? null
  });
}

async function handleBrokerLine({ line, socket, state, server, logFile }) {
  if (line.trim() === "") {
    return;
  }

  let request;
  try {
    request = JSON.parse(line);
  } catch {
    socket.write(
      `${JSON.stringify({
        id: null,
        error: { code: "INVALID_JSON", message: "Invalid JSON request." }
      })}\n`
    );
    return;
  }

  logBrokerEvent(logFile, `request ${request.method ?? "unknown"}`);
  const response = await handleBrokerRequest(state, request);
  socket.write(`${JSON.stringify(response)}\n`);

  if (request.method === "shutdown" && response.result?.shuttingDown) {
    socket.end();
    server.close(() => {
      logBrokerEvent(logFile, "shutdown");
    });
  }
}

function logBrokerEvent(logFile, line) {
  if (!logFile) {
    return;
  }

  try {
    appendLog(logFile, line);
  } catch {
    // Logging must not break broker request handling.
  }
}

async function removeSocketIfStale(endpoint) {
  try {
    if (isSocketFile(endpoint) && !(await canConnect(endpoint))) {
      fs.rmSync(endpoint, { force: true });
    }
  } catch {
    // Let server.listen report any remaining bind failure.
  }
}

function isSocketFile(filePath) {
  try {
    return fs.lstatSync(filePath).isSocket();
  } catch {
    return false;
  }
}

function canConnect(endpoint) {
  return new Promise((resolve) => {
    const socket = net.connect(endpoint);
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 50);

    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.end();
      resolve(true);
    });

    socket.once("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

function parseBrokerArgs(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];

    if (!flag.startsWith("--")) {
      throw new Error(`Unexpected argument: ${flag}`);
    }

    const value = argv[index + 1];

    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }

    if (flag === "--endpoint") {
      options.endpoint = value;
    } else if (flag === "--workspace") {
      options.workspaceRoot = value;
    } else if (flag === "--state-dir") {
      options.stateDir = value;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }

    index += 1;
  }

  return options;
}

async function main() {
  const options = parseBrokerArgs(process.argv.slice(2));

  if (!options.endpoint) {
    throw new Error("--endpoint is required");
  }

  if (options.stateDir) {
    ensureDir(options.stateDir);
  }

  await startBrokerServer({
    endpoint: options.endpoint,
    runtime: createBrokerRuntime({ workspaceRoot: options.workspaceRoot }),
    logFile: options.stateDir ? getBrokerLogFile(options.stateDir) : null
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
