import assert from "node:assert/strict";
import test from "node:test";
import {
  renderAdversarialReview,
  renderCancel,
  renderJson,
  renderReview,
  renderResult,
  renderSetup,
  renderStatus
} from "../scripts/lib/render.mjs";

test("renderSetup shows OK and FAIL checks with next steps", () => {
  const output = renderSetup({
    checks: [
      { name: "Node.js", ok: true, detail: "v20.0.0" },
      { name: "Claude Code CLI", ok: false, detail: "not found" }
    ],
    nextSteps: ["Run `claude login`.", "Retry setup."]
  });

  assert.match(output, /# Claude Code Plugin Setup/);
  assert.match(output, /Node\.js: OK/);
  assert.match(output, /Claude Code CLI: FAIL/);
  assert.match(output, /## Next Steps/);
  assert.match(output, /- Run `claude login`\./);
  assert.match(output, /- Retry setup\./);
});

test("renderStatus shows recent jobs", () => {
  const output = renderStatus({
    workspaceRoot: "/workspace/app",
    jobs: [
      {
        id: "task-002",
        kind: "task",
        status: "running",
        phase: "reviewing",
        updatedAt: "2026-06-06T07:02:00.000Z",
        claudeSessionId: "session-2"
      },
      {
        id: "task-001",
        kind: "review",
        status: "completed",
        phase: "completed",
        updatedAt: "2026-06-06T07:01:00.000Z",
        claudeSessionId: null
      }
    ]
  });

  assert.match(output, /# Claude Code Jobs/);
  assert.match(output, /Workspace: \/workspace\/app/);
  assert.match(output, /\| ID \| Kind \| Status \| Phase \| Updated \|/);
  assert.match(
    output,
    /\| task-002 \| task \| running \| reviewing \| 2026-06-06T07:02:00\.000Z \|/
  );
  assert.match(
    output,
    /\| task-001 \| review \| completed \| completed \| 2026-06-06T07:01:00\.000Z \|/
  );
});

test("renderResult includes rendered output and Claude resume command", () => {
  const output = renderResult({
    id: "task-001",
    status: "completed",
    phase: "completed",
    claudeSessionId: "session-123",
    rendered: "done"
  });

  assert.match(output, /^done\n/);
  assert.match(output, /claude --resume session-123/);
});

test("renderResult falls back to result.finalText", () => {
  const output = renderResult({
    id: "task-001",
    status: "completed",
    phase: "completed",
    claudeSessionId: null,
    result: { finalText: "Fixed the auth redirect." }
  });

  assert.equal(output, "Fixed the auth redirect.\n");
});

test("renderResult shows failed job error details and log path", () => {
  const output = renderResult({
    id: "task-001",
    status: "failed",
    phase: "failed",
    error: { message: "Claude runtime crashed" },
    logFile: "/tmp/claude-code/jobs/task-001.log"
  });

  assert.match(output, /# Claude Code Job Result/);
  assert.match(output, /Status: failed/);
  assert.match(output, /Error: Claude runtime crashed/);
  assert.match(output, /Log: \/tmp\/claude-code\/jobs\/task-001\.log/);
});

test("renderResult shows cancelled job details", () => {
  const output = renderResult({
    id: "task-001",
    status: "cancelled",
    phase: "cancelled",
    error: { message: "interrupted" }
  });

  assert.match(output, /Status: cancelled/);
  assert.match(output, /Error: interrupted/);
});

test("renderReview renders raw review text and fallback marker", () => {
  const output = renderReview({
    text: "Review finding text.",
    fallbackUsed: true,
    target: "working tree"
  });

  assert.match(output, /# Claude Code Review/);
  assert.match(output, /Target: working tree/);
  assert.match(output, /Fallback: used prompt-based review/);
  assert.match(output, /Review finding text\./);
});

test("renderAdversarialReview renders verdict, summary, findings, detail, and next_steps", () => {
  const output = renderAdversarialReview({
    verdict: "changes requested",
    summary: "One high-risk issue remains.",
    findings: [
      {
        severity: "high",
        title: "Missing regression test",
        file: "src/auth.mjs",
        line: 42,
        detail: "The redirect path can still throw for missing sessions."
      }
    ],
    next_steps: ["Add a failing test.", "Handle the missing-session branch."]
  });

  assert.match(output, /# Claude Code Adversarial Review/);
  assert.match(output, /Verdict: changes requested/);
  assert.match(output, /One high-risk issue remains\./);
  assert.match(output, /HIGH src\/auth\.mjs:42 Missing regression test/);
  assert.match(output, /The redirect path can still throw/);
  assert.match(output, /- Add a failing test\./);
  assert.match(output, /- Handle the missing-session branch\./);
});

test("renderCancel reports job id and cancellation state", () => {
  const output = renderCancel({
    id: "task-001",
    cancelled: true,
    detail: "interrupted"
  });

  assert.match(output, /# Claude Code Cancel/);
  assert.match(output, /Job: task-001/);
  assert.match(output, /Cancelled: true/);
  assert.match(output, /Detail: interrupted/);
});

test("renderJson emits stable formatted JSON", () => {
  assert.equal(renderJson({ status: "ok" }), '{\n  "status": "ok"\n}\n');
});
