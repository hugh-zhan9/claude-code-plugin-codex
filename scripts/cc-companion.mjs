#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseCompanionArgs } from "./lib/args.mjs";
import {
  ensureBroker,
  isBrokerReachable,
  loadBrokerSession,
  requestBroker
} from "./lib/broker-lifecycle.mjs";
import {
  importClaudeSdk,
  isUnsupportedNativeReviewError,
  runAdversarialReview,
  runClaudeTask,
  runFallbackReview,
  runNativeReview
} from "./lib/claude.mjs";
import { buildReviewContext, resolveReviewTarget } from "./lib/git.mjs";
import { buildFallbackReviewPrompt, buildTaskPrompt } from "./lib/prompts.mjs";
import { taskPermission } from "./lib/permissions.mjs";
import { commandExists } from "./lib/process.mjs";
import {
  assertCanResume,
  cancelJob,
  renderBackgroundQueued,
  spawnTaskWorker
} from "./lib/job-control.mjs";
import {
  renderAdversarialReview,
  renderAdversarialReviewFailure,
  renderCancel,
  renderJson,
  renderReview,
  renderResult,
  renderSetup,
  renderStatus
} from "./lib/render.mjs";
import {
  createJob,
  findJob,
  getDefaultStateRoot,
  getWorkspaceStateDir,
  listJobs,
  loadJob,
  saveJob
} from "./lib/state.mjs";
import {
  markCancelled,
  markCompleted,
  markFailed,
  markRunning
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export async function runCompanion(argv = process.argv.slice(2), deps = {}) {
  const parsed = parseCompanionArgs(argv);

  const workspaceRoot = resolveWorkspaceRoot({
    cwd: parsed.options.cwd ?? deps.cwd ?? process.cwd()
  });
  const stateRoot = getDefaultStateRoot(deps.env ?? process.env);
  const stateDir = getWorkspaceStateDir(workspaceRoot, { stateRoot });

  if (parsed.command === "setup") {
    return runSetup({ parsed, deps, stateDir });
  }

  if (parsed.command === "task") {
    return runTask({ parsed, deps, workspaceRoot, stateDir });
  }

  if (parsed.command === "review") {
    return runReview({ parsed, deps, workspaceRoot, stateDir });
  }

  if (parsed.command === "adversarial-review") {
    return runAdversarial({ parsed, deps, workspaceRoot, stateDir });
  }

  if (parsed.command === "status") {
    return runStatus({ parsed, deps, workspaceRoot, stateDir });
  }

  if (parsed.command === "result") {
    return runResult({ parsed, stateDir });
  }

  if (parsed.command === "cancel") {
    return runCancel({ parsed, deps, workspaceRoot, stateDir });
  }

  if (parsed.command === "task-worker") {
    return runTaskWorker({ parsed, deps, workspaceRoot, stateDir });
  }

  throw new Error(`Command not implemented yet: ${parsed.command}`);
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const output = await runCompanion(argv);
    process.stdout.write(output);
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
}

async function runSetup({ parsed, deps, stateDir }) {
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

async function runTask({ parsed, deps, workspaceRoot, stateDir }) {
  if (parsed.options.fresh && parsed.options.resumeLast) {
    throw new Error("Cannot combine --fresh and --resume-last.");
  }

  if (parsed.options.write && parsed.options.readOnly) {
    throw new Error("Cannot combine --write and --read-only.");
  }

  const prompt = buildTaskPrompt(parsed.prompt ?? "");
  const resumeSessionId = parsed.options.resumeLast
    ? findLastCompletedTaskSession({ stateDir })
    : null;

  if (!prompt && !resumeSessionId) {
    throw new Error("Task prompt is required.");
  }

  const job = createJob({
    kind: "task",
    workspaceRoot,
    stateDir,
    request: {
      prompt,
      options: parsed.options,
      resumeSessionId
    }
  });

  if (parsed.options.background) {
    assertNoActiveOrQueuedJob({ stateDir, ignoreJobId: job.id });
    saveJob(job, { stateDir });
    const worker = spawnBackgroundWorker({ job, deps, workspaceRoot });
    job.worker = worker;
    saveLatestJobWithWorker({ job, stateDir });
    return renderBackgroundQueued(job);
  }

  saveJob(job, { stateDir });
  return executeTaskJob({ job, deps, workspaceRoot, stateDir });
}

async function executeTaskJob({ job, deps, workspaceRoot, stateDir }) {
  markRunning(job, { phase: "running" });
  saveJob(job, { stateDir });

  const requestOptions = job.request?.options ?? {};
  try {
    const result = await runClaudeExecution({
      kind: "task",
      job,
      deps,
      workspaceRoot,
      stateDir,
      directRun: () =>
        runClaudeTask({
          sdk: deps.sdk,
          prompt: job.request?.prompt ?? "",
          cwd: workspaceRoot,
          model: requestOptions.model,
          effort: requestOptions.effort,
          permission: taskPermission(requestOptions),
          resumeSessionId: job.request?.resumeSessionId ?? null,
          dangerouslyBypassPermissions:
            requestOptions.dangerouslyBypassPermissions
        }),
      request: {
        kind: "task",
        jobId: job.id,
        prompt: job.request?.prompt ?? "",
        options: requestOptions,
        resumeSessionId: job.request?.resumeSessionId ?? null
      }
    });

    storeClaudeResult(job, result);

    if (isJobTerminallyCancelled(job, { stateDir })) {
      throw new Error(`Job ${job.id} cancelled.`);
    }

    if (result.status === "completed") {
      const rendered = result.finalText ? `${result.finalText}\n` : "";
      markCompleted(job, result, { rendered });
      saveJob(job, { stateDir });
      return rendered || "No final output returned.\n";
    }

    if (isInterruptedResult(result)) {
      markCancelled(job, result.error?.message ?? "Claude task cancelled");
      job.result = result;
      saveJob(job, { stateDir });
      throw new Error(job.error.message);
    }

    markFailed(job, result.error?.message ?? `Claude task ${result.status}`);
    job.result = result;
    saveJob(job, { stateDir });
    throw new Error(job.error.message);
  } catch (error) {
    if (job.status !== "failed" && job.status !== "cancelled") {
      markFailed(job, error);
      saveJob(job, { stateDir });
    }

    throw error;
  }
}

function findLastCompletedTaskSession({ stateDir }) {
  return assertCanResume({
    jobs: listJobs({ stateDir, all: true }),
    activeJob: findActiveJob({ stateDir })
  });
}

async function runTaskWorker({ parsed, deps, workspaceRoot, stateDir }) {
  if (!parsed.jobRef) {
    throw new Error("Task worker requires a job id.");
  }

  const job = loadJob(parsed.jobRef, { stateDir });

  if (job.kind !== "task") {
    throw new Error(`Job ${job.id} is not a task job.`);
  }

  if (job.status !== "queued") {
    return `Job ${job.id} is already ${job.status}.\n`;
  }

  try {
    return await executeTaskJob({ job, deps, workspaceRoot, stateDir });
  } catch (error) {
    const latest = loadJob(job.id, { stateDir });

    if (isCancelledError(error)) {
      markCancelled(latest, error.message);
      saveJob(latest, { stateDir });
      return `Job ${job.id} cancelled.\n`;
    }

    throw error;
  }
}

async function runStatus({ parsed, deps, workspaceRoot, stateDir }) {
  const jobs = parsed.options.wait
    ? await waitForStatusJobs({ parsed, deps, stateDir })
    : statusJobs({ parsed, stateDir });

  return parsed.options.json
    ? renderJson({ workspaceRoot, jobs })
    : renderStatus({ workspaceRoot, jobs });
}

function statusJobs({ parsed, stateDir }) {
  const jobs = parsed.jobRef
    ? [findJob(parsed.jobRef, { stateDir })]
    : listJobs({ stateDir, all: Boolean(parsed.options.all) });

  return jobs;
}

async function waitForStatusJobs({ parsed, deps, stateDir }) {
  const waitOptions = deps.statusWait ?? {};
  const intervalMs = Number(waitOptions.intervalMs ?? 1000);
  const timeoutMs = Number(waitOptions.timeoutMs ?? 30 * 60 * 1000);
  const deadline = Date.now() + timeoutMs;
  let jobs = statusJobs({ parsed, stateDir });

  while (jobs.some((job) => job.status === "queued" || job.status === "running")) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for Claude Code job to finish.");
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    jobs = statusJobs({ parsed, stateDir });
  }

  return jobs;
}

function runResult({ parsed, stateDir }) {
  const job = findJob(parsed.jobRef ?? "", { stateDir });

  if (job.status === "queued" || job.status === "running") {
    return `Job ${job.id} is ${job.status}. Run \`claude-code-status ${job.id}\` later.\n`;
  }

  return renderResult(job);
}

async function runCancel({ parsed, deps, workspaceRoot, stateDir }) {
  const job = parsed.jobRef
    ? findJob(parsed.jobRef, { stateDir })
    : findActiveJob({ stateDir }) ?? findJob("", { stateDir });
  const brokerClient =
    job.status === "running"
      ? await resolveBrokerClient({ deps, workspaceRoot, stateDir })
      : deps.brokerClient ?? null;
  const result = await cancelJob({
    job,
    stateDir,
    brokerClient
  });

  return renderCancel(result);
}

function spawnBackgroundWorker({ job, deps, workspaceRoot }) {
  if (deps.backgroundRunner?.spawnWorker) {
    return deps.backgroundRunner.spawnWorker(job);
  }

  return spawnTaskWorker({
    job,
    companionPath: fileURLToPath(import.meta.url),
    cwd: workspaceRoot,
    env: { ...process.env, ...(deps.env ?? {}) }
  });
}

function saveLatestJobWithWorker({ job, stateDir }) {
  const latest = loadJob(job.id, { stateDir });
  latest.worker = job.worker;
  saveJob(latest, { stateDir });
}

function findActiveJob({ stateDir }) {
  const active = listJobs({ stateDir, all: true }).find(
    (job) => job.status === "running"
  );

  return active ? loadJob(active.id, { stateDir }) : null;
}

function assertNoActiveOrQueuedJob({ stateDir, ignoreJobId = null }) {
  const active = listJobs({ stateDir, all: true }).find(
    (job) =>
      job.id !== ignoreJobId &&
      (job.status === "queued" || job.status === "running")
  );

  if (active) {
    throw new Error(
      "A Claude Code job is already running in this workspace. Run claude-code-status or claude-code-cancel."
    );
  }
}

function isJobTerminallyCancelled(job, { stateDir }) {
  try {
    return loadJob(job.id, { stateDir }).status === "cancelled";
  } catch {
    return false;
  }
}

function isCancelledError(error) {
  return /cancel/i.test(error?.message ?? "");
}

async function runReview({ parsed, deps, workspaceRoot, stateDir }) {
  const context = deps.reviewContext ?? buildContext({ parsed, workspaceRoot });
  const job = createReviewJob({ kind: "review", parsed, workspaceRoot, stateDir, context });

  try {
    let result;

    result = await runClaudeExecution({
      kind: "review",
      job,
      deps,
      workspaceRoot,
      stateDir,
      directRun: () =>
        runDirectReview({
          deps,
          workspaceRoot,
          context,
          options: parsed.options
        }),
      request: {
        kind: "review",
        jobId: job.id,
        context,
        fallbackPrompt: buildFallbackReviewPrompt(context),
        options: parsed.options
      }
    });

    assertCompletedClaudeResult(result, "Claude review");
    storeClaudeResult(job, result);
    const rendered = renderReview({
      text: result.finalText,
      fallbackUsed: result.fallbackUsed,
      target: context.target?.description
    });
    markCompleted(job, result, { rendered });
    saveJob(job, { stateDir });
    return rendered;
  } catch (error) {
    if (error.result) {
      storeClaudeResult(job, error.result);
      job.result = error.result;
    }
    markFailed(job, error);
    saveJob(job, { stateDir });
    throw error;
  }
}

async function runAdversarial({ parsed, deps, workspaceRoot, stateDir }) {
  const context = deps.reviewContext ?? buildContext({ parsed, workspaceRoot });
  const prompt = {
    ...context,
    focus: parsed.prompt ?? ""
  };
  const job = createReviewJob({
    kind: "adversarial-review",
    parsed,
    workspaceRoot,
    stateDir,
    context,
    prompt: parsed.prompt ?? ""
  });

  try {
    const result = await runClaudeExecution({
      kind: "adversarial-review",
      job,
      deps,
      workspaceRoot,
      stateDir,
      directRun: () =>
        runAdversarialReview({
          sdk: deps.sdk,
          prompt,
          cwd: workspaceRoot,
          model: parsed.options.model,
          effort: parsed.options.effort
        }),
      request: {
        kind: "adversarial-review",
        jobId: job.id,
        prompt,
        options: parsed.options
      }
    });

    assertCompletedClaudeResult(result, "Claude adversarial review");
    storeClaudeResult(job, result);
    const rendered = result.structured
      ? renderAdversarialReview(result.structured)
      : renderAdversarialReviewFailure({
          text: result.finalText,
          parseError: result.parseError,
          target: context.target?.description
        });

    markCompleted(job, result, { rendered });
    saveJob(job, { stateDir });
    return rendered;
  } catch (error) {
    if (error.result) {
      storeClaudeResult(job, error.result);
      job.result = error.result;
    }
    markFailed(job, error);
    saveJob(job, { stateDir });
    throw error;
  }
}

function createReviewJob({ kind, parsed, workspaceRoot, stateDir, context, prompt = "" }) {
  const job = createJob({
    kind,
    workspaceRoot,
    stateDir,
    request: {
      prompt,
      options: parsed.options,
      target: context.target,
      files: context.files,
      inline: context.inline
    }
  });
  saveJob(job, { stateDir });
  markRunning(job, { phase: "running" });
  saveJob(job, { stateDir });
  return job;
}

function buildContext({ parsed, workspaceRoot }) {
  const target = resolveReviewTarget({
    workspaceRoot,
    base: parsed.options.base,
    scope: parsed.options.scope ?? "auto"
  });

  return buildReviewContext({ workspaceRoot, target });
}

async function runDirectReview({ deps, workspaceRoot, context, options }) {
  try {
    const result = await runNativeReview({
      sdk: deps.sdk,
      cwd: workspaceRoot,
      context,
      model: options.model,
      effort: options.effort
    });

    if (isUnsupportedNativeReviewError(result.error)) {
      throw unsupportedNativeReviewResultError(result.error);
    }

    return result;
  } catch (error) {
    if (!isUnsupportedNativeReviewError(error)) {
      throw error;
    }

    return runFallbackReview({
      sdk: deps.sdk,
      prompt: buildFallbackReviewPrompt(context),
      cwd: workspaceRoot,
      model: options.model,
      effort: options.effort
    });
  }
}

async function runClaudeExecution({
  deps,
  workspaceRoot,
  stateDir,
  directRun,
  request
}) {
  if (deps.disableBroker) {
    return directRun();
  }

  const brokerClient = await resolveBrokerClient({ deps, workspaceRoot, stateDir });

  try {
    return await brokerClient.run(request);
  } catch (error) {
    throw normalizeBrokerError(error);
  }
}

async function resolveBrokerClient({ deps, workspaceRoot, stateDir }) {
  if (deps.brokerClient) {
    return deps.brokerClient;
  }

  const session = await ensureBroker({ stateDir, workspaceRoot });

  return {
    async run(params) {
      return unwrapBrokerResponse(
        await requestBroker(session.endpoint, {
          id: `run-${params.jobId ?? Date.now()}`,
          method: "run",
          params
        })
      );
    },
    async interrupt(params) {
      return unwrapBrokerResponse(
        await requestBroker(session.endpoint, {
          id: `interrupt-${params.jobId ?? Date.now()}`,
          method: "interrupt",
          params
        })
      );
    }
  };
}

function unwrapBrokerResponse(response) {
  if (response?.error) {
    const error = new Error(response.error.message ?? "Broker request failed.");
    error.code = response.error.code;
    throw error;
  }

  return response?.result;
}

function normalizeBrokerError(error) {
  if (error?.code === "BUSY") {
    return new Error(
      "A Claude Code job is already running in this workspace. Run claude-code-status or claude-code-cancel."
    );
  }

  return error;
}

function isInterruptedResult(result) {
  return result?.status === "interrupted" || result?.interrupted === true;
}

function storeClaudeResult(job, result) {
  job.claudeSessionId = result.claudeSessionId ?? null;
}

function assertCompletedClaudeResult(result, label) {
  if (result.status === "completed") {
    return;
  }

  const error = new Error(result.error?.message ?? `${label} ${result.status}`);
  error.result = result;
  throw error;
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

function unsupportedNativeReviewResultError(error) {
  const message =
    error?.message ??
    error?.errors?.join("\n") ??
    "Native Claude review is unsupported.";
  const wrapped = new Error(message);
  wrapped.code = "UNSUPPORTED_NATIVE_REVIEW";
  return wrapped;
}

if (isDirectCliInvocation()) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}

function isDirectCliInvocation() {
  if (!process.argv[1]) {
    return false;
  }

  try {
    return (
      fileURLToPath(import.meta.url) ===
      fs.realpathSync(path.resolve(process.argv[1]))
    );
  } catch {
    return false;
  }
}
