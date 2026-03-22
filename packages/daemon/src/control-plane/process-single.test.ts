import { describe, it, expect } from 'vitest';
import { processSingleIssue } from './process-single.js';

describe('processSingleIssue', () => {
  it('returns error when GITHUB_TOKEN is not set', async () => {
    const originalToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const result = await processSingleIssue(999, 'config.json');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('GITHUB_TOKEN');
      }
    } finally {
      process.env.GITHUB_TOKEN = originalToken;
    }
  });

  it('returns error for missing config', async () => {
    const result = await processSingleIssue(999, '/nonexistent/config.json');
    expect(result.ok).toBe(false);
  });
});
