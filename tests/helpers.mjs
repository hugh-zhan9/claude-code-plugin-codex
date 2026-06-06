import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function readText(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

export function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

export function assertFile(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  assert.equal(fs.existsSync(absolutePath), true, `${relativePath} should exist`);
  return absolutePath;
}

export function makeTempDir(prefix = "claude-code-plugin-codex-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
