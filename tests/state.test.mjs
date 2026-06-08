import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createJob,
  findJob,
  getDefaultStateRoot,
  getWorkspaceStateDir,
  listJobs,
  loadJob,
  loadWorkspaceState,
  saveJob,
  saveWorkspaceState
} from "../scripts/lib/state.mjs";
import {
  markCancelled,
  markCompleted,
  markFailed,
  markRunning,
  updatePhase
} from "../scripts/lib/tracked-jobs.mjs";
import { makeTempDir } from "./helpers.mjs";

test("getDefaultStateRoot uses configured env vars before temp fallback", () => {
  assert.equal(
    getDefaultStateRoot({
      CODEX_PLUGIN_DATA: "/codex-data",
      CLAUDE_CODE_PLUGIN_CODEX_DATA: "/legacy-data"
    }),
    "/codex-data"
  );
  assert.equal(
    getDefaultStateRoot({ CLAUDE_CODE_PLUGIN_CODEX_DATA: "/legacy-data" }),
    "/legacy-data"
  );
  assert.match(getDefaultStateRoot({}), /claude-code-companion$/);
});

test("getWorkspaceStateDir returns a stable directory under the state root", () => {
  const workspaceRoot = makeTempDir("task-workspace-");
  const stateRoot = makeTempDir("task-state-");

  const first = getWorkspaceStateDir(workspaceRoot, { stateRoot });
  const second = getWorkspaceStateDir(workspaceRoot, { stateRoot });

  assert.equal(first, second);
  assert.equal(path.dirname(first), stateRoot);
  assert.match(path.basename(first), /^workspace-[a-z0-9]+-[a-f0-9]{16}$/);
});

test("loadWorkspaceState returns empty state for missing state file", () => {
  const stateDir = makeTempDir("task-state-");

  assert.deepEqual(loadWorkspaceState(stateDir), { version: 1, jobs: [] });
  assert.equal(fs.existsSync(path.join(stateDir, "state.json")), false);
});

test("createJob, saveJob, and findJob persist a task job by unique prefix", () => {
  const workspaceRoot = makeTempDir("task-workspace-");
  const stateDir = makeTempDir("task-state-");
  const job = createJob({
    kind: "task",
    workspaceRoot,
    stateDir,
    request: { prompt: "fix auth", options: { background: true } },
    now: () => "2026-06-06T07:00:00.000Z"
  });

  assert.match(job.id, /^task-/);
  assert.equal(job.status, "queued");
  assert.equal(job.phase, "queued");
  assert.equal(job.createdAt, "2026-06-06T07:00:00.000Z");
  assert.equal(job.updatedAt, "2026-06-06T07:00:00.000Z");
  assert.equal(job.workspaceRoot, workspaceRoot);
  assert.equal(job.result, null);
  assert.equal(job.rendered, null);
  assert.equal(job.claudeSessionId, null);
  assert.equal(job.worker, null);
  assert.equal(job.error, null);
  assert.equal(job.logFile, path.join(stateDir, "jobs", `${job.id}.log`));

  saveJob(job, { stateDir });

  const loaded = loadJob(job.id, { stateDir });
  assert.deepEqual(loaded, job);
  assert.deepEqual(findJob(job.id.slice(0, 12), { stateDir }), job);

  const index = loadWorkspaceState(stateDir);
  assert.deepEqual(index.jobs, [
    {
      id: job.id,
      kind: "task",
      status: "queued",
      phase: "queued",
      updatedAt: "2026-06-06T07:00:00.000Z",
      createdAt: "2026-06-06T07:00:00.000Z",
      claudeSessionId: null,
      logFile: job.logFile
    }
  ]);
});

test("saveWorkspaceState prunes to 50 jobs sorted by most recently updated", () => {
  const stateDir = makeTempDir("task-state-");
  const jobs = Array.from({ length: 55 }, (_, index) => {
    const id = `task-${String(index).padStart(2, "0")}`;

    return {
      id,
      kind: "task",
      status: "completed",
      phase: "completed",
      createdAt: "2026-06-06T07:00:00.000Z",
      updatedAt: `2026-06-06T07:${String(index).padStart(2, "0")}:00.000Z`,
      claudeSessionId: null,
      logFile: path.join(stateDir, "jobs", `${id}.log`)
    };
  });

  saveWorkspaceState(stateDir, { version: 1, jobs });

  const savedJobs = listJobs({ stateDir, all: true });
  assert.equal(savedJobs.length, 50);
  assert.equal(savedJobs[0].id, "task-54");
  assert.equal(savedJobs.at(-1).id, "task-05");
});

test("saveWorkspaceState removes pruned job files and logs only", () => {
  const stateDir = makeTempDir("task-state-");
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const unrelatedFile = path.join(jobsDir, "notes.txt");
  fs.writeFileSync(unrelatedFile, "do not delete", "utf8");

  const jobs = Array.from({ length: 55 }, (_, index) => {
    const id = `task-${String(index).padStart(2, "0")}`;
    const logFile = path.join(jobsDir, `${id}.log`);

    fs.writeFileSync(path.join(jobsDir, `${id}.json`), "{}", "utf8");
    fs.writeFileSync(logFile, "log", "utf8");

    return {
      id,
      kind: "task",
      status: "completed",
      phase: "completed",
      createdAt: "2026-06-06T07:00:00.000Z",
      updatedAt: `2026-06-06T07:${String(index).padStart(2, "0")}:00.000Z`,
      claudeSessionId: null,
      logFile
    };
  });

  saveWorkspaceState(stateDir, { version: 1, jobs });

  assert.equal(fs.existsSync(path.join(jobsDir, "task-04.json")), false);
  assert.equal(fs.existsSync(path.join(jobsDir, "task-04.log")), false);
  assert.equal(fs.existsSync(path.join(jobsDir, "task-05.json")), true);
  assert.equal(fs.existsSync(path.join(jobsDir, "task-05.log")), true);
  assert.equal(fs.readFileSync(unrelatedFile, "utf8"), "do not delete");
});

test("saveWorkspaceState still saves pruned state when deleting a pruned file fails", () => {
  const stateDir = makeTempDir("task-state-");
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const originalRmSync = fs.rmSync;
  const failingId = "task-04";
  const jobs = Array.from({ length: 55 }, (_, index) => {
    const id = `task-${String(index).padStart(2, "0")}`;
    const logFile = path.join(jobsDir, `${id}.log`);

    fs.writeFileSync(path.join(jobsDir, `${id}.json`), "{}", "utf8");
    fs.writeFileSync(logFile, "log", "utf8");

    return {
      id,
      kind: "task",
      status: "completed",
      phase: "completed",
      createdAt: "2026-06-06T07:00:00.000Z",
      updatedAt: `2026-06-06T07:${String(index).padStart(2, "0")}:00.000Z`,
      claudeSessionId: null,
      logFile
    };
  });

  fs.rmSync = (filePath, options) => {
    if (filePath === path.join(jobsDir, `${failingId}.json`)) {
      throw new Error("permission denied");
    }

    return originalRmSync(filePath, options);
  };

  try {
    saveWorkspaceState(stateDir, { version: 1, jobs });
  } finally {
    fs.rmSync = originalRmSync;
  }

  const savedJobs = listJobs({ stateDir, all: true });
  assert.equal(savedJobs.length, 50);
  assert.equal(savedJobs[0].id, "task-54");
  assert.equal(savedJobs.at(-1).id, "task-05");
  assert.equal(fs.existsSync(path.join(jobsDir, `${failingId}.json`)), true);
});

test("saveWorkspaceState ignores unsafe pruned job ids when deleting files", () => {
  const stateDir = makeTempDir("task-state-");
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const outsideJobFile = path.join(stateDir, "outside.json");
  fs.writeFileSync(outsideJobFile, "do not delete", "utf8");

  const jobs = Array.from({ length: 50 }, (_, index) => ({
    id: `task-${String(index).padStart(2, "0")}`,
    kind: "task",
    status: "completed",
    phase: "completed",
    createdAt: "2026-06-06T07:00:00.000Z",
    updatedAt: `2026-06-06T08:${String(index).padStart(2, "0")}:00.000Z`,
    claudeSessionId: null,
    logFile: path.join(jobsDir, `task-${String(index).padStart(2, "0")}.log`)
  }));

  saveWorkspaceState(stateDir, {
    version: 1,
    jobs: [
      ...jobs,
      {
        id: "../outside",
        kind: "task",
        status: "completed",
        phase: "completed",
        createdAt: "2026-06-06T07:00:00.000Z",
        updatedAt: "2026-06-06T07:00:00.000Z",
        claudeSessionId: null,
        logFile: path.join(jobsDir, "../outside.log")
      }
    ]
  });

  assert.equal(fs.readFileSync(outsideJobFile, "utf8"), "do not delete");
});

test("findJob reports missing, ambiguous, and empty-state references clearly", () => {
  const stateDir = makeTempDir("task-state-");

  assert.throws(() => findJob("", { stateDir }), /No jobs found/);
  assert.throws(() => findJob("task-missing", { stateDir }), /No job found/);

  const baseJob = {
    kind: "task",
    status: "queued",
    phase: "queued",
    createdAt: "2026-06-06T07:00:00.000Z",
    updatedAt: "2026-06-06T07:00:00.000Z",
    claudeSessionId: null
  };

  for (const id of ["task-abcd1111", "task-abcd2222"]) {
    const job = {
      ...baseJob,
      id,
      logFile: path.join(stateDir, "jobs", `${id}.log`)
    };
    saveJob(job, { stateDir });
  }

  assert.throws(() => findJob("task-abcd", { stateDir }), /Ambiguous job reference/);
});

test("findJob with empty ref uses deterministic recency tie-breakers", () => {
  const stateDir = makeTempDir("task-state-");
  const oldJob = {
    id: "task-old",
    kind: "task",
    status: "completed",
    phase: "done",
    createdAt: "2026-06-06T07:00:00.000Z",
    updatedAt: "2026-06-06T08:00:00.000Z",
    claudeSessionId: null,
    logFile: path.join(stateDir, "jobs", "task-old.log")
  };
  const newJob = {
    id: "task-new",
    kind: "task",
    status: "completed",
    phase: "done",
    createdAt: "2026-06-06T07:01:00.000Z",
    updatedAt: "2026-06-06T08:00:00.000Z",
    claudeSessionId: null,
    logFile: path.join(stateDir, "jobs", "task-new.log")
  };

  saveJob(oldJob, { stateDir });
  saveJob(newJob, { stateDir });

  assert.equal(findJob("", { stateDir }).id, "task-new");
});

test("listJobs uses id as final deterministic recency tie-breaker", () => {
  const stateDir = makeTempDir("task-state-");

  for (const id of ["task-a", "task-z"]) {
    saveJob(
      {
        id,
        kind: "task",
        status: "completed",
        phase: "done",
        createdAt: "2026-06-06T07:00:00.000Z",
        updatedAt: "2026-06-06T08:00:00.000Z",
        claudeSessionId: null,
        logFile: path.join(stateDir, "jobs", `${id}.log`)
      },
      { stateDir }
    );
  }

  assert.equal(listJobs({ stateDir })[0].id, "task-z");
});

test("tracked job helpers update status, phase, result, rendered, and error", () => {
  const job = createJob({
    kind: "task",
    workspaceRoot: makeTempDir("task-workspace-"),
    stateDir: makeTempDir("task-state-"),
    request: { prompt: "fix auth" },
    now: () => "2026-06-06T07:00:00.000Z"
  });

  assert.equal(markRunning(job, { now: () => "2026-06-06T07:01:00.000Z" }), job);
  assert.equal(job.status, "running");
  assert.equal(job.phase, "starting");

  markRunning(job, {
    phase: "reviewing",
    claudeSessionId: "session-1",
    worker: { pid: 1234 },
    now: () => "2026-06-06T07:01:30.000Z"
  });
  assert.equal(job.status, "running");
  assert.equal(job.phase, "reviewing");
  assert.equal(job.claudeSessionId, null);
  assert.equal(job.worker, null);

  updatePhase(job, "rendering", {
    rendered: "# Partial",
    now: () => "2026-06-06T07:02:00.000Z"
  });
  assert.equal(job.status, "running");
  assert.equal(job.phase, "rendering");
  assert.equal(job.rendered, null);

  markCompleted(
    job,
    { finalOutput: "fixed auth" },
    {
      rendered: "# Done",
      now: () => "2026-06-06T07:03:00.000Z"
    }
  );
  assert.equal(job.status, "completed");
  assert.equal(job.phase, "done");
  assert.deepEqual(job.result, { finalOutput: "fixed auth" });
  assert.equal(job.rendered, "# Done");
  assert.equal(job.error, null);

  const failure = new Error("boom");
  markFailed(job, failure, { now: () => "2026-06-06T07:04:00.000Z" });
  assert.equal(job.status, "failed");
  assert.equal(job.phase, "failed");
  assert.equal(job.error.message, "boom");
  assert.match(job.error.stack, /Error: boom/);

  markCancelled(job, "user requested stop", {
    now: () => "2026-06-06T07:05:00.000Z"
  });
  assert.equal(job.status, "cancelled");
  assert.equal(job.phase, "cancelled");
  assert.deepEqual(job.error, { message: "user requested stop" });
  assert.equal(job.updatedAt, "2026-06-06T07:05:00.000Z");
});
