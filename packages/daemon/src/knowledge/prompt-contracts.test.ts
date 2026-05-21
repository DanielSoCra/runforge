// packages/daemon/src/knowledge/prompt-contracts.test.ts
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PROMPT_CONTRACTS,
  assertContract,
  validatePromptContracts,
} from './prompt-contracts.js';

const PROMPTS_DIR = join(import.meta.dirname, '../../../../prompts');

describe('PROMPT_CONTRACTS registry', () => {
  it('registers compliance-reviewer with 6 vars and no defaults', () => {
    const c = PROMPT_CONTRACTS['compliance-reviewer'];
    expect(c).toBeDefined();
    expect(new Set(c!.variables)).toEqual(
      new Set(['issueNumber', 'issueTitle', 'issueBody', 'specContent', 'owner', 'repo']),
    );
    expect(c!.defaults ?? {}).toEqual({});
  });
  it('registers l2-designer and l3-generator with feedback default', () => {
    for (const name of ['l2-designer', 'l3-generator'] as const) {
      const c = PROMPT_CONTRACTS[name];
      expect(c).toBeDefined();
      expect(new Set(c!.variables)).toEqual(
        new Set(['issueNumber', 'issueTitle', 'issueBody', 'specContent', 'owner', 'repo', 'feedback']),
      );
      expect(c!.defaults).toEqual({ feedback: '' });
    }
  });
  it('registers worker with task/specs/verification/pitfalls and pitfalls default', () => {
    const c = PROMPT_CONTRACTS['worker'];
    expect(c).toBeDefined();
    expect(new Set(c!.variables)).toEqual(
      new Set(['task', 'specs', 'verification', 'pitfalls']),
    );
    expect(c!.defaults).toEqual({ pitfalls: '' });
  });
  it('registers bug-worker with bugReport/diagnosis/specs/pitfalls and pitfalls default', () => {
    const c = PROMPT_CONTRACTS['bug-worker'];
    expect(c).toBeDefined();
    expect(new Set(c!.variables)).toEqual(
      new Set(['bugReport', 'diagnosis', 'specs', 'pitfalls']),
    );
    expect(c!.defaults).toEqual({ pitfalls: '' });
  });
  it('every default key is also in variables', () => {
    for (const c of Object.values(PROMPT_CONTRACTS)) {
      for (const k of Object.keys(c.defaults ?? {})) {
        expect(c.variables).toContain(k);
      }
    }
  });
});

describe('template ↔ contract equality (loaded from disk)', () => {
  for (const [name, contract] of Object.entries(PROMPT_CONTRACTS)) {
    it(`prompts/${name}.md placeholders === contract.variables`, async () => {
      const tpl = await readFile(join(PROMPTS_DIR, `${name}.md`), 'utf-8');
      const placeholders = new Set<string>();
      for (const [, key] of tpl.matchAll(/\{\{([\w-]+)\}\}/g)) {
        if (key) placeholders.add(key);
      }
      expect(placeholders).toEqual(new Set(contract.variables));
    });
  }
});

describe('assertContract', () => {
  it('applies defaults for omitted keys', () => {
    const result = assertContract('l2-designer', {
      issueNumber: '1', issueTitle: 't', issueBody: 'b',
      specContent: 's', owner: 'o', repo: 'r',
    });
    expect(result['feedback']).toBe('');
  });
  it('throws on extras', () => {
    expect(() => assertContract('compliance-reviewer', {
      issueNumber: '1', issueTitle: 't', issueBody: 'b',
      specContent: 's', owner: 'o', repo: 'r',
      surprise: 'x',
    })).toThrow(/unknown variable.*surprise/);
  });
  it('throws on missing non-default key', () => {
    expect(() => assertContract('compliance-reviewer', {
      issueNumber: '1',
    } as Record<string, string>)).toThrow(/missing required variable/);
  });
  it('returns input unchanged when prompt is unregistered', () => {
    const vars = { anything: 'goes' };
    // 'classifier' is not in PROMPT_CONTRACTS; if it ever gets registered, swap
    // this for another unregistered prompt name.
    expect(assertContract('classifier', vars)).toEqual(vars);
  });
});

describe('validatePromptContracts', () => {
  it('returns ok({checked:5}) when registered prompts on disk match their contracts', async () => {
    const result = await validatePromptContracts(PROMPTS_DIR);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.checked).toBe(5);
  });
  it('returns err when a prompt template diverges from its contract', async () => {
    // Use a temp dir with a deliberately-wrong template
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const tmp = await mkdtemp(join(tmpdir(), 'contract-test-'));
    // Write minimal valid templates for the two with-defaults prompts so only one fails
    await writeFile(join(tmp, 'l2-designer.md'),
      '{{issueNumber}} {{repo}} {{owner}} {{issueTitle}} {{issueBody}} {{specContent}} {{feedback}}', 'utf-8');
    await writeFile(join(tmp, 'l3-generator.md'),
      '{{issueNumber}} {{repo}} {{owner}} {{issueTitle}} {{issueBody}} {{specContent}} {{feedback}}', 'utf-8');
    // compliance-reviewer template missing issueTitle
    await writeFile(join(tmp, 'compliance-reviewer.md'),
      '{{issueNumber}} {{repo}} {{owner}} {{issueBody}} {{specContent}}', 'utf-8');

    const result = await validatePromptContracts(tmp);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/compliance-reviewer.*issueTitle/);
  });
});
