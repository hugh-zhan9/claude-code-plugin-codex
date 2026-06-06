import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { getBrokerEndpoint, getBrokerSessionFile } from "../scripts/lib/broker-endpoint.mjs";
import { makeTempDir } from "./helpers.mjs";

test("getBrokerEndpoint returns a Unix socket path on POSIX", () => {
  const stateDir = makeTempDir("broker-state-");
  const endpoint = getBrokerEndpoint({ stateDir, platform: "darwin" });

  assert.equal(endpoint.startsWith(stateDir), true);
  assert.match(path.basename(endpoint), /^broker-[a-f0-9]+\.sock$/);
});

test("getBrokerEndpoint keeps long POSIX socket paths bindable", () => {
  const stateDir = path.join(makeTempDir("broker-state-"), "x".repeat(120));
  const endpoint = getBrokerEndpoint({ stateDir, platform: "darwin" });

  assert.equal(endpoint.length <= 100, true);
  assert.match(
    path.basename(endpoint),
    /^claude-code-plugin-codex-[a-f0-9]{24}\.sock$/
  );
});

test("getBrokerEndpoint returns a Windows named pipe path on win32", () => {
  const endpoint = getBrokerEndpoint({ stateDir: "C:\\temp\\state", platform: "win32" });

  assert.match(endpoint, /^\\\\\.\\pipe\\claude-code-plugin-codex-/);
});

test("getBrokerSessionFile is stored in the workspace state directory", () => {
  const stateDir = makeTempDir("broker-state-");
  assert.equal(getBrokerSessionFile(stateDir), path.join(stateDir, "broker.json"));
});
