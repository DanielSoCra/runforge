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

export function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? (variables[key] ?? _match) : _match;
  });
}
