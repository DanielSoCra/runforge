// src/knowledge/templates.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadTemplate, renderTemplate } from './templates.js';

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
});
