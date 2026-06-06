export function markRunning(
  job,
  { phase = "starting", now = () => new Date().toISOString() } = {}
) {
  job.status = "running";
  job.phase = phase;
  job.updatedAt = now();

  return job;
}

export function updatePhase(
  job,
  phase,
  { now = () => new Date().toISOString() } = {}
) {
  job.phase = phase;
  job.updatedAt = now();

  return job;
}

export function markCompleted(
  job,
  result,
  { rendered = null, now = () => new Date().toISOString() } = {}
) {
  job.status = "completed";
  job.phase = "done";
  job.updatedAt = now();
  job.result = result ?? null;
  job.rendered = rendered;
  job.error = null;

  return job;
}

export function markFailed(
  job,
  error,
  { now = () => new Date().toISOString() } = {}
) {
  job.status = "failed";
  job.phase = "failed";
  job.updatedAt = now();
  job.error = normalizeError(error);

  return job;
}

export function markCancelled(
  job,
  detail = "cancelled",
  { now = () => new Date().toISOString() } = {}
) {
  job.status = "cancelled";
  job.phase = "cancelled";
  job.updatedAt = now();
  job.error = { message: detail };

  return job;
}

function normalizeError(error) {
  if (!error) {
    return null;
  }

  if (typeof error === "string") {
    return { message: error };
  }

  if (typeof error.message === "string") {
    const normalized = { message: error.message };

    if (typeof error.stack === "string") {
      normalized.stack = error.stack;
    }

    return normalized;
  }

  return { message: String(error) };
}
