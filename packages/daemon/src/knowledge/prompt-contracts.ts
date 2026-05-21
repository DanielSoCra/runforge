// packages/daemon/src/knowledge/prompt-contracts.ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ok, err, type Result } from '../lib/result.js';

export interface PromptContract {
  /** All variables callers may pass; must equal the set of placeholders in the template. */
  variables: readonly string[];
  /** Variables callers may omit; the renderer fills these defaults. Keys must be ⊆ variables. */
  defaults?: Readonly<Record<string, string>>;
}

export const PROMPT_CONTRACTS: Readonly<Record<string, PromptContract>> = {
  'l2-designer': {
    variables: ['issueNumber', 'issueTitle', 'issueBody', 'specContent', 'owner', 'repo', 'feedback'],
    defaults: { feedback: '' },
  },
  'l3-generator': {
    variables: ['issueNumber', 'issueTitle', 'issueBody', 'specContent', 'owner', 'repo', 'feedback'],
    defaults: { feedback: '' },
  },
  'compliance-reviewer': {
    variables: ['issueNumber', 'issueTitle', 'issueBody', 'specContent', 'owner', 'repo'],
  },
  'worker': {
    variables: ['task', 'specs', 'verification', 'pitfalls'],
    defaults: { pitfalls: '' },
  },
  'bug-worker': {
    variables: ['bugReport', 'diagnosis', 'specs', 'pitfalls'],
    defaults: { pitfalls: '' },
  },
};

const PLACEHOLDER_RE = /\{\{([\w-]+)\}\}/g;

/**
 * Apply contract defaults to caller-passed variables and validate the final
 * set exactly equals the contract.variables (no extras, no missing-non-default).
 *
 * Returns the merged variables on success. Throws on contract violation —
 * callers choose throw vs warn by deciding whether to call this in test or
 * production.
 *
 * If `name` is not in PROMPT_CONTRACTS, the caller's variables are returned
 * unchanged (opt-in registry — unregistered prompts retain legacy behavior).
 */
export function assertContract(
  name: string,
  variables: Record<string, string>,
): Record<string, string> {
  const contract = PROMPT_CONTRACTS[name];
  if (!contract) return variables;

  const merged: Record<string, string> = { ...(contract.defaults ?? {}), ...variables };
  const expected = new Set(contract.variables);
  const actual = new Set(Object.keys(merged));

  for (const key of actual) {
    if (!expected.has(key)) {
      throw new Error(
        `assertContract(${name}): unknown variable "${key}". ` +
        `Contract allows: ${[...expected].join(', ')}.`,
      );
    }
  }
  for (const key of expected) {
    if (!actual.has(key)) {
      throw new Error(
        `assertContract(${name}): missing required variable "${key}". ` +
        `Contract requires: ${[...expected].join(', ')}.`,
      );
    }
  }
  return merged;
}

/**
 * Verify every registered prompt's on-disk template references exactly the
 * variables declared in its contract. Called at daemon startup.
 *
 * Returns err with a list of mismatched prompts; callers refuse to start.
 */
export async function validatePromptContracts(
  promptsDir: string,
): Promise<Result<{ checked: number }>> {
  const errors: string[] = [];
  let checked = 0;
  for (const [name, contract] of Object.entries(PROMPT_CONTRACTS)) {
    const path = join(promptsDir, `${name}.md`);
    let tpl: string;
    try {
      tpl = await readFile(path, 'utf-8');
    } catch (e) {
      errors.push(`${name}: cannot read ${path}: ${(e as Error).message}`);
      continue;
    }
    const placeholders = new Set<string>();
    for (const [, key] of tpl.matchAll(PLACEHOLDER_RE)) {
      if (key) placeholders.add(key);
    }
    const expected = new Set(contract.variables);
    const extra = [...placeholders].filter((k) => !expected.has(k));
    const missing = [...expected].filter((k) => !placeholders.has(k));
    if (extra.length || missing.length) {
      errors.push(
        `${name}: template/contract mismatch — ` +
        (extra.length ? `template has unexpected: [${extra.join(', ')}]; ` : '') +
        (missing.length ? `template missing: [${missing.join(', ')}]` : ''),
      );
    }
    checked += 1;
  }
  if (errors.length) {
    return err(new Error(`validatePromptContracts failed:\n  ${errors.join('\n  ')}`));
  }
  return ok({ checked });
}
