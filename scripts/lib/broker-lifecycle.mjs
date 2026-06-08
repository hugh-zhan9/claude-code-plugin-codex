import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, readJsonFile } from "./fs.mjs";
import { spawnDetached } from "./process.mjs";
import {
  getBrokerEndpoint,
  getBrokerLogFile,
  getBrokerSessionFile
} from "./broker-endpoint.mjs";

const BROKER_READY_TIMEOUT_MS = 3000;
export const DEFAULT_BROKER_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
// v4 carries scoped review prompts plus isolated/readTools/maxTurns runtime options.
export const BROKER_PROTOCOL_VERSION = 4;

export function loadBrokerSession(stateDir) {
  return readJsonFile(getBrokerSessionFile(stateDir));
}

export function saveBrokerSession(stateDir, session) {
  atomicWriteJson(getBrokerSessionFile(stateDir), session);
}

export function isBrokerReachable(endpoint, timeoutMs = 250) {
  return new Promise((resolve) => {
    const socket = net.connect(endpoint);
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);

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

export function requestBroker(
  endpoint,
  request,
  timeoutMs = DEFAULT_BROKER_REQUEST_TIMEOUT_MS
) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint);
    let buffer = "";
    let settled = false;

    const timeout = setTimeout(() => {
      settle(new Error("Broker request timed out."));
      socket.destroy();
    }, timeoutMs);

    function settle(value, isError = true) {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);

      if (isError) {
        reject(value);
      } else {
        resolve(value);
      }
    }

    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");

      if (newlineIndex === -1) {
        return;
      }

      const line = buffer.slice(0, newlineIndex);

      try {
        settle(JSON.parse(line), false);
      } catch (error) {
        settle(
          new Error(`Invalid broker response: ${error.message}`, {
            cause: error
          })
        );
      } finally {
        socket.end();
      }
    });

    socket.once("error", (error) => {
      settle(error);
    });

    socket.once("end", () => {
      if (!settled) {
        settle(new Error("Broker connection closed before a response."));
      }
    });
  });
}

export async function ensureBroker({
  stateDir,
  workspaceRoot = process.cwd(),
  nodePath = process.execPath,
  readyTimeoutMs = BROKER_READY_TIMEOUT_MS
} = {}) {
  if (!stateDir) {
    throw new Error("stateDir is required");
  }

  const existingSession = loadBrokerSession(stateDir);

  if (
    existingSession?.endpoint &&
    (await isBrokerReachable(existingSession.endpoint))
  ) {
    if (isCompatibleBrokerSession(existingSession, { workspaceRoot, stateDir })) {
      return existingSession;
    }

    await shutdownBroker(existingSession.endpoint);
    if (!(await waitUntilBrokerUnreachable(existingSession.endpoint, readyTimeoutMs))) {
      throw new Error("Existing broker is incompatible and could not be stopped.");
    }
    removeFileIfPresent(getBrokerSessionFile(stateDir));
  }

  const endpoint = getBrokerEndpoint({ stateDir });
  const logFile = getBrokerLogFile(stateDir);

  await cleanupStaleBroker(stateDir);

  if (await isBrokerReachable(endpoint)) {
    await shutdownBroker(endpoint);
    if (!(await waitUntilBrokerUnreachable(endpoint, readyTimeoutMs))) {
      throw new Error("Existing broker is incompatible and could not be stopped.");
    }
  }

  const child = spawnDetached(nodePath, [
    brokerScriptPath(),
    "--endpoint",
    endpoint,
    "--workspace",
    workspaceRoot,
    "--state-dir",
    stateDir
  ]);
  const session = {
    protocolVersion: BROKER_PROTOCOL_VERSION,
    endpoint,
    pid: child.pid ?? null,
    workspaceRoot,
    stateDir,
    logFile,
    startedAt: new Date().toISOString()
  };

  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (await isBrokerReachable(endpoint)) {
      saveBrokerSession(stateDir, session);
      return session;
    }

    await sleep(50);
  }

  throw new Error(`Broker did not become reachable within ${readyTimeoutMs}ms.`);
}

function isCompatibleBrokerSession(session, { workspaceRoot, stateDir }) {
  return (
    session?.protocolVersion === BROKER_PROTOCOL_VERSION &&
    session.workspaceRoot === workspaceRoot &&
    session.stateDir === stateDir
  );
}

async function shutdownBroker(endpoint) {
  try {
    await requestBroker(
      endpoint,
      { id: `shutdown-${Date.now()}`, method: "shutdown", params: {} },
      500
    );
  } catch {
    // Incompatible or stale brokers are best-effort to stop before respawn.
  }
}

async function waitUntilBrokerUnreachable(endpoint, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!(await isBrokerReachable(endpoint))) {
      return true;
    }

    await sleep(50);
  }

  return !(await isBrokerReachable(endpoint));
}

export async function cleanupStaleBroker(stateDir) {
  const session = loadBrokerSession(stateDir);
  const endpoints = new Set(
    [session?.endpoint, getBrokerEndpoint({ stateDir })].filter(Boolean)
  );

  if (session?.endpoint && (await isBrokerReachable(session.endpoint))) {
    return false;
  }

  removeFileIfPresent(getBrokerSessionFile(stateDir));

  for (const endpoint of endpoints) {
    if (!(await isBrokerReachable(endpoint))) {
      removeStaleSocketIfSafe(stateDir, endpoint);
    }
  }

  return true;
}

function removeStaleSocketIfSafe(stateDir, endpoint) {
  if (process.platform === "win32" || !isSafeSocketPath(stateDir, endpoint)) {
    return;
  }

  if (!isSocketFile(endpoint)) {
    return;
  }

  removeFileIfPresent(endpoint);
}

function isSafeSocketPath(stateDir, endpoint) {
  if (typeof endpoint !== "string" || !endpoint.endsWith(".sock")) {
    return false;
  }

  if (endpoint === getBrokerEndpoint({ stateDir })) {
    return true;
  }

  const relativePath = path.relative(stateDir, endpoint);
  return (
    relativePath !== "" &&
    !relativePath.startsWith("..") &&
    !path.isAbsolute(relativePath) &&
    /^broker-[a-f0-9]{12}\.sock$/.test(path.basename(endpoint))
  );
}

function isSocketFile(filePath) {
  try {
    return fs.lstatSync(filePath).isSocket();
  } catch {
    return false;
  }
}

function removeFileIfPresent(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Stale cleanup is best-effort; callers can still retry or respawn.
  }
}

function brokerScriptPath() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../claude-broker.mjs");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
