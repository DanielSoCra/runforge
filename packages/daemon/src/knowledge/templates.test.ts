// src/knowledge/templates.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadTemplate, renderTemplate, findUnsubstitutedVars, findUnusedVariables } from './templates.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'templates-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadTemplate', () => {
  it('returns ok with file content when file exists', async () => {
    const filePath = join(dir, 'tmpl.txt');
    await writeFile(filePath, 'Hello {{name}}!');
    const result = await loadTemplate(filePath);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('Hello {{name}}!');
  });

  it('returns err when file does not exist', async () => {
    const result = await loadTemplate(join(dir, 'nonexistent.txt'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(Error);
  });
});

describe('renderTemplate', () => {
  it('replaces a single variable placeholder', () => {
    const result = renderTemplate('Hello {{name}}!', { name: 'World' });
    expect(result).toBe('Hello World!');
  });

  it('replaces multiple different variables', () => {
    const result = renderTemplate('{{greeting}}, {{name}}!', {
      greeting: 'Hi',
      name: 'Alice',
    });
    expect(result).toBe('Hi, Alice!');
  });

  it('replaces multiple occurrences of the same variable', () => {
    const result = renderTemplate('{{x}} + {{x}} = two {{x}}s', { x: 'foo' });
    expect(result).toBe('foo + foo = two foos');
  });

  it('leaves unknown placeholders intact', () => {
    const result = renderTemplate('Hello {{unknown}}!', { name: 'World' });
    expect(result).toBe('Hello {{unknown}}!');
  });

  it('handles empty variables map', () => {
    const result = renderTemplate('Hello {{name}}!', {});
    expect(result).toBe('Hello {{name}}!');
  });

  it('does not perform recursive replacement', () => {
    // If value contains a placeholder, it should NOT be expanded
    const result = renderTemplate('{{a}}', { a: '{{b}}', b: 'expanded' });
    expect(result).toBe('{{b}}');
  });

  it('handles empty template string', () => {
    const result = renderTemplate('', { name: 'World' });
    expect(result).toBe('');
  });

  it('handles template with no placeholders', () => {
    const result = renderTemplate('plain text', { name: 'World' });
    expect(result).toBe('plain text');
  });

  it('throws in strict mode when variables are missing (#372)', () => {
    expect(() =>
      renderTemplate('Hello {{name}}, your {{role}} is ready.', {}, { strict: true }),
    ).toThrow('missing variables: name, role');
  });

  it('does not throw in strict mode when all variables are provided', () => {
    const result = renderTemplate(
      'Hello {{name}}, your {{role}} is ready.',
      { name: 'Alice', role: 'admin' },
      { strict: true },
    );
    expect(result).toBe('Hello Alice, your admin is ready.');
  });

  it('strict mode ignores extra variables', () => {
    const result = renderTemplate('Hi {{name}}!', { name: 'Bob', extra: 'ignored' }, { strict: true });
    expect(result).toBe('Hi Bob!');
  });
});

describe('findUnsubstitutedVars', () => {
  it('returns missing variable names (#372)', () => {
    const missing = findUnsubstitutedVars('{{a}} and {{b}} and {{c}}', { a: 'x' });
    expect(missing).toEqual(['b', 'c']);
  });

  it('returns empty array when all variables are provided', () => {
    const missing = findUnsubstitutedVars('{{a}} {{b}}', { a: 'x', b: 'y' });
    expect(missing).toEqual([]);
  });

  it('deduplicates repeated placeholders', () => {
    const missing = findUnsubstitutedVars('{{x}} {{x}} {{x}}', {});
    expect(missing).toEqual(['x']);
  });

  it('returns empty array for templates with no placeholders', () => {
    const missing = findUnsubstitutedVars('plain text', {});
    expect(missing).toEqual([]);
  });

  it('detects empty variables map as the daemon.ts:148 scenario (#372)', () => {
    // Simulates the concrete bug: product-owner template expects {{signal_snapshot}}
    // but daemon.ts passed { variables: {} }
    const template = 'Analyze signals:\n{{signal_snapshot}}\n\nPrioritize {{focus_area}}.';
    const missing = findUnsubstitutedVars(template, {});
    expect(missing).toEqual(['signal_snapshot', 'focus_area']);
  });
});

describe('findUnusedVariables', () => {
  it('returns variables not referenced in template', () => {
    const tpl = 'Hello {{name}}';
    expect(findUnusedVariables(tpl, { name: 'x', surprise: 'y' })).toEqual(['surprise']);
  });
  it('returns empty when all variables are used', () => {
    expect(findUnusedVariables('{{a}} {{b}}', { a: '1', b: '2' })).toEqual([]);
  });
  it('treats no-placeholder template as all-unused', () => {
    expect(findUnusedVariables('static text', { a: '1' })).toEqual(['a']);
  });
});

describe('renderTemplate rejectUnused option', () => {
  it('throws when caller passes a variable not in template', () => {
    expect(() => renderTemplate('Hello {{name}}', { name: 'x', extra: 'y' }, { rejectUnused: true }))
      .toThrow(/unused variables.*extra/);
  });
  it('does not throw when all variables are used', () => {
    expect(() => renderTemplate('Hello {{name}}', { name: 'x' }, { rejectUnused: true }))
      .not.toThrow();
  });
  it('does not throw on missing placeholder unless strict is also set', () => {
    expect(() => renderTemplate('{{a}} {{b}}', { a: '1' }, { rejectUnused: true }))
      .not.toThrow();
  });
  it('strict and rejectUnused are independent', () => {
    expect(() => renderTemplate('{{a}}', { b: '2' }, { strict: true, rejectUnused: true }))
      .toThrow();
  });
  it('rejectUnused fires even when strict is satisfied (Codex review d5f7a78)', () => {
    expect(() => renderTemplate('{{a}}', { a: '1', b: '2' }, { strict: true, rejectUnused: true }))
      .toThrow(/unused variables.*b/);
  });
});
