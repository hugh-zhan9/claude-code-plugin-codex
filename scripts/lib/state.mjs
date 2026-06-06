import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteJson, ensureDir, readJsonFile } from "./fs.mjs";
import { workspaceDisplayName } from "./workspace.mjs";

export const MAX_JOBS = 50;

export function getDefaultStateRoot(env = process.env) {
  return (
    env.CODEX_PLUGIN_DATA ||
    env.CLAUDE_CODE_PLUGIN_CODEX_DATA ||
    path.join(os.tmpdir(), "claude-code-companion")
  );
}

export function getWorkspaceStateDir(
  workspaceRoot,
  { stateRoot = getDefaultStateRoot() } = {}
) {
  const realWorkspaceRoot = fs.realpathSync(path.resolve(workspaceRoot));
  const hash = crypto
    .createHash("sha256")
    .update(realWorkspaceRoot)
    .digest("hex")
    .slice(0, 16);
  const name = sanitizeName(workspaceDisplayName(realWorkspaceRoot));

  return path.join(stateRoot, `workspace-${name}-${hash}`);
}

export function loadWorkspaceState(stateDir) {
  return readJsonFile(path.join(stateDir, "state.json"), { version: 1, jobs: [] });
}

export function saveWorkspaceState(stateDir, state) {
  ensureDir(stateDir);

  const sortedJobs = Array.from(state.jobs ?? []).sort(compareJobsByRecency);
  const jobs = sortedJobs.slice(0, MAX_JOBS);

  deletePrunedJobFiles(stateDir, sortedJobs.slice(MAX_JOBS), new Set(jobs.map((job) => job.id)));

  atomicWriteJson(path.join(stateDir, "state.json"), {
    version: state.version ?? 1,
    jobs
  });
}

export function createJob({
  kind,
  workspaceRoot,
  request,
  stateDir,
  now = () => new Date().toISOString()
}) {
  const id = `${kind}-${Date.now().toString(36)}-${crypto
    .randomUUID()
    .replaceAll("-", "")
    .slice(0, 12)}`;
  const timestamp = now();

  return {
    id,
    kind,
    status: "queued",
    phase: "queued",
    workspaceRoot,
    createdAt: timestamp,
    updatedAt: timestamp,
    request,
    result: null,
    rendered: null,
    claudeSessionId: null,
    worker: null,
    error: null,
    logFile: path.join(stateDir, "jobs", `${id}.log`)
  };
}

export function saveJob(job, { stateDir }) {
  atomicWriteJson(jobPath(stateDir, job.id), job);

  const state = loadWorkspaceState(stateDir);
  const jobs = Array.from(state.jobs ?? []).filter((entry) => entry.id !== job.id);
  jobs.push(jobSummary(job));

  saveWorkspaceState(stateDir, {
    version: state.version,
    jobs
  });
}

export function loadJob(id, { stateDir }) {
  const job = readJsonFile(jobPath(stateDir, id));

  if (!job) {
    throw new Error(`No job found for id: ${id}`);
  }

  return job;
}

export function findJob(ref = "", { stateDir }) {
  const jobs = listJobs({ stateDir });

  if (!ref) {
    const [mostRecent] = jobs;

    if (!mostRecent) {
      throw new Error("No jobs found");
    }

    return loadJob(mostRecent.id, { stateDir });
  }

  const exactMatch = jobs.find((job) => job.id === ref);

  if (exactMatch) {
    return loadJob(exactMatch.id, { stateDir });
  }

  const prefixMatches = jobs.filter((job) => job.id.startsWith(ref));

  if (prefixMatches.length === 1) {
    return loadJob(prefixMatches[0].id, { stateDir });
  }

  if (prefixMatches.length > 1) {
    const ids = prefixMatches.map((job) => job.id).join(", ");
    throw new Error(`Ambiguous job reference "${ref}": ${ids}`);
  }

  throw new Error(`No job found for reference: ${ref}`);
}

export function listJobs({ stateDir, all = false } = {}) {
  const state = loadWorkspaceState(stateDir);
  const jobs = Array.from(state.jobs ?? []).sort(compareJobsByRecency);

  return all ? jobs : jobs.slice(0, MAX_JOBS);
}

function sanitizeName(name) {
  const sanitized = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return sanitized || "workspace";
}

function jobPath(stateDir, id) {
  return path.join(stateDir, "jobs", `${id}.json`);
}

function jobSummary(job) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    phase: job.phase,
    updatedAt: job.updatedAt,
    createdAt: job.createdAt,
    claudeSessionId: job.claudeSessionId,
    logFile: job.logFile
  };
}

function compareJobsByRecency(left, right) {
  return (
    compareDesc(left.updatedAt, right.updatedAt) ||
    compareDesc(left.createdAt, right.createdAt) ||
    compareDesc(left.id, right.id)
  );
}

function compareDesc(left, right) {
  return String(right ?? "").localeCompare(String(left ?? ""));
}

function deletePrunedJobFiles(stateDir, prunedJobs, keptIds) {
  for (const job of prunedJobs) {
    if (!isSafeJobFileId(job.id) || keptIds.has(job.id)) {
      continue;
    }

    removeFileIfPresent(prunedJobFilePath(stateDir, job.id, ".json"));
    removeFileIfPresent(prunedJobFilePath(stateDir, job.id, ".log"));
  }
}

function removeFileIfPresent(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch (error) {
    throw new Error(`Failed to remove pruned job file ${filePath}: ${error.message}`, {
      cause: error
    });
  }
}

function isSafeJobFileId(id) {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    !path.isAbsolute(id) &&
    !id.includes("/") &&
    !id.includes("\\")
  );
}

function prunedJobFilePath(stateDir, id, extension) {
  return path.join(stateDir, "jobs", `${id}${extension}`);
}
