import fs from "node:fs";
import path from "node:path";

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function readJsonFile(filePath, fallbackValue = null) {
  if (!fs.existsSync(filePath)) {
    return fallbackValue;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error.message}`, {
      cause: error
    });
  }
}

export function atomicWriteJson(filePath, value) {
  const dirPath = path.dirname(filePath);
  ensureDir(dirPath);

  const tempPath = path.join(
    dirPath,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );

  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

export function appendLog(filePath, line) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${new Date().toISOString()} ${line}\n`, "utf8");
}

export function readTextFile(filePath, fallbackValue = "") {
  if (!fs.existsSync(filePath)) {
    return fallbackValue;
  }

  return fs.readFileSync(filePath, "utf8");
}
