import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  CLAUDE_CODE_CODEX_MARKETPLACE_NAME,
  CLAUDE_CODE_CODEX_PLUGIN_NAME,
  buildMarketplaceManifest,
  getMarketplaceRoot,
  hasInstalledPlugin,
  installCodexPlugin,
  writeLocalMarketplace
} from "../scripts/lib/install.mjs";
import { assertFile, makeTempDir, readJson, readText } from "./helpers.mjs";

function makePackageRoot() {
  const root = makeTempDir("claude-code-codex-package-");
  fs.mkdirSync(path.join(root, ".codex-plugin"), { recursive: true });
  fs.mkdirSync(path.join(root, "skills", "claude-code-setup"), {
    recursive: true
  });
  fs.writeFileSync(
    path.join(root, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: CLAUDE_CODE_CODEX_PLUGIN_NAME }, null, 2)
  );
  fs.writeFileSync(
    path.join(root, "skills", "claude-code-setup", "SKILL.md"),
    "---\nname: claude-code-setup\n---\n"
  );
  return root;
}

test("package exposes an npm distribution command and publishes plugin files", () => {
  const pkg = readJson("package.json");

  assert.equal(pkg.name, "claude-code-codex");
  assert.equal(pkg.private, undefined);
  assert.deepEqual(pkg.bin, {
    "claude-code-codex": "scripts/cli.mjs"
  });
  assert.equal(pkg.publishConfig.access, "public");
  assert.match(pkg.files.join("\n"), /^\.codex-plugin\/$/m);
  assert.match(pkg.files.join("\n"), /^skills\/$/m);
  assert.match(pkg.files.join("\n"), /^scripts\/$/m);
});

test("buildMarketplaceManifest declares a local Codex marketplace entry", () => {
  const manifest = buildMarketplaceManifest();

  assert.equal(manifest.name, CLAUDE_CODE_CODEX_MARKETPLACE_NAME);
  assert.equal(manifest.plugins.length, 1);
  assert.equal(manifest.plugins[0].name, CLAUDE_CODE_CODEX_PLUGIN_NAME);
  assert.deepEqual(manifest.plugins[0].source, {
    source: "local",
    path: "./plugins/claude-code"
  });
  assert.equal(manifest.plugins[0].policy.installation, "AVAILABLE");
});

test("writeLocalMarketplace creates a marketplace pointing at the package root", async () => {
  const home = makeTempDir("claude-code-codex-home-");
  const packageRoot = makePackageRoot();

  const result = await writeLocalMarketplace({
    env: { HOME: home },
    packageRoot
  });

  const marketplaceRoot = getMarketplaceRoot({ env: { HOME: home } });
  const manifestPath = path.join(
    marketplaceRoot,
    ".agents",
    "plugins",
    "marketplace.json"
  );
  const pluginPath = path.join(marketplaceRoot, "plugins", "claude-code");

  assert.equal(result.marketplaceRoot, marketplaceRoot);
  assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, "utf8")), {
    ...buildMarketplaceManifest()
  });
  assert.equal(fs.existsSync(path.join(pluginPath, ".codex-plugin", "plugin.json")), true);
  assert.equal(fs.realpathSync(pluginPath), fs.realpathSync(packageRoot));
});

test("installCodexPlugin registers a missing marketplace and plugin", async () => {
  const home = makeTempDir("claude-code-codex-home-");
  const packageRoot = makePackageRoot();
  const calls = [];

  const output = await installCodexPlugin({
    env: { HOME: home },
    packageRoot,
    runCommand(command, args) {
      calls.push([command, args]);
      if (args.join(" ") === "plugin marketplace list") {
        return "MARKETPLACE ROOT\n";
      }
      if (args.join(" ") === "plugin list") {
        return "";
      }
      return "";
    },
    runSetup() {
      return "# Claude Code Plugin Setup\n\nsetup ok\n";
    }
  });

  assert.deepEqual(calls, [
    ["codex", ["plugin", "marketplace", "list"]],
    [
      "codex",
      ["plugin", "marketplace", "add", getMarketplaceRoot({ env: { HOME: home } })]
    ],
    ["codex", ["plugin", "list"]],
    ["codex", ["plugin", "add", "claude-code@claude-code-codex"]]
  ]);
  assert.match(output, /Registered Codex marketplace/);
  assert.match(output, /Installed Codex plugin/);
  assert.match(output, /# Claude Code Plugin Setup/);
});

test("installCodexPlugin skips Codex commands for already-installed entries", async () => {
  const home = makeTempDir("claude-code-codex-home-");
  const packageRoot = makePackageRoot();
  const calls = [];

  const output = await installCodexPlugin({
    env: { HOME: home },
    packageRoot,
    runCommand(command, args) {
      calls.push([command, args]);
      if (args.join(" ") === "plugin marketplace list") {
        return `MARKETPLACE ROOT\n${CLAUDE_CODE_CODEX_MARKETPLACE_NAME} ${getMarketplaceRoot({
          env: { HOME: home }
        })}\n`;
      }
      if (args.join(" ") === "plugin list") {
        return "claude-code@claude-code-codex installed, enabled 0.1.0 /tmp/plugin\n";
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    },
    runSetup() {
      return "setup ok\n";
    }
  });

  assert.deepEqual(calls, [
    ["codex", ["plugin", "marketplace", "list"]],
    ["codex", ["plugin", "list"]]
  ]);
  assert.match(output, /Codex marketplace already registered/);
  assert.match(output, /Codex plugin already installed/);
});

test("hasInstalledPlugin rejects not-installed plugin list rows", () => {
  assert.equal(
    hasInstalledPlugin(
      "claude-code@claude-code-codex  not installed  /tmp/plugin\n",
      "claude-code@claude-code-codex"
    ),
    false
  );
  assert.equal(
    hasInstalledPlugin(
      "claude-code@claude-code-codex  installed, enabled  0.1.0  /tmp/plugin\n",
      "claude-code@claude-code-codex"
    ),
    true
  );
});

test("GitHub Actions publish workflow packages and publishes to npm", () => {
  assertFile(".github/workflows/publish.yml");
  const workflow = readText(".github/workflows/publish.yml");

  assert.match(workflow, /name: Publish to npm/);
  assert.match(workflow, /branches:\s*\n\s*- main/);
  assert.match(workflow, /branches:[\s\S]*\n\s*- master/);
  assert.match(workflow, /uses: actions\/checkout@v6/);
  assert.match(workflow, /uses: actions\/setup-node@v6/);
  assert.match(workflow, /registry-url: https:\/\/registry\.npmjs\.org/);
  assert.match(workflow, /run: npm install/);
  assert.match(workflow, /run: npm test/);
  assert.match(workflow, /npm view "\$PACKAGE_NAME@\$PACKAGE_VERSION" version/);
  assert.match(workflow, /run: npm publish --access public/);
  assert.match(workflow, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
});
