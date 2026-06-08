#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  getPackageRoot,
  installCodexPlugin
} from "./lib/install.mjs";

const USAGE = `Usage:
  claude-code-codex install [--skip-setup]
  claude-code-codex setup
  claude-code-codex --version

Commands:
  install      Register and install the local Codex plugin from this npm package.
  setup        Run the plugin readiness check.
`;

export async function runCli(argv = process.argv.slice(2), deps = {}) {
  const [command, ...args] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    return USAGE;
  }

  if (command === "--version" || command === "-v") {
    return `${readPackageVersion(deps.packageRoot)}\n`;
  }

  if (command === "install") {
    const skipSetup = consumeBooleanFlag(args, "--skip-setup");
    assertNoArgs(args);
    return installCodexPlugin({
      env: deps.env ?? process.env,
      packageRoot: deps.packageRoot ?? getPackageRoot(),
      runCommand: deps.runCommand,
      runSetup: deps.runSetup,
      skipSetup
    });
  }

  if (command === "setup" || command === "doctor") {
    assertNoArgs(args);
    return runCompanionSetup({
      env: deps.env ?? process.env,
      packageRoot: deps.packageRoot ?? getPackageRoot()
    });
  }

  throw new Error(`Unknown command: ${command}\n\n${USAGE}`);
}

export async function main(argv = process.argv.slice(2)) {
  try {
    process.stdout.write(await runCli(argv));
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  }
}

function runCompanionSetup({ env = process.env, packageRoot = getPackageRoot() } = {}) {
  return execFileSync(
    process.execPath,
    [path.join(packageRoot, "scripts", "cc-companion.mjs"), "setup"],
    {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
}

function readPackageVersion(packageRoot = getPackageRoot()) {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")
  );
  return packageJson.version;
}

function consumeBooleanFlag(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) {
    return false;
  }
  args.splice(index, 1);
  return true;
}

function assertNoArgs(args) {
  if (args.length > 0) {
    throw new Error(`Unexpected argument: ${args[0]}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
