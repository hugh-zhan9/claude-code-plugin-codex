import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

export function commandExists(command) {
  return findOnPath(command) !== null;
}

export function runCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    ...options
  });
}

export function spawnDetached(command, args, options = {}) {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    ...options
  });

  child.on("error", () => {});
  child.unref();
  return child;
}

export function findOnPath(command, env = process.env, platform = process.platform) {
  if (command.includes(path.sep)) {
    return isExecutable(command) ? command : null;
  }

  const searchPath = env.PATH ?? "";

  for (const dirPath of searchPath.split(path.delimiter)) {
    if (dirPath === "") {
      continue;
    }

    for (const candidate of commandCandidates(dirPath, command, env, platform)) {
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function commandCandidates(dirPath, command, env, platform) {
  const candidate = path.join(dirPath, command);

  if (platform !== "win32" || path.extname(command) !== "") {
    return [candidate];
  }

  const pathExt = env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM";
  return [
    candidate,
    ...pathExt
      .split(";")
      .filter(Boolean)
      .map((extension) => `${candidate}${extension}`)
  ];
}

function isExecutable(filePath) {
  try {
    const stats = fs.statSync(filePath);
    fs.accessSync(filePath, fs.constants.X_OK);
    return stats.isFile();
  } catch {
    return false;
  }
}
