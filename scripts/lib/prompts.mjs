import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function loadPromptTemplate(name) {
  return fs.readFileSync(path.join(repoRoot, "prompts", `${name}.md`), "utf8");
}

export function renderTemplate(template, values) {
  return template.replaceAll(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key) =>
    stringifyTemplateValue(values[key] ?? "")
  );
}

export function buildFallbackReviewPrompt(context) {
  return renderTemplate(loadPromptTemplate("review-fallback"), {
    ...templateValuesFromContext(context)
  }).trim();
}

export function buildAdversarialReviewPrompt(context, { focus = "" } = {}) {
  return renderTemplate(loadPromptTemplate("adversarial-review"), {
    ...templateValuesFromContext(context),
    focus
  }).trim();
}

export function buildTaskPrompt(prompt) {
  return String(prompt ?? "").trim();
}

function templateValuesFromContext(context) {
  return {
    workspace_root: context.workspaceRoot ?? "",
    target:
      context.target?.description ?? context.target?.label ?? context.target?.kind ?? "",
    files: context.files ?? [],
    inline: String(Boolean(context.inline)),
    diff: context.diff ?? ""
  };
}

function stringifyTemplateValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => `- ${String(item)}`).join("\n");
  }

  return String(value);
}
