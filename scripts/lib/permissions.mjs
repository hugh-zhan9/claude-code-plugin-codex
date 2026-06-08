export function taskPermission(options = {}) {
  if (options.readOnly) {
    return "read-only";
  }

  return "workspace-write";
}
