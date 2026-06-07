import path from "node:path";
import { spawnDetached } from "./process.mjs";
import { loadJob, saveJob } from "./state.mjs";
import { markCancelled } from "./tracked-jobs.mjs";

export function chooseRecentRunnableSession(jobs = []) {
  return jobs.find(
    (job) =>
      job.kind === "task" &&
      job.status === "completed" &&
      Boolean(job.claudeSessionId)
  );
}

export function renderBackgroundQueued(job) {
  return [
    "# Claude Code Task Queued",
    "",
    `Job: ${job.id}`,
    `Status: ${job.status}`,
    "",
    `Status: \`claude-code-status ${job.id}\``,
    `Result: \`claude-code-result ${job.id}\``
  ].join("\n") + "\n";
}

export function spawnTaskWorker({ job, companionPath, cwd, env }) {
  const args = [companionPath, "task-worker", job.id];
  const child = spawnDetached(process.execPath, args, { cwd, env });
  const command = `${quote(process.execPath)} ${args.map(quote).join(" ")}`;

  job.worker = {
    pid: child.pid ?? null,
    command
  };

  return job.worker;
}

export async function cancelJob({ job, stateDir, brokerClient = null }) {
  if (job.status === "queued") {
    const latest = loadJob(job.id, { stateDir });
    markCancelled(latest, "cancelled");
    saveJob(latest, { stateDir });
    return { id: job.id, cancelled: true, detail: "cancelled" };
  }

  if (job.status === "running") {
    const detail = await stopRunningJob({ job, brokerClient });
    const latest = loadJob(job.id, { stateDir });
    markCancelled(latest, detail);
    saveJob(latest, { stateDir });
    return { id: job.id, cancelled: true, detail };
  }

  return {
    id: job.id,
    cancelled: false,
    detail: `Job is already ${job.status}.`
  };
}

export function assertCanResume({ jobs = [], activeJob = null } = {}) {
  if (activeJob || jobs.some((job) => job.status === "running")) {
    throw new Error(
      "A Claude Code job is already running. Cancel it or wait before resuming."
    );
  }

  const recent = chooseRecentRunnableSession(jobs);

  if (!recent) {
    throw new Error("No completed task job with a Claude session to resume.");
  }

  return recent.claudeSessionId;
}

async function stopRunningJob({ job, brokerClient }) {
  if (brokerClient && typeof brokerClient.interrupt === "function") {
    const result = await brokerClient.interrupt({ jobId: job.id });

    if (result?.interrupted) {
      return result.detail ?? "interrupted";
    }

    if (!tryKillWorker(job.worker)) {
      throw new Error(result?.detail ?? "Claude Code job did not acknowledge cancellation.");
    }

    return result?.detail ? `${result.detail}; worker terminated` : "worker terminated";
  }

  if (tryKillWorker(job.worker)) {
    return "worker terminated";
  }

  throw new Error("Cannot cancel running job without broker interrupt or worker pid.");
}

function tryKillWorker(worker) {
  const pid = worker?.pid;

  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(-pid, "SIGTERM");
    return true;
  } catch {
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
}

function quote(value) {
  const text = String(value ?? "");

  if (!text || /[\s"']/.test(text)) {
    return JSON.stringify(text);
  }

  return path.normalize(text);
}
