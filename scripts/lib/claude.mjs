import { buildAdversarialReviewPrompt } from "./prompts.mjs";

const READ_TOOLS = ["Read", "Grep", "Glob", "LS"];
const SHELL_TOOLS = ["Bash"];
const WRITE_TOOLS = ["Edit", "MultiEdit", "Write"];
const READ_ONLY_DISALLOWED_TOOLS = ["Bash", "Edit", "MultiEdit", "Write"];

export async function importClaudeSdk() {
  return import("@anthropic-ai/claude-agent-sdk");
}

export function buildClaudeOptions({
  cwd,
  model = null,
  effort = null,
  permission = "read-only",
  resumeSessionId = null,
  abortController = null,
  dangerouslyBypassPermissions = false
} = {}) {
  const options = {
    allowedTools:
      permission === "workspace-write"
        ? [...READ_TOOLS, ...SHELL_TOOLS, ...WRITE_TOOLS]
        : [...READ_TOOLS],
    permissionMode: permission === "workspace-write" ? "acceptEdits" : "default",
    allowDangerouslySkipPermissions: false
  };

  if (permission === "read-only") {
    options.tools = [...READ_TOOLS];
    options.disallowedTools = [...READ_ONLY_DISALLOWED_TOOLS];
  }

  if (dangerouslyBypassPermissions) {
    options.permissionMode = "bypassPermissions";
    options.allowDangerouslySkipPermissions = true;
  }

  if (cwd) {
    options.cwd = cwd;
  }

  if (model) {
    options.model = model;
  }

  if (effort) {
    options.effort = effort;
  }

  if (resumeSessionId) {
    options.resume = resumeSessionId;
  }

  if (abortController) {
    options.abortController = abortController;
  }

  return options;
}

export async function collectClaudeMessages(queryResult, { onProgress = null } = {}) {
  const messages = [];

  try {
    for await (const message of queryResult) {
      messages.push(message);
      if (onProgress) {
        onProgress(message);
      }
    }
  } catch (error) {
    await closeClaudeQuery(queryResult);
    throw attachCollectedMessages(error, messages);
  }

  return messages;
}

export function normalizeClaudeResult(
  messages,
  { fallbackUsed = false, interrupted = false } = {}
) {
  const error = findClaudeError(messages);

  return {
    status: interrupted ? "interrupted" : error ? "failed" : "completed",
    claudeSessionId: findClaudeSessionId(messages),
    finalText: error ? "" : findFinalText(messages),
    rawMessages: messages,
    structured: null,
    parseError: null,
    error,
    fallbackUsed,
    interrupted
  };
}

export async function runClaudeTask({
  sdk,
  prompt,
  cwd,
  model,
  effort,
  permission = "workspace-write",
  resumeSessionId = null,
  dangerouslyBypassPermissions = false,
  onProgress = null,
  abortController = null
}) {
  const claudeSdk = sdk ?? (await importClaudeSdk());
  const queryResult = claudeSdk.query({
    prompt,
    options: buildClaudeOptions({
      cwd,
      model,
      effort,
      permission,
      resumeSessionId,
      abortController,
      dangerouslyBypassPermissions
    })
  });
  let messages;

  try {
    messages = await collectClaudeMessages(queryResult, { onProgress });
  } catch (error) {
    if (isAbortError(error, abortController)) {
      return normalizeClaudeResult(error?.claudeMessages ?? [], {
        interrupted: true
      });
    }

    throw error;
  }

  return normalizeClaudeResult(messages);
}

export async function runNativeReview({
  sdk,
  cwd,
  context,
  model,
  effort,
  onProgress = null,
  abortController = null
}) {
  const prompt = buildNativeReviewPrompt(context);

  return runClaudeTask({
    sdk,
    prompt,
    cwd,
    model,
    effort,
    permission: "read-only",
    onProgress,
    abortController
  });
}

export async function runFallbackReview({
  sdk,
  prompt,
  cwd,
  model,
  effort,
  onProgress = null,
  abortController = null
}) {
  const result = await runClaudeTask({
    sdk,
    prompt,
    cwd,
    model,
    effort,
    permission: "read-only",
    onProgress,
    abortController
  });

  return { ...result, fallbackUsed: true };
}

export async function runAdversarialReview({
  sdk,
  prompt,
  cwd,
  model,
  effort,
  onProgress = null,
  abortController = null
}) {
  const result = await runClaudeTask({
    sdk,
    prompt: buildAdversarialReviewPromptFromInput(prompt),
    cwd,
    model,
    effort,
    permission: "read-only",
    onProgress,
    abortController
  });

  try {
    const structured = parseAdversarialReviewJson(result.finalText);

    return {
      ...result,
      structured,
      parseError: null
    };
  } catch (error) {
    return {
      ...result,
      structured: null,
      parseError: error instanceof Error ? error.message : String(error)
    };
  }
}

export function isUnsupportedNativeReviewError(error) {
  if (!error) {
    return false;
  }

  if (error.code === "UNSUPPORTED_NATIVE_REVIEW") {
    return true;
  }

  const text = errorText(error);

  return (
    /\/review/i.test(text) &&
    /(unknown|unsupported|not supported|not available|unrecognized)/i.test(text)
  );
}

async function closeClaudeQuery(queryResult) {
  try {
    if (typeof queryResult?.close === "function") {
      await queryResult.close();
      return;
    }

    if (typeof queryResult?.return === "function") {
      await queryResult.return();
    }
  } catch {
    // Preserve the original stream or progress-callback error.
  }
}

function attachCollectedMessages(error, messages) {
  const normalizedError =
    error instanceof Error ? error : new Error(String(error ?? "Unknown error"));

  try {
    Object.defineProperty(normalizedError, "claudeMessages", {
      value: messages,
      configurable: true
    });
  } catch {
    normalizedError.claudeMessages = messages;
  }

  return normalizedError;
}

function errorText(error) {
  if (!error || typeof error !== "object") {
    return String(error ?? "");
  }

  const parts = [
    error.message,
    error.code,
    error.subtype,
    ...(Array.isArray(error.errors) ? error.errors : [])
  ];

  return parts.filter(Boolean).join("\n");
}

function isAbortError(error, abortController) {
  if (abortController?.signal?.aborted) {
    return true;
  }

  if (!error || typeof error !== "object") {
    return false;
  }

  return error.name === "AbortError" || error.code === "ABORT_ERR";
}

export function extractJsonObject(text) {
  const source = String(text ?? "");
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (start === -1) {
      if (char === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;

      if (depth === 0) {
        return JSON.parse(source.slice(start, index + 1));
      }
    }
  }

  if (start === -1) {
    throw new Error("No JSON object found");
  }

  throw new Error("Unterminated JSON object");
}

function buildNativeReviewPrompt(context) {
  const target = context?.target?.description ?? context?.target?.label ?? "";

  if (!target) {
    return "/review";
  }

  return `/review ${target}`;
}

function buildAdversarialReviewPromptFromInput(prompt) {
  if (typeof prompt !== "object" || prompt === null) {
    return String(prompt ?? "");
  }

  return buildAdversarialReviewPrompt(prompt, { focus: prompt.focus ?? "" });
}

function parseAdversarialReviewJson(text) {
  const parsed = extractJsonObject(text);
  validateAdversarialReviewJson(parsed);
  return parsed;
}

function validateAdversarialReviewJson(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid adversarial review JSON: expected object");
  }

  if (!["approved", "changes requested", "blocked"].includes(value.verdict)) {
    throw new Error("Invalid adversarial review JSON: invalid verdict");
  }

  if (typeof value.summary !== "string" || value.summary.trim() === "") {
    throw new Error("Invalid adversarial review JSON: summary is required");
  }

  if (!Array.isArray(value.findings)) {
    throw new Error("Invalid adversarial review JSON: findings must be an array");
  }

  for (const finding of value.findings) {
    validateAdversarialReviewFinding(finding);
  }

  if (
    !Array.isArray(value.next_steps) ||
    value.next_steps.some((step) => typeof step !== "string" || step.trim() === "")
  ) {
    throw new Error("Invalid adversarial review JSON: next_steps must be strings");
  }
}

function validateAdversarialReviewFinding(finding) {
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
    throw new Error("Invalid adversarial review JSON: finding must be an object");
  }

  if (!["critical", "high", "medium", "low"].includes(finding.severity)) {
    throw new Error("Invalid adversarial review JSON: invalid finding severity");
  }

  for (const key of ["file", "title", "detail"]) {
    if (typeof finding[key] !== "string" || finding[key].trim() === "") {
      throw new Error(`Invalid adversarial review JSON: finding ${key} is required`);
    }
  }

  if (!Number.isInteger(finding.line) || finding.line < 1) {
    throw new Error("Invalid adversarial review JSON: finding line must be positive");
  }
}

function findClaudeSessionId(messages) {
  for (const message of messages) {
    const sessionId = extractSessionId(message);
    if (sessionId) {
      return sessionId;
    }
  }

  return null;
}

function extractSessionId(value, { allowPlainId = false } = {}) {
  if (!value || typeof value !== "object") {
    return null;
  }

  for (const key of [
    "session_id",
    "sessionId",
    "claudeSessionId"
  ]) {
    if (typeof value[key] === "string" && value[key]) {
      return value[key];
    }
  }

  if (typeof value.session === "string" && value.session) {
    return value.session;
  }

  if (allowPlainId && typeof value.id === "string" && value.id) {
    return value.id;
  }

  for (const { key, allowPlainId: allowNestedPlainId } of [
    { key: "session", allowPlainId: true },
    { key: "metadata", allowPlainId: false },
    { key: "message", allowPlainId: false },
    { key: "result", allowPlainId: false }
  ]) {
    const nested = extractSessionId(value[key], {
      allowPlainId: allowNestedPlainId
    });
    if (nested) {
      return nested;
    }
  }

  return null;
}

function findFinalText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message?.type === "result") {
      const resultText = extractText(message.result ?? message.message ?? message);
      if (resultText) {
        return resultText;
      }
    }
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = extractAssistantText(messages[index]);
    if (text) {
      return text;
    }
  }

  return "";
}

function findClaudeError(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (isClaudeResultError(message)) {
      return normalizeClaudeError(message);
    }
  }

  return null;
}

function isClaudeResultError(message) {
  if (!message || typeof message !== "object" || message.type !== "result") {
    return false;
  }

  if (message.is_error === true) {
    return true;
  }

  return (
    typeof message.subtype === "string" &&
    message.subtype.startsWith("error_")
  );
}

function normalizeClaudeError(message) {
  const errors = Array.isArray(message.errors)
    ? message.errors.filter((error) => typeof error === "string")
    : [];
  const subtype =
    typeof message.subtype === "string" && message.subtype
      ? message.subtype
      : null;
  const messageText =
    errors.join("\n") ||
    extractText(message.result ?? message.message ?? message) ||
    (subtype ? `Claude SDK result failed: ${subtype}` : "Claude SDK result failed");

  return {
    message: messageText,
    subtype,
    errors
  };
}

function extractAssistantText(message) {
  if (!message || typeof message !== "object") {
    return "";
  }

  if (message.type !== "assistant" && message.role !== "assistant") {
    return "";
  }

  return extractText(message.message ?? message);
}

function extractText(value) {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  if (typeof value.text === "string") {
    return value.text;
  }

  if (typeof value.content === "string") {
    return value.content;
  }

  if (Array.isArray(value.content)) {
    return value.content
      .map((contentPart) => extractText(contentPart))
      .filter(Boolean)
      .join("\n");
  }

  if (typeof value.result === "string") {
    return value.result;
  }

  if (typeof value.summary === "string") {
    return value.summary;
  }

  return "";
}
