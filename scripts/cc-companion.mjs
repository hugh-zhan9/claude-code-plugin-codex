#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCompanionArgs } from "./lib/args.mjs";
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
import { commandExists } from "./lib/process.mjs";
import {
  renderAdversarialReview,
  renderAdversarialReviewFailure,
  renderJson,
  renderReview,
  renderSetup
} from "./lib/render.mjs";
import {
  createJob,
  getDefaultStateRoot,
  getWorkspaceStateDir,
  listJobs,
  loadJob,
  saveJob
} from "./lib/state.mjs";
import { markCompleted, markFailed, markRunning } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export async function runCompanion(argv = process.argv.slice(2), deps = {}) {
  const parsed = parseCompanionArgs(argv);

  const workspaceRoot = resolveWorkspaceRoot({
    cwd: parsed.options.cwd ?? deps.cwd ?? process.cwd()
  });
  const stateRoot = getDefaultStateRoot(deps.env ?? process.env);
  const stateDir = getWorkspaceStateDir(workspaceRoot, { stateRoot });

  if (parsed.command === "setup") {
    return runSetup(parsed, deps);
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

async function runSetup(parsed, deps) {
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
  }

  const report = {
    title: "Claude Code Plugin Setup",
    checks,
    nextSteps: setupNextSteps(checks)
  };

  return parsed.options.json ? renderJson(report) : renderSetup(report);
}

async function runTask({ parsed, deps, workspaceRoot, stateDir }) {
  if (parsed.options.background) {
    throw new Error("Background tasks are not implemented yet.");
  }

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
  saveJob(job, { stateDir });
  markRunning(job, { phase: "running" });
  saveJob(job, { stateDir });

  try {
    const result = await runClaudeTask({
      sdk: deps.sdk,
      prompt,
      cwd: workspaceRoot,
      model: parsed.options.model,
      effort: parsed.options.effort,
      permission: taskPermission(parsed.options),
      resumeSessionId,
      dangerouslyBypassPermissions: parsed.options.dangerouslyBypassPermissions
    });

    storeClaudeResult(job, result);

    if (result.status === "completed") {
      const rendered = result.finalText ? `${result.finalText}\n` : "";
      markCompleted(job, result, { rendered });
      saveJob(job, { stateDir });
      return rendered || "No final output returned.\n";
    }

    markFailed(job, result.error?.message ?? `Claude task ${result.status}`);
    job.result = result;
    saveJob(job, { stateDir });
    throw new Error(job.error.message);
  } catch (error) {
    if (job.status !== "failed") {
      markFailed(job, error);
      saveJob(job, { stateDir });
    }

    throw error;
  }
}

function findLastCompletedTaskSession({ stateDir }) {
  const jobs = listJobs({ stateDir, all: true });

  for (const summary of jobs) {
    if (summary.kind !== "task" || summary.status !== "completed") {
      continue;
    }

    const job = loadJob(summary.id, { stateDir });
    if (job.claudeSessionId) {
      return job.claudeSessionId;
    }
  }

  throw new Error("No completed task job with a Claude session to resume.");
}

async function runReview({ parsed, deps, workspaceRoot, stateDir }) {
  const context = deps.reviewContext ?? buildContext({ parsed, workspaceRoot });
  const job = createReviewJob({ kind: "review", parsed, workspaceRoot, stateDir, context });

  try {
    let result;

    try {
      result = await runNativeReview({
        sdk: deps.sdk,
        cwd: workspaceRoot,
        context,
        model: parsed.options.model,
        effort: parsed.options.effort
      });

      if (isUnsupportedNativeReviewError(result.error)) {
        throw unsupportedNativeReviewResultError(result.error);
      }
    } catch (error) {
      if (!isUnsupportedNativeReviewError(error)) {
        throw error;
      }

      result = await runFallbackReview({
        sdk: deps.sdk,
        prompt: buildFallbackReviewPrompt(context),
        cwd: workspaceRoot,
        model: parsed.options.model,
        effort: parsed.options.effort
      });
    }

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
    const result = await runAdversarialReview({
      sdk: deps.sdk,
      prompt,
      cwd: workspaceRoot,
      model: parsed.options.model,
      effort: parsed.options.effort
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

function taskPermission(options) {
  if (options.readOnly) {
    return "read-only";
  }

  return "workspace-write";
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
