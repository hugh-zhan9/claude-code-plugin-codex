import fs from "node:fs";
import path from "node:path";

export function resolveWorkspaceRoot({ cwd = process.cwd() } = {}) {
  const workspaceRoot = fs.realpathSync(path.resolve(cwd));
  const stats = fs.statSync(workspaceRoot);

  if (!stats.isDirectory()) {
    throw new Error(`Workspace root is not a directory: ${workspaceRoot}`);
  }

  return workspaceRoot;
}

export function workspaceDisplayName(workspaceRoot) {
  return path.basename(workspaceRoot) || "workspace";
}
