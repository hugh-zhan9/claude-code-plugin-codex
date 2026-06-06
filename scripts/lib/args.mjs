const VALID_COMMANDS = new Set([
  "setup",
  "task",
  "review",
  "adversarial-review",
  "status",
  "result",
  "cancel",
  "task-worker"
]);

const SHARED_OPTIONS = new Map([
  ["--cwd", { name: "cwd", takesValue: true }],
  ["--json", { name: "json", takesValue: false }],
  ["--model", { name: "model", takesValue: true }],
  ["--effort", { name: "effort", takesValue: true }]
]);

const TASK_OPTIONS = new Map([
  ["--background", { name: "background", takesValue: false }],
  ["--write", { name: "write", takesValue: false }],
  ["--read-only", { name: "readOnly", takesValue: false }],
  ["--resume-last", { name: "resumeLast", takesValue: false }],
  ["--fresh", { name: "fresh", takesValue: false }],
  [
    "--dangerously-bypass-permissions",
    { name: "dangerouslyBypassPermissions", takesValue: false }
  ]
]);

const REVIEW_OPTIONS = new Map([
  ["--base", { name: "base", takesValue: true }],
  ["--scope", { name: "scope", takesValue: true }]
]);

const STATUS_OPTIONS = new Map([
  ["--all", { name: "all", takesValue: false }],
  ["--wait", { name: "wait", takesValue: false }]
]);

const COMMAND_OPTIONS = new Map([
  ["task", TASK_OPTIONS],
  ["review", REVIEW_OPTIONS],
  ["adversarial-review", REVIEW_OPTIONS],
  ["status", STATUS_OPTIONS]
]);

const JOB_REF_COMMANDS = new Set(["status", "result", "cancel", "task-worker"]);

export function parseCompanionArgs(argv) {
  const tokens = Array.from(argv);
  const command = tokens.shift() ?? "setup";

  if (!VALID_COMMANDS.has(command)) {
    throw new Error(`Unknown command: ${command}`);
  }

  const parsed = { command, options: {} };
  const positional = [];
  const promptParts = [];
  let parsingOptions = true;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (parsingOptions && token === "--") {
      parsingOptions = false;
      const remaining = tokens.slice(index + 1);

      if (JOB_REF_COMMANDS.has(command) && remaining.length > 0) {
        throw new Error(`Unexpected argument: ${remaining[0]}`);
      }

      promptParts.push(...remaining);
      break;
    }

    if (parsingOptions && token.startsWith("--")) {
      const option = optionFor(command, token);

      if (!option) {
        throw new Error(`Unknown option: ${token}`);
      }

      if (option.takesValue) {
        const value = tokens[index + 1];

        if (value === undefined || value === "--" || value.startsWith("--")) {
          throw new Error(`Missing value for ${token}`);
        }

        parsed.options[option.name] = value;
        index += 1;
      } else {
        parsed.options[option.name] = parseBooleanFlag(
          parsed.options,
          option.name,
          true
        );
      }

      continue;
    }

    if (JOB_REF_COMMANDS.has(command)) {
      if (positional.length > 0) {
        throw new Error(`Unexpected argument: ${token}`);
      }

      positional.push(token);
      continue;
    }

    promptParts.push(token);
  }

  if (positional.length > 0) {
    parsed.jobRef = positional[0];
  }

  if (promptParts.length > 0) {
    parsed.prompt = promptParts.join(" ");
  }

  return parsed;
}

export function parseBooleanFlag(options, flagName, defaultValue = false) {
  if (Object.hasOwn(options, flagName)) {
    return Boolean(options[flagName]);
  }

  return defaultValue;
}

function optionFor(command, flag) {
  return SHARED_OPTIONS.get(flag) ?? COMMAND_OPTIONS.get(command)?.get(flag);
}
