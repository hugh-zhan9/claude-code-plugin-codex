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
  const manifest = readJson(".codex-plugin/plugin.json");

  assert.equal(manifest.name, "claude-code");
  assert.equal(manifest.version, "0.1.0");
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
    assert.match(body, /scripts\/cc-companion\.mjs/);
    assert.match(body, /Do not use MCP/i);
  }
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
