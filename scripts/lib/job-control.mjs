import path from "node:path";
import { spawnDetached } from "./process.mjs";
import { saveJob } from "./state.mjs";
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
    markCancelled(job, "cancelled");
    saveJob(job, { stateDir });
    return { id: job.id, cancelled: true, detail: "cancelled" };
  }

  if (job.status === "running") {
    const detail = await interruptRunningJob({ job, brokerClient });
    markCancelled(job, detail);
    saveJob(job, { stateDir });
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

async function interruptRunningJob({ job, brokerClient }) {
  if (!brokerClient || typeof brokerClient.interrupt !== "function") {
    return "cancelled";
  }

  const result = await brokerClient.interrupt({ jobId: job.id });
  return result?.detail ?? (result?.interrupted ? "interrupted" : "cancelled");
}

function quote(value) {
  const text = String(value ?? "");

  if (!text || /[\s"']/.test(text)) {
    return JSON.stringify(text);
  }

  return path.normalize(text);
}
