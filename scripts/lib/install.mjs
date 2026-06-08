import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CLAUDE_CODE_CODEX_MARKETPLACE_NAME = "claude-code-codex";
export const CLAUDE_CODE_CODEX_PLUGIN_NAME = "claude-code";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const defaultPackageRoot = path.resolve(moduleDir, "../..");

export function getPackageRoot() {
  return defaultPackageRoot;
}

export function getCodexHome({ env = process.env } = {}) {
  if (env.CODEX_HOME) {
    return path.resolve(env.CODEX_HOME);
  }
  const home = env.HOME || env.USERPROFILE;
  if (!home) {
    throw new Error("Cannot determine home directory. Set HOME or CODEX_HOME.");
  }
  return path.join(path.resolve(home), ".codex");
}

export function getMarketplaceRoot({ env = process.env } = {}) {
  return path.join(
    getCodexHome({ env }),
    "local-marketplaces",
    CLAUDE_CODE_CODEX_MARKETPLACE_NAME
  );
}

export function buildMarketplaceManifest() {
  return {
    name: CLAUDE_CODE_CODEX_MARKETPLACE_NAME,
    interface: {
      displayName: "Claude Code Codex"
    },
    plugins: [
      {
        name: CLAUDE_CODE_CODEX_PLUGIN_NAME,
        source: {
          source: "local",
          path: "./plugins/claude-code"
        },
        policy: {
          installation: "AVAILABLE",
          authentication: "ON_INSTALL"
        },
        category: "Productivity"
      }
    ]
  };
}

export async function writeLocalMarketplace({
  env = process.env,
  packageRoot = getPackageRoot(),
  platform = process.platform
} = {}) {
  const resolvedPackageRoot = path.resolve(packageRoot);
  await assertPluginRoot(resolvedPackageRoot);

  const marketplaceRoot = getMarketplaceRoot({ env });
  const agentsPluginRoot = path.join(marketplaceRoot, ".agents", "plugins");
  const marketplacePluginsRoot = path.join(marketplaceRoot, "plugins");
  const pluginLink = path.join(
    marketplacePluginsRoot,
    CLAUDE_CODE_CODEX_PLUGIN_NAME
  );

  await fs.mkdir(agentsPluginRoot, { recursive: true });
  await fs.mkdir(marketplacePluginsRoot, { recursive: true });
  await fs.writeFile(
    path.join(agentsPluginRoot, "marketplace.json"),
    `${JSON.stringify(buildMarketplaceManifest(), null, 2)}\n`
  );

  await fs.rm(pluginLink, { recursive: true, force: true });
  await fs.symlink(
    resolvedPackageRoot,
    pluginLink,
    platform === "win32" ? "junction" : "dir"
  );

  return {
    marketplaceRoot,
    pluginPath: pluginLink,
    packageRoot: resolvedPackageRoot
  };
}

export async function installCodexPlugin({
  env = process.env,
  packageRoot = getPackageRoot(),
  runCommand = runCodexCommand,
  runSetup = runCompanionSetup,
  skipSetup = false
} = {}) {
  const marketplace = await writeLocalMarketplace({ env, packageRoot });
  const actions = [];

  const marketplaceList = runCommand(
    "codex",
    ["plugin", "marketplace", "list"],
    { env }
  );
  if (hasMarketplace(marketplaceList, CLAUDE_CODE_CODEX_MARKETPLACE_NAME)) {
    actions.push("Codex marketplace already registered.");
  } else {
    runCommand(
      "codex",
      ["plugin", "marketplace", "add", marketplace.marketplaceRoot],
      { env }
    );
    actions.push("Registered Codex marketplace.");
  }

  const pluginList = runCommand("codex", ["plugin", "list"], { env });
  const selector = `${CLAUDE_CODE_CODEX_PLUGIN_NAME}@${CLAUDE_CODE_CODEX_MARKETPLACE_NAME}`;
  if (hasInstalledPlugin(pluginList, selector)) {
    actions.push("Codex plugin already installed.");
  } else {
    runCommand("codex", ["plugin", "add", selector], { env });
    actions.push("Installed Codex plugin.");
  }

  const setupOutput = skipSetup
    ? ""
    : await runSetup({ env, packageRoot: marketplace.packageRoot });

  return renderInstallResult({
    actions,
    marketplace,
    setupOutput,
    skipSetup
  });
}

export function hasMarketplace(output, marketplaceName) {
  return new RegExp(`(^|\\n)${escapeRegExp(marketplaceName)}\\s+`).test(
    output || ""
  );
}

export function hasInstalledPlugin(output, selector) {
  return (output || "")
    .split(/\r?\n/)
    .some((line) =>
      new RegExp(`^${escapeRegExp(selector)}\\s+installed(?:\\b|,)`).test(
        line.trim()
      )
    );
}

function runCodexCommand(command, args, { env = process.env } = {}) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        "Codex CLI is not installed or not on PATH. Install it, then rerun `claude-code-codex install`."
      );
    }
    throw error;
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

async function assertPluginRoot(packageRoot) {
  const manifestPath = path.join(packageRoot, ".codex-plugin", "plugin.json");
  const skillsPath = path.join(packageRoot, "skills");
  try {
    await fs.access(manifestPath);
    await fs.access(skillsPath);
  } catch {
    throw new Error(
      `Package root is not a Codex plugin root: ${packageRoot}`
    );
  }
}

function renderInstallResult({ actions, marketplace, setupOutput, skipSetup }) {
  const lines = [
    "# Claude Code Codex Install",
    "",
    `Package root: ${marketplace.packageRoot}`,
    `Marketplace root: ${marketplace.marketplaceRoot}`,
    "",
    "## Actions",
    ...actions.map((action) => `- ${action}`)
  ];

  if (skipSetup) {
    lines.push("", "## Setup", "- Skipped by request.");
  } else {
    lines.push("", "## Setup", setupOutput.trimEnd());
  }

  return `${lines.join("\n")}\n`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
