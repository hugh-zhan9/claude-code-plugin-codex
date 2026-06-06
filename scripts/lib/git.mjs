import { execFileSync } from "node:child_process";
import path from "node:path";

const DEFAULT_GIT_MAX_BUFFER = 16 * 1024 * 1024;
const DIFF_BUFFER_MARGIN_BYTES = 64 * 1024;

export function git(workspaceRoot, args, options = {}) {
  const allowExitCodes = new Set(options.allowExitCodes ?? []);
  const resultOptions = {
    cwd: workspaceRoot,
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? DEFAULT_GIT_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"]
  };

  try {
    return execFileSync("git", args, resultOptions).trimEnd();
  } catch (error) {
    const status = error.status ?? null;
    const stdout = error.stdout?.toString().trimEnd() ?? "";

    if (status !== null && allowExitCodes.has(status)) {
      if (options.requireStdoutOnAllowedExit && stdout.length === 0) {
        throw gitCommandError(args, error);
      }

      return stdout;
    }

    throw gitCommandError(args, error);
  }
}

export function isGitRepository(workspaceRoot) {
  const output = git(workspaceRoot, ["rev-parse", "--is-inside-work-tree"], {
    allowExitCodes: [128]
  });

  return output.trim() === "true";
}

export function getDefaultBranch(workspaceRoot) {
  assertGitRepository(workspaceRoot);

  const originHead = git(
    workspaceRoot,
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    { allowExitCodes: [1] }
  );

  if (originHead) {
    return originHead;
  }

  for (const branch of ["main", "master", "origin/main", "origin/master"]) {
    if (branchExists(workspaceRoot, branch)) {
      return branch;
    }
  }

  return null;
}

export function hasWorkingTreeChanges(workspaceRoot) {
  assertGitRepository(workspaceRoot);

  return git(workspaceRoot, ["status", "--porcelain"]).length > 0;
}

export function resolveReviewTarget({
  workspaceRoot,
  base = null,
  scope = "auto"
}) {
  assertGitRepository(workspaceRoot);

  if (base) {
    assertBaseBranch(workspaceRoot, base);
    return branchTarget(base);
  }

  if (scope === "working-tree") {
    return workingTreeTarget();
  }

  if (scope === "branch") {
    const defaultBranch = getDefaultBranch(workspaceRoot);
    if (!defaultBranch) {
      throw new Error("Could not determine a base branch. Pass --base <ref>.");
    }

    assertBaseBranch(workspaceRoot, defaultBranch);
    return branchTarget(defaultBranch);
  }

  if (scope !== "auto") {
    throw new Error(`Unknown review scope: ${scope}`);
  }

  if (hasWorkingTreeChanges(workspaceRoot)) {
    return workingTreeTarget();
  }

  const defaultBranch = getDefaultBranch(workspaceRoot);
  if (!defaultBranch) {
    throw new Error("Could not determine a base branch. Pass --base <ref>.");
  }

  assertBaseBranch(workspaceRoot, defaultBranch);
  return branchTarget(defaultBranch);
}

export function getChangedFiles({ workspaceRoot, target }) {
  assertGitRepository(workspaceRoot);

  if (target.kind === "working-tree") {
    return uniqueLines(
      [
        git(workspaceRoot, ["diff", "--name-only"]),
        git(workspaceRoot, ["diff", "--cached", "--name-only"]),
        git(workspaceRoot, ["ls-files", "--others", "--exclude-standard"])
      ].join("\n")
    );
  }

  return uniqueLines(git(workspaceRoot, ["diff", "--name-only", branchRange(target)]));
}

export function getDiff({ workspaceRoot, target, maxBuffer = undefined }) {
  assertGitRepository(workspaceRoot);

  if (target.kind !== "working-tree") {
    return git(workspaceRoot, ["diff", branchRange(target)], { maxBuffer });
  }

  const parts = [
    git(workspaceRoot, ["diff", "--cached"], { maxBuffer }),
    git(workspaceRoot, ["diff"], { maxBuffer })
  ].filter(Boolean);

  for (const filePath of getUntrackedFiles(workspaceRoot)) {
    parts.push(untrackedFileDiff(workspaceRoot, filePath, { maxBuffer }));
  }

  return parts.join("\n");
}

export function buildReviewContext({
  workspaceRoot,
  target,
  maxInlineBytes = 120000
}) {
  const files = getChangedFiles({ workspaceRoot, target });
  let diff;

  try {
    diff = getDiff({
      workspaceRoot,
      target,
      maxBuffer: reviewDiffMaxBuffer(maxInlineBytes)
    });
  } catch (error) {
    if (isGitOutputLimitError(error)) {
      return {
        target,
        files,
        diff: diffSummary({ maxInlineBytes, files }),
        inline: false
      };
    }

    throw error;
  }

  const byteLength = Buffer.byteLength(diff, "utf8");

  if (byteLength <= maxInlineBytes) {
    return {
      target,
      files,
      diff,
      inline: true
    };
  }

  return {
    target,
    files,
    diff: diffSummary({ byteLength, maxInlineBytes, files }),
    inline: false
  };
}

function gitCommandError(args, error) {
  const stderr = error.stderr?.toString().trim() || "no stderr";
  const status = error.status ?? "unknown";

  return new Error(
    `git ${args.join(" ")} failed with status ${status}: ${stderr}`,
    { cause: error }
  );
}

function reviewDiffMaxBuffer(maxInlineBytes) {
  const inlineBytes =
    Number.isFinite(maxInlineBytes) && maxInlineBytes > 0
      ? Math.trunc(maxInlineBytes)
      : 0;

  return inlineBytes + DIFF_BUFFER_MARGIN_BYTES;
}

function diffSummary({ byteLength = null, maxInlineBytes, files }) {
  const reason =
    byteLength === null
      ? `Diff omitted because it exceeded the inline limit of ${maxInlineBytes} bytes before it could be read safely.`
      : `Diff omitted because it is ${byteLength} bytes, exceeding the inline limit of ${maxInlineBytes} bytes.`;

  return [
    reason,
    "",
    "Changed files:",
    ...files.map((file) => `- ${file}`)
  ].join("\n");
}

function isGitOutputLimitError(error) {
  for (let current = error; current; current = current.cause) {
    if (current.code === "ENOBUFS") {
      return true;
    }

    if (/ENOBUFS|maxBuffer/i.test(String(current.message ?? ""))) {
      return true;
    }
  }

  return false;
}

function assertGitRepository(workspaceRoot) {
  if (!isGitRepository(workspaceRoot)) {
    throw new Error(`Not a Git repository: ${workspaceRoot}`);
  }
}

function assertBaseBranch(workspaceRoot, base) {
  if (!branchExists(workspaceRoot, base)) {
    throw new Error("Could not determine a base branch. Pass --base <ref>.");
  }
}

function branchExists(workspaceRoot, branch) {
  return execFileStatus(workspaceRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    branch
  ]) === 0;
}

function execFileStatus(workspaceRoot, args) {
  try {
    execFileSync("git", args, {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return 0;
  } catch (error) {
    return error.status ?? 1;
  }
}

function branchTarget(base) {
  const range = `${base}...HEAD`;

  return {
    kind: "branch",
    baseRef: base,
    description: range,
    label: range,
    base,
    range
  };
}

function workingTreeTarget() {
  return {
    kind: "working-tree",
    baseRef: null,
    description: "working tree",
    label: "working tree",
    base: null,
    range: null
  };
}

function getUntrackedFiles(workspaceRoot) {
  return uniqueLines(
    git(workspaceRoot, ["ls-files", "--others", "--exclude-standard"])
  );
}

function branchRange(target) {
  const baseRef = target.baseRef ?? target.base;
  if (!baseRef && !target.range) {
    throw new Error("Could not determine a base branch. Pass --base <ref>.");
  }

  return target.range ?? `${baseRef}...HEAD`;
}

function uniqueLines(text) {
  return Array.from(
    new Set(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    )
  );
}

function untrackedFileDiff(workspaceRoot, relativePath, options = {}) {
  const absolutePath = path.join(workspaceRoot, relativePath);

  return git(
    workspaceRoot,
    [
      "diff",
      "--no-index",
      "--",
      "/dev/null",
      absolutePath
    ],
    {
      allowExitCodes: [1],
      maxBuffer: options.maxBuffer,
      requireStdoutOnAllowedExit: true
    }
  )
    .replace(/^diff --git .*$/m, `diff --git a/${relativePath} b/${relativePath}`)
    .replace(/^--- .*$/m, "--- /dev/null")
    .replace(/^\+\+\+ .*$/m, `+++ b/${relativePath}`);
}
