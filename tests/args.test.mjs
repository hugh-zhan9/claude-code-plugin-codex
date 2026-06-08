import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseCompanionArgs } from "../scripts/lib/args.mjs";
import {
  appendLog,
  atomicWriteJson,
  readJsonFile,
  readTextFile
} from "../scripts/lib/fs.mjs";
import { commandExists, spawnDetached } from "../scripts/lib/process.mjs";
import {
  resolveWorkspaceRoot,
  workspaceDisplayName
} from "../scripts/lib/workspace.mjs";
import { makeTempDir } from "./helpers.mjs";

test("parseCompanionArgs parses task options and prompt", () => {
  const parsed = parseCompanionArgs([
    "task",
    "--background",
    "--model",
    "sonnet",
    "--effort",
    "high",
    "--",
    "fix auth"
  ]);

  assert.equal(parsed.command, "task");
  assert.equal(parsed.options.background, true);
  assert.equal(parsed.options.model, "sonnet");
  assert.equal(parsed.options.effort, "high");
  assert.equal(parsed.prompt, "fix auth");
});

test("parseCompanionArgs rejects unknown option", () => {
  assert.throws(
    () => parseCompanionArgs(["task", "--bad-flag"]),
    /Unknown option: --bad-flag/
  );
});

test("parseCompanionArgs parses status job reference", () => {
  const parsed = parseCompanionArgs(["status", "task-abc"]);

  assert.equal(parsed.command, "status");
  assert.deepEqual(parsed.options, {});
  assert.equal(parsed.jobRef, "task-abc");
});

test("parseCompanionArgs rejects extra job reference arguments", () => {
  assert.throws(
    () => parseCompanionArgs(["status", "job-1", "extra"]),
    /Unexpected argument: extra/
  );
});

test("parseCompanionArgs stores review options under options", () => {
  const parsed = parseCompanionArgs(["review", "--base", "main"]);

  assert.equal(parsed.command, "review");
  assert.equal(parsed.options.base, "main");
});

test("atomicWriteJson writes formatted JSON and readJsonFile reads it", () => {
  const tempDir = makeTempDir();
  const filePath = path.join(tempDir, "nested", "state.json");

  atomicWriteJson(filePath, { command: "task", background: true });

  assert.equal(
    fs.readFileSync(filePath, "utf8"),
    '{\n  "command": "task",\n  "background": true\n}\n'
  );
  assert.deepEqual(readJsonFile(filePath), { command: "task", background: true });
});

test("readJsonFile returns fallback for absent file", () => {
  const tempDir = makeTempDir();
  const fallback = { missing: true };

  assert.equal(readJsonFile(path.join(tempDir, "absent.json"), fallback), fallback);
});

test("readJsonFile returns null for absent file by default", () => {
  const tempDir = makeTempDir();

  assert.equal(readJsonFile(path.join(tempDir, "absent.json")), null);
});

test("readTextFile returns empty string for absent file by default", () => {
  const tempDir = makeTempDir();

  assert.equal(readTextFile(path.join(tempDir, "absent.txt")), "");
});

test("appendLog creates parent directory and writes timestamped line", () => {
  const tempDir = makeTempDir();
  const logPath = path.join(tempDir, "logs", "companion.log");

  appendLog(logPath, "task started");

  const log = fs.readFileSync(logPath, "utf8");
  assert.match(
    log,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z task started\n$/
  );
});

test("resolveWorkspaceRoot returns a real absolute directory", () => {
  const tempDir = makeTempDir();
  const workspaceRoot = resolveWorkspaceRoot({ cwd: tempDir });

  assert.equal(path.isAbsolute(workspaceRoot), true);
  assert.equal(fs.statSync(workspaceRoot).isDirectory(), true);
  assert.equal(workspaceRoot, fs.realpathSync(path.resolve(tempDir)));
});

test("workspaceDisplayName falls back for filesystem root", () => {
  assert.equal(workspaceDisplayName(path.parse(process.cwd()).root), "workspace");
});

test("commandExists detects node and rejects a generated missing command", () => {
  const missingCommand = `missing-command-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;

  assert.equal(commandExists("node"), true);
  assert.equal(commandExists(missingCommand), false);
});

test("commandExists does not execute commands found on PATH", () => {
  if (os.platform() === "win32") {
    return;
  }

  const binDir = makeTempDir("command-path-");
  const markerPath = path.join(binDir, "executed-marker");
  const commandPath = path.join(binDir, "side-effect-command");

  fs.writeFileSync(
    commandPath,
    `#!/bin/sh\nprintf executed > "${markerPath}"\nexit 0\n`,
    { mode: 0o755 }
  );

  assert.equal(commandExists(commandPath), true);
  assert.equal(fs.existsSync(markerPath), false);
});

test("commandExists rejects directories on POSIX", () => {
  if (os.platform() === "win32") {
    return;
  }

  assert.equal(commandExists("."), false);
  assert.equal(commandExists("/tmp"), false);
});

test("spawnDetached returns child-like object for missing commands", async () => {
  const missingCommand = `missing-command-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  const child = spawnDetached(missingCommand, []);

  assert.equal(typeof child.unref, "function");
  assert.equal(typeof child.on, "function");

  await new Promise((resolve) => setTimeout(resolve, 50));
});
