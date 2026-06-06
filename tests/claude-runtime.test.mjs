import assert from "node:assert/strict";
import test from "node:test";
import {
  buildClaudeOptions,
  extractJsonObject,
  runAdversarialReview,
  runClaudeTask,
  runFallbackReview,
  runNativeReview
} from "../scripts/lib/claude.mjs";
import {
  createFakeClaudeSdk,
  reviewMessages,
  taskMessages
} from "./fake-claude-sdk.mjs";

test("buildClaudeOptions maps workspace-write permissions", () => {
  const options = buildClaudeOptions({
    cwd: "/repo",
    model: "sonnet",
    effort: "high",
    permission: "workspace-write"
  });

  assert.equal(options.cwd, "/repo");
  assert.equal(options.model, "sonnet");
  assert.equal(options.effort, "high");
  assert.equal(options.permissionMode, "acceptEdits");
  assert.equal(options.allowDangerouslySkipPermissions, false);
  assert.ok(options.allowedTools.includes("Read"));
  assert.ok(options.allowedTools.includes("Edit"));
});

test("buildClaudeOptions maps read-only permissions without write tools", () => {
  const options = buildClaudeOptions({
    cwd: "/repo",
    permission: "read-only"
  });

  assert.ok(options.allowedTools.includes("Read"));
  assert.ok(options.allowedTools.includes("Grep"));
  assert.equal(options.allowedTools.includes("Edit"), false);
  assert.equal(options.allowedTools.includes("Write"), false);
  assert.ok(options.disallowedTools.includes("Edit"));
  assert.ok(options.disallowedTools.includes("Write"));
});

test("buildClaudeOptions omits optional fields when absent", () => {
  const options = buildClaudeOptions();

  assert.equal("cwd" in options, false);
  assert.equal("model" in options, false);
  assert.equal("effort" in options, false);
  assert.equal("resumeSessionId" in options, false);
  assert.equal("signal" in options, false);
});

test("runClaudeTask returns completed result and calls sdk.query with prompt", async () => {
  const sdk = createFakeClaudeSdk({ messages: taskMessages });

  const result = await runClaudeTask({
    sdk,
    prompt: "fix auth",
    cwd: "/repo",
    model: "sonnet"
  });

  assert.equal(result.status, "completed");
  assert.equal(result.finalText, "Task completed.");
  assert.equal(result.claudeSessionId, "task-session");
  assert.deepEqual(result.rawMessages, taskMessages);
  assert.equal(sdk.calls.length, 1);
  assert.equal(sdk.calls[0].prompt, "fix auth");
  assert.equal(sdk.calls[0].options.cwd, "/repo");
  assert.equal(sdk.calls[0].options.permissionMode, "acceptEdits");
});

test("runClaudeTask maps resume session to SDK resume option", async () => {
  const sdk = createFakeClaudeSdk();

  await runClaudeTask({
    sdk,
    prompt: "continue",
    cwd: "/repo",
    resumeSessionId: "session-123"
  });

  assert.equal(sdk.calls[0].options.resume, "session-123");
  assert.equal("resumeSessionId" in sdk.calls[0].options, false);
});

test("runFallbackReview marks fallback and uses read-only permissions", async () => {
  const sdk = createFakeClaudeSdk({ messages: reviewMessages });

  const result = await runFallbackReview({
    sdk,
    prompt: "review this diff",
    cwd: "/repo",
    model: "sonnet"
  });

  assert.equal(result.fallbackUsed, true);
  assert.equal(result.finalText, "No issues found.");
  assert.equal(result.claudeSessionId, "review-session");
  assert.equal(sdk.calls[0].prompt, "review this diff");
  assert.equal(sdk.calls[0].options.allowedTools.includes("Edit"), false);
});

test("runNativeReview starts prompt with slash review and does not mark fallback", async () => {
  const sdk = createFakeClaudeSdk({ messages: reviewMessages });

  const result = await runNativeReview({
    sdk,
    cwd: "/repo",
    context: { target: { description: "changes since main" } },
    model: "sonnet"
  });

  assert.equal(sdk.calls[0].prompt.startsWith("/review"), true);
  assert.match(sdk.calls[0].prompt, /changes since main/);
  assert.equal(result.fallbackUsed, false);
});

test("extractJsonObject parses first balanced JSON object", () => {
  assert.deepEqual(
    extractJsonObject('prefix {"a":{"b":1},"ignored":"}"} suffix {"c":2}'),
    { a: { b: 1 }, ignored: "}" }
  );
});

test("runAdversarialReview parses structured JSON", async () => {
  const sdk = createFakeClaudeSdk({
    messages: [
      {
        type: "result",
        session_id: "structured-session",
        result:
          'prefix {"verdict":"changes requested","summary":"Check","findings":[{"severity":"high","file":"src/app.js","line":12,"title":"Bug","detail":"Broken"}],"next_steps":["Fix it"]} suffix'
      }
    ]
  });

  const result = await runAdversarialReview({
    sdk,
    prompt: "audit the task",
    cwd: "/repo",
    model: "sonnet"
  });

  assert.equal(result.status, "completed");
  assert.equal(result.claudeSessionId, "structured-session");
  assert.deepEqual(result.structured, {
    verdict: "changes requested",
    summary: "Check",
    findings: [
      {
        severity: "high",
        file: "src/app.js",
        line: 12,
        title: "Bug",
        detail: "Broken"
      }
    ],
    next_steps: ["Fix it"]
  });
  assert.equal(result.parseError, null);
});

test("runAdversarialReview records parse errors without throwing", async () => {
  const sdk = createFakeClaudeSdk({
    messages: [{ type: "result", session_id: "bad-json-session", result: "no json here" }]
  });

  const result = await runAdversarialReview({
    sdk,
    prompt: "audit the task",
    cwd: "/repo",
    model: "sonnet"
  });

  assert.equal(result.structured, null);
  assert.match(result.parseError, /No JSON object found/);
});

test("runAdversarialReview rejects malformed structured review objects", async () => {
  const sdk = createFakeClaudeSdk({
    messages: [
      {
        type: "result",
        session_id: "malformed-review-session",
        result: '{"summary":"Missing verdict and arrays","findings":"not an array"}'
      }
    ]
  });

  const result = await runAdversarialReview({
    sdk,
    prompt: "audit the task",
    cwd: "/repo"
  });

  assert.equal(result.structured, null);
  assert.match(result.parseError, /Invalid adversarial review JSON/);
});

test("normalize result falls back to last assistant text", async () => {
  const sdk = createFakeClaudeSdk({
    messages: [
      {
        type: "assistant",
        session_id: "assistant-session",
        message: { content: [{ type: "text", text: "Assistant answer." }] }
      }
    ]
  });

  const result = await runClaudeTask({
    sdk,
    prompt: "answer",
    cwd: "/repo"
  });

  assert.equal(result.status, "completed");
  assert.equal(result.finalText, "Assistant answer.");
  assert.equal(result.claudeSessionId, "assistant-session");
});

test("normalization captures nested session id fields", async () => {
  const sdk = createFakeClaudeSdk({
    messages: [
      {
        type: "result",
        metadata: { session: { sessionId: "nested-session" } },
        result: { content: [{ type: "text", text: "Nested result." }] }
      }
    ]
  });

  const result = await runClaudeTask({
    sdk,
    prompt: "answer",
    cwd: "/repo"
  });

  assert.equal(result.claudeSessionId, "nested-session");
  assert.equal(result.finalText, "Nested result.");
});

test("normalization ignores generic message ids when finding Claude session id", async () => {
  const sdk = createFakeClaudeSdk({
    messages: [
      {
        type: "assistant",
        id: "ordinary-message-id",
        message: { content: [{ type: "text", text: "Assistant answer." }] }
      },
      {
        type: "result",
        session_id: "real-session-id",
        result: "Done."
      }
    ]
  });

  const result = await runClaudeTask({
    sdk,
    prompt: "answer",
    cwd: "/repo"
  });

  assert.equal(result.claudeSessionId, "real-session-id");
});

test("buildClaudeOptions supports dangerous permission bypass", () => {
  const options = buildClaudeOptions({
    permission: "workspace-write",
    dangerouslyBypassPermissions: true
  });

  assert.equal(options.permissionMode, "bypassPermissions");
  assert.equal(options.allowDangerouslySkipPermissions, true);
});

test("buildClaudeOptions includes SDK resume and abort controller when provided", () => {
  const abortController = new AbortController();
  const options = buildClaudeOptions({
    cwd: "/repo",
    resumeSessionId: "session-123",
    abortController
  });

  assert.equal(options.resume, "session-123");
  assert.equal(options.abortController, abortController);
  assert.equal("resumeSessionId" in options, false);
  assert.equal("signal" in options, false);
});

test("collecting messages calls onProgress for each streamed message", async () => {
  const seen = [];
  const sdk = createFakeClaudeSdk({ messages: taskMessages });

  await runClaudeTask({
    sdk,
    prompt: "track progress",
    cwd: "/repo",
    onProgress(message) {
      seen.push(message);
    }
  });

  assert.deepEqual(seen, taskMessages);
});

test("runClaudeTask lets SDK stream errors throw", async () => {
  const sdk = createFakeClaudeSdk({
    messages: [new Error("stream failed")]
  });

  await assert.rejects(
    () =>
      runClaudeTask({
        sdk,
        prompt: "fail",
        cwd: "/repo"
      }),
    /stream failed/
  );
});

test("runClaudeTask closes query when progress callback throws", async () => {
  let closed = false;
  const sdk = {
    query() {
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "assistant",
            session_id: "progress-session",
            message: { content: [{ type: "text", text: "Working." }] }
          };
        },
        close() {
          closed = true;
        }
      };
    }
  };

  await assert.rejects(
    () =>
      runClaudeTask({
        sdk,
        prompt: "fail progress",
        cwd: "/repo",
        onProgress() {
          throw new Error("progress failed");
        }
      }),
    /progress failed/
  );
  assert.equal(closed, true);
});

test("runClaudeTask normalizes aborted SDK streams as interrupted", async () => {
  const abortError = new Error("aborted");
  abortError.name = "AbortError";
  const abortController = new AbortController();
  abortController.abort();
  const sdk = createFakeClaudeSdk({ messages: [abortError] });

  const result = await runClaudeTask({
    sdk,
    prompt: "stop",
    cwd: "/repo",
    abortController
  });

  assert.equal(result.status, "interrupted");
  assert.equal(result.interrupted, true);
  assert.equal(result.finalText, "");
});

test("runClaudeTask normalizes SDK error result messages as failed", async () => {
  const sdk = createFakeClaudeSdk({
    messages: [
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: "failed-session",
        errors: ["tool crashed"]
      }
    ]
  });

  const result = await runClaudeTask({
    sdk,
    prompt: "fail",
    cwd: "/repo"
  });

  assert.equal(result.status, "failed");
  assert.equal(result.finalText, "");
  assert.equal(result.claudeSessionId, "failed-session");
  assert.equal(result.error.message, "tool crashed");
  assert.equal(result.error.subtype, "error_during_execution");
});
