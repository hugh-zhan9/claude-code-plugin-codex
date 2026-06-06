import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

const POSIX_SOCKET_PATH_LIMIT = 100;
const FALLBACK_SOCKET_HASH_LENGTH = 24;

export function getBrokerSessionFile(stateDir) {
  return path.join(stateDir, "broker.json");
}

export function getBrokerLogFile(stateDir) {
  return path.join(stateDir, "broker.log");
}

export function getBrokerEndpoint({ stateDir, platform = process.platform } = {}) {
  if (!stateDir) {
    throw new Error("stateDir is required");
  }

  const hash = crypto.createHash("sha256").update(stateDir).digest("hex");

  if (platform === "win32") {
    return `\\\\.\\pipe\\claude-code-plugin-codex-${hash}`;
  }

  const stateEndpoint = path.join(stateDir, `broker-${hash.slice(0, 12)}.sock`);

  if (stateEndpoint.length <= POSIX_SOCKET_PATH_LIMIT) {
    return stateEndpoint;
  }

  const fallbackName = `claude-code-plugin-codex-${hash.slice(
    0,
    FALLBACK_SOCKET_HASH_LENGTH
  )}.sock`;
  const tempEndpoint = path.join(os.tmpdir(), fallbackName);

  if (tempEndpoint.length <= POSIX_SOCKET_PATH_LIMIT) {
    return tempEndpoint;
  }

  return path.join("/tmp", fallbackName);
}
