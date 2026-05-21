// src/knowledge/templates.ts
import { readFile } from 'fs/promises';
import { ok, err, type Result } from '../lib/result.js';

export async function loadTemplate(path: string): Promise<Result<string>> {
  try {
    const content = await readFile(path, 'utf-8');
    return ok(content);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

/** Pattern matching `{{variableName}}` placeholders in templates. */
const PLACEHOLDER_RE = /\{\{([\w-]+)\}\}/g;

export interface RenderOptions {
  /** Throws if any template placeholder has no matching variable. */
  strict?: boolean;
  /** Throws if any caller-passed variable has no matching placeholder. */
  rejectUnused?: boolean;
}

/**
 * Returns the names of template placeholders that have no matching key in `variables`.
 */
export function findUnsubstitutedVars(
  template: string,
  variables: Record<string, string>,
): string[] {
  const missing: string[] = [];
  for (const [, key] of template.matchAll(PLACEHOLDER_RE)) {
    if (key && !Object.prototype.hasOwnProperty.call(variables, key) && !missing.includes(key)) {
      missing.push(key);
    }
  }
  return missing;
}

export function findUnusedVariables(
  template: string,
  variables: Record<string, string>,
): string[] {
  const placeholders = new Set<string>();
  for (const [, key] of template.matchAll(PLACEHOLDER_RE)) {
    if (key) placeholders.add(key);
  }
  return Object.keys(variables).filter((k) => !placeholders.has(k));
}

export function renderTemplate(
  template: string,
  variables: Record<string, string>,
  options?: RenderOptions,
): string {
  if (options?.strict) {
    const missing = findUnsubstitutedVars(template, variables);
    if (missing.length > 0) {
      throw new Error(
        `renderTemplate: missing variables: ${missing.join(', ')}. ` +
        `Template expects these placeholders but no values were provided.`,
      );
    }
  }
  if (options?.rejectUnused) {
    const unused = findUnusedVariables(template, variables);
    if (unused.length > 0) {
      throw new Error(
        `renderTemplate: unused variables (silent drop risk): ${unused.join(', ')}. ` +
        `These keys were passed by the caller but the template references no matching placeholder.`,
      );
    }
  }
  return template.replace(PLACEHOLDER_RE, (_match, key: string) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? (variables[key] ?? _match) : _match;
  });
}
