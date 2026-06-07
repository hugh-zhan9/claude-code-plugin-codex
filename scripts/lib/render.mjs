export function renderSetup({ checks = [], nextSteps = [] } = {}) {
  const lines = ["# Claude Code Plugin Setup", "", "## Checks"];

  if (checks.length === 0) {
    lines.push("- No checks recorded.");
  } else {
    for (const check of checks) {
      const state = check.ok ? "OK" : "FAIL";
      const detail = check.detail ? ` (${check.detail})` : "";
      lines.push(`- ${check.name}: ${state}${detail}`);
    }
  }

  lines.push("", "## Next Steps");

  if (nextSteps.length === 0) {
    lines.push("- No action required.");
  } else {
    for (const step of nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return finish(lines);
}

export function renderStatus({ workspaceRoot, jobs = [] } = {}) {
  const lines = ["# Claude Code Jobs", ""];

  if (workspaceRoot) {
    lines.push(`Workspace: ${workspaceRoot}`, "");
  }

  if (jobs.length === 0) {
    lines.push("No jobs found.");
    return finish(lines);
  }

  lines.push(
    "| ID | Kind | Status | Phase | Updated |",
    "| --- | --- | --- | --- | --- |"
  );

  for (const job of jobs) {
    lines.push(
      `| ${job.id ?? ""} | ${job.kind ?? ""} | ${job.status ?? ""} | ${
        job.phase ?? ""
      } | ${job.updatedAt ?? ""} |`
    );
  }

  return finish(lines);
}

export function renderResult(job = {}) {
  if (job.status === "failed" || job.status === "cancelled") {
    const lines = [
      "# Claude Code Job Result",
      "",
      `Job: ${job.id ?? "unknown"}`,
      `Status: ${job.status}`,
      `Phase: ${job.phase ?? ""}`
    ];

    if (job.error?.message) {
      lines.push(`Error: ${job.error.message}`);
    }

    if (job.logFile) {
      lines.push(`Log: ${job.logFile}`);
    }

    if (job.result?.finalText) {
      lines.push("", "## Final Output", job.result.finalText);
    }

    return finish(lines);
  }

  const lines = [finalText(job)];

  if (job.claudeSessionId) {
    lines.push("", `\`claude --resume ${job.claudeSessionId}\``);
  }

  return finish(lines);
}

export function renderCancel({ id, cancelled, detail } = {}) {
  return finish([
    "# Claude Code Cancel",
    "",
    `Job: ${id ?? "unknown"}`,
    `Cancelled: ${cancelled ?? "unknown"}`,
    `Detail: ${detail ?? ""}`
  ]);
}

export function renderReview({ text = "", fallbackUsed = false, target } = {}) {
  const lines = ["# Claude Code Review", ""];

  if (target) {
    lines.push(`Target: ${target}`);
  }

  if (fallbackUsed) {
    lines.push("Fallback: used prompt-based review");
  }

  if (target || fallbackUsed) {
    lines.push("");
  }

  lines.push(text || "No review text returned.");
  return finish(lines);
}

export function renderAdversarialReview(payload = {}) {
  const lines = [
    "# Claude Code Adversarial Review",
    "",
    `Verdict: ${payload.verdict ?? "unknown"}`
  ];

  if (payload.summary) {
    lines.push("", "## Summary", payload.summary);
  }

  lines.push("", "## Findings");

  const findings = payload.findings ?? [];

  if (findings.length === 0) {
    lines.push("- No findings.");
  } else {
    for (const finding of findings) {
      const severity = String(finding.severity ?? "info").toUpperCase();
      const location = formatLocation(finding);
      const titleText = finding.title ?? "Untitled finding";
      const prefix = location ? `${severity} ${location}` : severity;
      lines.push(`- ${prefix} ${titleText}`);

      if (finding.detail) {
        lines.push(`  ${finding.detail}`);
      }
    }
  }

  lines.push("", "## Next Steps");

  const nextSteps = payload.next_steps ?? [];

  if (nextSteps.length === 0) {
    lines.push("- No next steps recorded.");
  } else {
    for (const step of nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return finish(lines);
}

export function renderAdversarialReviewFailure({
  text = "",
  parseError = "",
  target
} = {}) {
  const lines = ["# Claude Code Adversarial Review", ""];

  if (target) {
    lines.push(`Target: ${target}`, "");
  }

  lines.push("Structured output could not be parsed.");

  if (parseError) {
    lines.push(`Parse error: ${parseError}`);
  }

  lines.push("", "## Raw Output", text || "No review text returned.");
  return finish(lines);
}

export function renderJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function finalText(job) {
  return job.rendered ?? job.result?.finalText ?? "No final output stored.";
}

function formatLocation(finding) {
  if (!finding.file) {
    return "";
  }

  if (finding.line !== undefined && finding.line !== null) {
    return `${finding.file}:${finding.line}`;
  }

  return finding.file;
}

function finish(lines) {
  return `${lines.join("\n")}\n`;
}
