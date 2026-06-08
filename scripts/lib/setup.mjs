import { spawnSync } from "node:child_process";
import { isBrokerReachable, loadBrokerSession } from "./broker-lifecycle.mjs";
import { importClaudeSdk } from "./claude.mjs";
import { commandExists } from "./process.mjs";
import { renderJson, renderSetup } from "./render.mjs";

export async function runSetup({ parsed, deps, stateDir }) {
  const diagnostics = deps.diagnostics ?? {};
  const checks = [];

  const nodeVersion = diagnostics.nodeVersion ?? process.version;
  checks.push({
    name: "Node.js",
    ok: isSupportedNodeVersion(nodeVersion),
    detail: nodeVersion
  });

  const hasClaudeCli =
    diagnostics.hasClaudeCli ??
    (deps.commandExists ?? commandExists)("claude");
  checks.push({
    name: "Claude Code CLI",
    ok: Boolean(hasClaudeCli),
    detail: hasClaudeCli ? "found" : "not found"
  });

  const sdkImportCheck = await checkSdkImport({ diagnostics, deps });
  checks.push(sdkImportCheck);
  checks.push(await checkBroker({ diagnostics, deps, stateDir }));

  if (Object.hasOwn(diagnostics, "claudeReady")) {
    checks.push({
      name: "Claude Code auth",
      ok: Boolean(diagnostics.claudeReady),
      detail: diagnostics.claudeReady ? "ready" : "not ready"
    });
  } else if (typeof diagnostics.checkClaudeReady === "function") {
    const claudeReady = await diagnostics.checkClaudeReady();
    checks.push({
      name: "Claude Code auth",
      ok: Boolean(claudeReady),
      detail: claudeReady ? "ready" : "not ready"
    });
  } else {
    const claudeReady = await checkClaudeReady({ deps });
    checks.push({
      name: "Claude Code auth",
      ok: Boolean(claudeReady),
      detail: claudeReady ? "ready" : "not ready"
    });
  }

  const report = {
    title: "Claude Code Plugin Setup",
    checks,
    nextSteps: setupNextSteps(checks)
  };

  return parsed.options.json ? renderJson(report) : renderSetup(report);
}

async function checkSdkImport({ diagnostics, deps }) {
  if (Object.hasOwn(diagnostics, "sdkImportOk")) {
    return {
      name: "Claude Agent SDK",
      ok: Boolean(diagnostics.sdkImportOk),
      detail: diagnostics.sdkImportOk ? "importable" : "not importable"
    };
  }

  try {
    await (deps.importClaudeSdk ?? importClaudeSdk)();
    return {
      name: "Claude Agent SDK",
      ok: true,
      detail: "importable"
    };
  } catch (error) {
    return {
      name: "Claude Agent SDK",
      ok: false,
      detail: error?.message ?? String(error)
    };
  }
}

async function checkClaudeReady({ deps }) {
  if (typeof deps.checkClaudeReady === "function") {
    return Boolean(await deps.checkClaudeReady());
  }

  const runAuthStatus =
    deps.runClaudeAuthStatus ??
    (() =>
      spawnSync("claude", ["auth", "status"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }));
  const result = runAuthStatus();

  if (result?.status !== 0) {
    return false;
  }

  const stdout = String(result.stdout ?? "").trim();

  if (!stdout) {
    return true;
  }

  try {
    const parsed = JSON.parse(stdout);
    return parsed.loggedIn !== false;
  } catch {
    return !/not\s+(logged|authenticated)|logged\s+out/i.test(stdout);
  }
}

async function checkBroker({ diagnostics, deps, stateDir }) {
  if (Object.hasOwn(diagnostics, "brokerReachable")) {
    return {
      name: "Claude Broker",
      ok: true,
      detail: diagnostics.brokerReachable ? "running" : "not running"
    };
  }

  if (typeof deps.checkBroker === "function") {
    const brokerReachable = await deps.checkBroker();
    return {
      name: "Claude Broker",
      ok: true,
      detail: brokerReachable ? "running" : "not running"
    };
  }

  const session = loadBrokerSession(stateDir);
  const reachable =
    Boolean(session?.endpoint) && (await isBrokerReachable(session.endpoint));

  return {
    name: "Claude Broker",
    ok: true,
    detail: reachable ? "running" : "not running (starts on demand)"
  };
}

function setupNextSteps(checks) {
  const steps = [];

  if (!checks.find((check) => check.name === "Node.js")?.ok) {
    steps.push("Install Node.js 20 or newer.");
  }

  if (!checks.find((check) => check.name === "Claude Code CLI")?.ok) {
    steps.push("Install the Claude Code CLI and ensure `claude` is on PATH.");
  }

  if (!checks.find((check) => check.name === "Claude Agent SDK")?.ok) {
    steps.push("Run `npm install` from the plugin directory.");
  }

  const authCheck = checks.find((check) => check.name === "Claude Code auth");
  if (authCheck && !authCheck.ok) {
    steps.push("Run `claude login`, then retry setup.");
  }

  return steps;
}

function isSupportedNodeVersion(version) {
  const major = Number(String(version).replace(/^v/, "").split(".")[0]);
  return Number.isInteger(major) && major >= 20;
}
