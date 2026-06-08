import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { assertFile, readJson, readText } from "./helpers.mjs";

const skillNames = [
  "claude-code-setup",
  "claude-code-task",
  "claude-code-review",
  "claude-code-adversarial-review",
  "claude-code-status",
  "claude-code-result",
  "claude-code-cancel"
];

test("plugin manifest declares the claude-code plugin and skills folder", () => {
  const pkg = readJson("package.json");
  const manifest = readJson(".codex-plugin/plugin.json");

  assert.equal(manifest.name, "claude-code");
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.description.includes("Claude Code"), true);
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.author.name, "OpenAI");
  assert.equal(manifest.interface.displayName, "Claude Code");
  assert.equal(Array.isArray(manifest.interface.defaultPrompt), true);
  assert.equal(manifest.interface.defaultPrompt.length > 0, true);
  assert.deepEqual(manifest.interface.capabilities, ["Delegation", "Code Review"]);
});

test("all required skills exist and call the companion script", () => {
  for (const name of skillNames) {
    assertFile(`skills/${name}/SKILL.md`);
    const body = readText(`skills/${name}/SKILL.md`);

    assert.match(body, /^---\nname: /);
    assert.match(body, new RegExp(`name: ${name}`));
    assert.match(body, /node "\$\{PLUGIN_ROOT\}\/scripts\/cc-companion\.mjs"/);
    assert.match(body, /Do not use MCP/i);
    assert.match(body, /Return the companion output directly\./);
  }
});

test("task and review skills document permission boundaries", () => {
  const task = readText("skills/claude-code-task/SKILL.md");
  const review = readText("skills/claude-code-review/SKILL.md");
  const adversarial = readText("skills/claude-code-adversarial-review/SKILL.md");

  assert.match(task, /Default task permission is workspace-write/);
  assert.match(task, /dangerous permission bypass/i);
  assert.match(review, /review read-only/i);
  assert.match(adversarial, /review read-only/i);
});

test("README documents direct commands, permissions, state, and no MCP", () => {
  const body = readText("README.md");

  assert.match(body, /node scripts\/cc-companion\.mjs setup/);
  assert.match(body, /node scripts\/cc-companion\.mjs task --background --/);
  assert.match(body, /workspace-write/);
  assert.match(body, /read-only/);
  assert.match(body, /CLAUDE_CODE_PLUGIN_CODEX_DATA/);
  assert.match(body, /No MCP/i);
});

test("companion setup smoke command is available", () => {
  const result = spawnSync("node", ["scripts/cc-companion.mjs", "setup"], {
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /# Claude Code Plugin Setup/);
  assert.match(result.stdout, /## Checks/);
  assert.match(result.stdout, /Node\.js: OK/);
});

test("companion validates foreground task prompts", () => {
  const result = spawnSync("node", ["scripts/cc-companion.mjs", "task"], {
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Task prompt is required/);
});
