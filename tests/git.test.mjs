import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  buildReviewContext,
  getChangedFiles,
  getDefaultBranch,
  getDiff,
  git,
  hasWorkingTreeChanges,
  isGitRepository,
  resolveReviewTarget
} from "../scripts/lib/git.mjs";
import {
  buildAdversarialReviewPrompt,
  buildFallbackReviewPrompt,
  buildTaskPrompt,
  renderTemplate
} from "../scripts/lib/prompts.mjs";
import { makeTempDir } from "./helpers.mjs";

function runGit(workspaceRoot, args) {
  return execFileSync("git", args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function runGitStatus(workspaceRoot, args) {
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

function writeFile(workspaceRoot, relativePath, text) {
  const filePath = path.join(workspaceRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, "utf8");
}

function createGitRepo() {
  const workspaceRoot = makeTempDir("git-review-context-");

  runGit(workspaceRoot, ["init"]);
  runGit(workspaceRoot, ["config", "user.email", "codex@example.test"]);
  runGit(workspaceRoot, ["config", "user.name", "Codex Test"]);
  writeFile(workspaceRoot, "README.md", "initial\n");
  runGit(workspaceRoot, ["add", "README.md"]);
  runGit(workspaceRoot, ["commit", "-m", "initial commit"]);

  return workspaceRoot;
}

function createBranchChangeRepo() {
  const workspaceRoot = createGitRepo();
  const defaultBranch = runGit(workspaceRoot, ["branch", "--show-current"]);

  runGit(workspaceRoot, ["checkout", "-b", "feature/review-context"]);
  writeFile(workspaceRoot, "README.md", "initial\nfeature branch line\n");
  writeFile(workspaceRoot, "src/review.js", "export const changed = true;\n");
  runGit(workspaceRoot, ["add", "README.md", "src/review.js"]);
  runGit(workspaceRoot, ["commit", "-m", "feature changes"]);

  return { workspaceRoot, defaultBranch };
}

function createDevelopOnlyRepo() {
  const workspaceRoot = createGitRepo();

  runGit(workspaceRoot, ["branch", "-M", "develop"]);

  return workspaceRoot;
}

function createRemoteOnlyDefaultRepo(remoteBranch) {
  const workspaceRoot = createGitRepo();
  const baseCommit = runGit(workspaceRoot, ["rev-parse", "HEAD"]);

  runGit(workspaceRoot, ["branch", "-M", "feature/review-context"]);
  runGit(workspaceRoot, [
    "update-ref",
    `refs/remotes/origin/${remoteBranch}`,
    baseCommit
  ]);
  writeFile(workspaceRoot, "src/review.js", "export const remoteBase = true;\n");
  runGit(workspaceRoot, ["add", "src/review.js"]);
  runGit(workspaceRoot, ["commit", "-m", "feature changes"]);

  return workspaceRoot;
}

test("isGitRepository reports true for a git work tree and false otherwise", () => {
  const workspaceRoot = createGitRepo();
  const nonGitRoot = makeTempDir("not-a-git-repo-");

  assert.equal(isGitRepository(workspaceRoot), true);
  assert.equal(isGitRepository(nonGitRoot), false);
});

test("resolveReviewTarget auto chooses working tree when repository is dirty", () => {
  const workspaceRoot = createGitRepo();

  writeFile(workspaceRoot, "README.md", "initial\nmodified\n");
  writeFile(workspaceRoot, "notes/untracked.txt", "new file\n");

  assert.equal(hasWorkingTreeChanges(workspaceRoot), true);
  const target = resolveReviewTarget({ workspaceRoot });

  assert.equal(target.kind, "working-tree");
  assert.equal(target.baseRef, null);
  assert.equal(target.description, "working tree");
});

test("resolveReviewTarget with explicit base returns branch target", () => {
  const { workspaceRoot, defaultBranch } = createBranchChangeRepo();

  const target = resolveReviewTarget({ workspaceRoot, base: defaultBranch });

  assert.equal(target.kind, "branch");
  assert.equal(target.baseRef, defaultBranch);
  assert.equal(target.description, `${defaultBranch}...HEAD`);
});

test("resolveReviewTarget uses plan error messages for invalid review targets", () => {
  const nonGitRoot = makeTempDir("not-a-git-repo-");
  const workspaceRoot = createGitRepo();

  assert.throws(
    () => resolveReviewTarget({ workspaceRoot: nonGitRoot }),
    new RegExp(`Not a Git repository: ${nonGitRoot}`)
  );
  assert.throws(
    () => resolveReviewTarget({ workspaceRoot, base: "missing-base" }),
    /Could not determine a base branch\. Pass --base <ref>\./
  );
});

test("missing default branch requires explicit base unless auto finds dirty working tree", () => {
  const workspaceRoot = createDevelopOnlyRepo();
  const missingBaseError = /Could not determine a base branch\. Pass --base <ref>\./;

  assert.equal(getDefaultBranch(workspaceRoot), null);
  assert.throws(
    () => resolveReviewTarget({ workspaceRoot, scope: "branch" }),
    missingBaseError
  );
  assert.throws(
    () => resolveReviewTarget({ workspaceRoot, scope: "auto" }),
    missingBaseError
  );

  writeFile(workspaceRoot, "README.md", "initial\ndirty working tree\n");

  assert.equal(
    resolveReviewTarget({ workspaceRoot, scope: "auto" }).kind,
    "working-tree"
  );
});

test("remote origin/main is used as default branch when origin/HEAD and local defaults are missing", () => {
  const workspaceRoot = createRemoteOnlyDefaultRepo("main");

  assert.notEqual(
    runGitStatus(workspaceRoot, [
      "symbolic-ref",
      "--quiet",
      "refs/remotes/origin/HEAD"
    ]),
    0
  );
  assert.notEqual(
    runGitStatus(workspaceRoot, ["rev-parse", "--verify", "refs/heads/main"]),
    0
  );
  assert.notEqual(
    runGitStatus(workspaceRoot, ["rev-parse", "--verify", "refs/heads/master"]),
    0
  );
  assert.equal(getDefaultBranch(workspaceRoot), "origin/main");

  const target = resolveReviewTarget({ workspaceRoot, scope: "branch" });

  assert.equal(target.baseRef, "origin/main");
  assert.deepEqual(getChangedFiles({ workspaceRoot, target }), ["src/review.js"]);
  assert.match(getDiff({ workspaceRoot, target }), /\+export const remoteBase = true;/);
});

test("remote origin/master is used as default branch when origin/HEAD and main refs are missing", () => {
  const workspaceRoot = createRemoteOnlyDefaultRepo("master");

  assert.notEqual(
    runGitStatus(workspaceRoot, [
      "symbolic-ref",
      "--quiet",
      "refs/remotes/origin/HEAD"
    ]),
    0
  );
  assert.notEqual(
    runGitStatus(workspaceRoot, ["rev-parse", "--verify", "refs/heads/main"]),
    0
  );
  assert.notEqual(
    runGitStatus(workspaceRoot, ["rev-parse", "--verify", "refs/heads/master"]),
    0
  );
  assert.notEqual(
    runGitStatus(workspaceRoot, [
      "rev-parse",
      "--verify",
      "refs/remotes/origin/main"
    ]),
    0
  );
  assert.equal(getDefaultBranch(workspaceRoot), "origin/master");

  const target = resolveReviewTarget({ workspaceRoot, scope: "branch" });

  assert.equal(target.baseRef, "origin/master");
  assert.deepEqual(getChangedFiles({ workspaceRoot, target }), ["src/review.js"]);
  assert.match(getDiff({ workspaceRoot, target }), /\+export const remoteBase = true;/);
});

test("branch review context includes changed files and inline diff", () => {
  const { workspaceRoot, defaultBranch } = createBranchChangeRepo();
  const target = resolveReviewTarget({ workspaceRoot, base: defaultBranch });

  assert.deepEqual(getChangedFiles({ workspaceRoot, target }).sort(), [
    "README.md",
    "src/review.js"
  ]);

  const diff = getDiff({ workspaceRoot, target });
  assert.match(diff, /diff --git a\/README\.md b\/README\.md/);
  assert.match(diff, /\+feature branch line/);
  assert.match(diff, /diff --git a\/src\/review\.js b\/src\/review\.js/);

  const context = buildReviewContext({ workspaceRoot, target });
  assert.deepEqual(context.target, target);
  assert.deepEqual(context.files.sort(), ["README.md", "src/review.js"]);
  assert.equal(context.inline, true);
  assert.match(context.diff, /\+feature branch line/);
});

test("branch diff helpers accept plan-shaped targets", () => {
  const { workspaceRoot, defaultBranch } = createBranchChangeRepo();
  const target = {
    kind: "branch",
    baseRef: defaultBranch,
    description: `${defaultBranch}...HEAD`
  };

  assert.deepEqual(getChangedFiles({ workspaceRoot, target }).sort(), [
    "README.md",
    "src/review.js"
  ]);
  assert.match(getDiff({ workspaceRoot, target }), /\+feature branch line/);
});

test("working tree review context includes staged, unstaged, and untracked files", () => {
  const workspaceRoot = createGitRepo();
  const target = resolveReviewTarget({ workspaceRoot, scope: "working-tree" });

  writeFile(workspaceRoot, "README.md", "initial\nunstaged line\n");
  writeFile(workspaceRoot, "staged.txt", "staged file\n");
  writeFile(workspaceRoot, "untracked.txt", "untracked file\n");
  runGit(workspaceRoot, ["add", "staged.txt"]);

  const files = getChangedFiles({ workspaceRoot, target }).sort();
  assert.deepEqual(files, ["README.md", "staged.txt", "untracked.txt"]);

  const context = buildReviewContext({ workspaceRoot, target });
  assert.equal(context.inline, true);
  assert.match(context.diff, /diff --git a\/README\.md b\/README\.md/);
  assert.match(context.diff, /diff --git a\/staged\.txt b\/staged\.txt/);
  assert.match(context.diff, /diff --git a\/untracked\.txt b\/untracked\.txt/);
});

test("buildReviewContext summarizes diff when inline threshold is exceeded", () => {
  const { workspaceRoot, defaultBranch } = createBranchChangeRepo();
  const target = resolveReviewTarget({ workspaceRoot, base: defaultBranch });

  const context = buildReviewContext({
    workspaceRoot,
    target,
    maxInlineBytes: 16
  });

  assert.equal(context.inline, false);
  assert.match(context.diff, /Diff omitted because it is/);
  assert.match(context.diff, /Changed files:/);
  assert.match(context.diff, /README\.md/);
});

test("buildReviewContext summarizes synthetic large diffs instead of throwing", () => {
  const workspaceRoot = createGitRepo();
  const target = resolveReviewTarget({ workspaceRoot, scope: "working-tree" });
  const largeLine = `+${"x".repeat(1024)}\n`;

  writeFile(workspaceRoot, "large.txt", "baseline\n");
  runGit(workspaceRoot, ["add", "large.txt"]);
  runGit(workspaceRoot, ["commit", "-m", "add large baseline"]);
  writeFile(workspaceRoot, "large.txt", largeLine.repeat(1400));

  const context = buildReviewContext({
    workspaceRoot,
    target,
    maxInlineBytes: 1024
  });

  assert.equal(context.inline, false);
  assert.match(context.diff, /Diff omitted because/);
  assert.match(context.diff, /Changed files:/);
  assert.match(context.diff, /large\.txt/);
});

test("prompt builders include read-only constraints, diff, JSON, and focus", () => {
  const context = {
    target: {
      kind: "branch",
      baseRef: "main",
      description: "main...HEAD",
      range: "main...HEAD"
    },
    files: ["README.md", "src/review.js"],
    diff: "diff --git a/src/review.js b/src/review.js\n+changed\n",
    inline: true
  };

  const fallback = buildFallbackReviewPrompt(context);
  assert.match(fallback, /read-only/i);
  assert.match(fallback, /Do not modify files/i);
  assert.match(fallback, /main\.\.\.HEAD/);
  assert.match(fallback, /README\.md/);
  assert.match(fallback, /\+changed/);

  const adversarial = buildAdversarialReviewPrompt(context, {
    focus: "security regressions"
  });
  assert.match(adversarial, /read-only/i);
  assert.match(adversarial, /JSON/i);
  assert.match(adversarial, /next_steps/);
  assert.match(adversarial, /security regressions/);
  assert.match(adversarial, /\+changed/);
});

test("review prompt builders do not fence raw diff content", () => {
  const context = {
    target: {
      kind: "branch",
      baseRef: "main",
      description: "main...HEAD"
    },
    files: ["README.md"],
    diff: "diff --git a/README.md b/README.md\n+```escape fence\n",
    inline: true
  };

  const fallback = buildFallbackReviewPrompt(context);
  const adversarial = buildAdversarialReviewPrompt(context);

  assert.doesNotMatch(fallback, /```diff\s*\ndiff --git/);
  assert.doesNotMatch(adversarial, /```diff\s*\ndiff --git/);
  assert.match(fallback, /\+```escape fence/);
  assert.match(adversarial, /\+```escape fence/);
});

test("adversarial review prompt renders an explicitly empty focus", () => {
  const context = {
    target: {
      kind: "branch",
      baseRef: "main",
      description: "main...HEAD"
    },
    files: ["README.md"],
    diff: "diff --git a/README.md b/README.md\n+changed\n",
    inline: true
  };

  const adversarial = buildAdversarialReviewPrompt(context, { focus: "" });

  assert.doesNotMatch(
    adversarial,
    /General correctness, regression risk, security, and test coverage\./
  );
  assert.match(adversarial, /Focus:\n\s*Target:/);
});

test("template rendering and task prompt helpers keep prompt content predictable", () => {
  assert.equal(
    renderTemplate("Review {{target}}: {{files}}", {
      target: "main...HEAD",
      files: ["README.md", "src/review.js"]
    }),
    "Review main...HEAD: - README.md\n- src/review.js"
  );

  assert.equal(buildTaskPrompt("  delegate this task\n\n"), "delegate this task");
});

test("getDefaultBranch returns a branch string or null", () => {
  const workspaceRoot = createGitRepo();
  const defaultBranch = getDefaultBranch(workspaceRoot);

  assert.equal(
    typeof defaultBranch === "string" || defaultBranch === null,
    true
  );
  assert.equal(defaultBranch?.length > 0 ?? true, true);
});

test("git throws unexpected command failures unless the exit code is explicitly allowed", () => {
  const workspaceRoot = createGitRepo();

  assert.throws(
    () => git(workspaceRoot, ["rev-parse", "--verify", "missing-ref"]),
    /git rev-parse --verify missing-ref failed with status/
  );
  assert.throws(
    () =>
      git(workspaceRoot, ["rev-parse", "--verify", "missing-ref"], {
        allowFailure: true
      }),
    /git rev-parse --verify missing-ref failed with status/
  );

  writeFile(workspaceRoot, "README.md", "initial\nmodified\n");

  assert.throws(
    () => git(workspaceRoot, ["diff", "--quiet"]),
    /git diff --quiet failed with status 1/
  );
  assert.equal(
    git(workspaceRoot, ["diff", "--quiet"], {
      allowExitCodes: [1]
    }),
    ""
  );
});

test("review output schema tightens verdict, severity, and line constraints", () => {
  const schema = JSON.parse(
    fs.readFileSync(
      path.join(
        import.meta.dirname,
        "..",
        "schemas",
        "review-output.schema.json"
      ),
      "utf8"
    )
  );
  const findingProperties = schema.properties.findings.items.properties;

  assert.deepEqual(schema.properties.verdict.enum, [
    "approved",
    "changes requested",
    "blocked"
  ]);
  assert.deepEqual(findingProperties.severity.enum, [
    "critical",
    "high",
    "medium",
    "low"
  ]);
  assert.equal(findingProperties.line.type, "integer");
  assert.equal(findingProperties.line.minimum, 1);
});
